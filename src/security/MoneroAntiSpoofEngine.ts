/**
 * src/security/MoneroAntiSpoofEngine.ts
 * Orchestrator combining all 5 Monero cryptographic verification layers into a unified pipeline.
 */

import { IInvoice, IZeroPayConfig } from '../types';
import { HttpClient } from '../utils/http';
import { MoneroKeyValidator } from './MoneroKeyValidator';
import {
  MoneroTimelockValidator,
  IMoneroTransactionExecutionState,
} from './MoneroTimelockValidator';
import { StealthOutputVerifier } from './StealthOutputVerifier';
import { RingCtVerifier } from './RingCtVerifier';
import { MoneroFinalityValidator } from './MoneroFinalityValidator';

export interface IRawMoneroTransactionData {
  transactionId: string;
  txPublicKeyHex: string;
  outputIndex: number;
  outputStealthKeyHex: string;
  encryptedAmountHex: string;
  commitmentHex?: string;
  executionState: IMoneroTransactionExecutionState;
  blockHeight?: number;
  inPool?: boolean;
}

export interface IMoneroValidationResult {
  isValid: boolean;
  failureReason?: string;
  layerFailed?: number;
  decryptedAmountPiconero?: bigint;
  confirmations?: number;
}

export class MoneroAntiSpoofEngine {
  private config: IZeroPayConfig;
  private finalityValidator: MoneroFinalityValidator;

  constructor(config: IZeroPayConfig, httpClient?: HttpClient) {
    this.config = config;
    const rpcUrl = config.moneroRpcUrl || 'https://xmr-node.cakewallet.com:18081';
    this.finalityValidator = new MoneroFinalityValidator(rpcUrl, httpClient);
  }

  /**
   * Executes the strict 5-layer sequential cryptographic verification pipeline for Monero.
   *
   * @param txData Raw cryptographic parameters and state of the candidate Monero transaction output
   * @param invoice The target Monero invoice expecting payment
   * @param requiredConfirmations Minimum confirmations required for Layer 5 finality
   */
  public async verify(
    txData: IRawMoneroTransactionData,
    invoice: IInvoice,
    requiredConfirmations: number = 1,
  ): Promise<IMoneroValidationResult> {
    if (!this.config.moneroPrivateViewKey) {
      return {
        isValid: false,
        failureReason: 'Monero private view key is missing from configuration.',
      };
    }

    // LAYER 1: Ed25519 Curve Point & Torsion Subgroup Validation
    const isKeyValid = MoneroKeyValidator.validateTransactionKeys(
      txData.txPublicKeyHex,
      txData.outputStealthKeyHex,
      txData.commitmentHex,
    );
    if (!isKeyValid) {
      return {
        isValid: false,
        failureReason:
          'Layer 1 Violation: Transaction public key or stealth output key is invalid or lies in a small-order torsion subgroup.',
        layerFailed: 1,
      };
    }

    // Retrieve chain height if needed for non-zero block timelocks or confirmation checks
    let currentChainHeight: number | undefined;
    if (
      txData.executionState.unlockTime > 0 &&
      txData.executionState.unlockTime < MoneroTimelockValidator.BLOCK_HEIGHT_THRESHOLD
    ) {
      try {
        currentChainHeight = await this.finalityValidator.getCurrentChainHeight();
      } catch {
        currentChainHeight = undefined;
      }
    }

    // LAYER 2: Execution Flags, Double-Spend Check & Timelock Validation
    const isTimelockSafe = MoneroTimelockValidator.isExecutionAndTimelockSafe(
      txData.executionState,
      currentChainHeight,
    );
    if (!isTimelockSafe) {
      return {
        isValid: false,
        failureReason:
          'Layer 2 Violation: Transaction flagged as double-spend/failed or contains a malicious unlock_time lock.',
        layerFailed: 2,
      };
    }

    // LAYER 3: ECDH Stealth Output Ownership Proof
    const ownershipResult = StealthOutputVerifier.verifyOutputOwnership(
      txData.txPublicKeyHex,
      txData.outputStealthKeyHex,
      txData.outputIndex,
      this.config.moneroPrivateViewKey,
      invoice.receivingAddress,
    );
    if (!ownershipResult.isOwned || !ownershipResult.outputScalarHex) {
      return {
        isValid: false,
        failureReason:
          'Layer 3 Violation: ECDH stealth output derivation does not match the invoice subaddress.',
        layerFailed: 3,
      };
    }

    // LAYER 4: RingCT ECDH Amount Decryption & Pedersen Commitment Verification
    const ringCtResult = RingCtVerifier.verifyRingCtPayment(
      txData.encryptedAmountHex,
      ownershipResult.outputScalarHex,
      invoice.amount,
      txData.commitmentHex,
    );
    if (!ringCtResult.isValid) {
      return {
        isValid: false,
        failureReason:
          'Layer 4 Violation: Decrypted RingCT Piconero amount is insufficient or Pedersen Commitment verification failed.',
        layerFailed: 4,
        decryptedAmountPiconero: ringCtResult.decryptedAmountPiconero,
      };
    }

    // LAYER 5: Block Maturity & Confirmation Finality
    let confirmations = 0;
    if (requiredConfirmations > 0) {
      if (txData.inPool === true || !txData.blockHeight || txData.blockHeight <= 0) {
        return {
          isValid: false,
          failureReason:
            'Layer 5 Violation: Transaction is still in mempool and has not reached required block confirmations.',
          layerFailed: 5,
          decryptedAmountPiconero: ringCtResult.decryptedAmountPiconero,
          confirmations: 0,
        };
      }

      const isFinalized = await this.finalityValidator.isTransactionFinalized(
        txData.blockHeight,
        requiredConfirmations,
      );
      if (!isFinalized) {
        return {
          isValid: false,
          failureReason:
            'Layer 5 Violation: Transaction block height has not yet reached the required confirmation depth.',
          layerFailed: 5,
          decryptedAmountPiconero: ringCtResult.decryptedAmountPiconero,
        };
      }

      try {
        confirmations = await this.finalityValidator.calculateConfirmations(
          txData.blockHeight,
          false,
        );
      } catch {
        confirmations = requiredConfirmations;
      }
    }

    return {
      isValid: true,
      decryptedAmountPiconero: ringCtResult.decryptedAmountPiconero,
      confirmations,
    };
  }
}