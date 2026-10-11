/**
 * src/security/AntiCounterfeitEngine.ts
 * Orchestrator combining all 5 verification layers into a unified anti-counterfeit pipeline.
 */

import { IInvoice, IZeroPayConfig } from '../types';
import { HttpClient } from '../utils/http';
import { ContractWhitelist } from './ContractWhitelist';
import { TvmReceiptValidator, ITronTransactionPayload } from './TvmReceiptValidator';
import { AbiDecoder } from './AbiDecoder';
import { StateQueryValidator } from './StateQueryValidator';
import { ConsensusFinalityValidator } from './ConsensusFinalityValidator';

export interface IRawTronTransactionData {
  transactionId: string;
  contractAddress: string;
  rawDataHex: string;
  executionPayload: ITronTransactionPayload;
  blockNumber: number;
}

export interface IValidationResult {
  isValid: boolean;
  failureReason?: string;
  layerFailed?: number;
}

export class AntiCounterfeitEngine {
  private stateValidator: StateQueryValidator;
  private consensusValidator: ConsensusFinalityValidator;

  constructor(config: IZeroPayConfig, httpClient?: HttpClient) {
    const rpcUrl = config.tronRpcUrl || 'https://api.trongrid.io';
    this.stateValidator = new StateQueryValidator(rpcUrl, httpClient);
    this.consensusValidator = new ConsensusFinalityValidator(rpcUrl, httpClient);
  }

  /**
   * Executes the strict 5-layer sequential verification pipeline.
   * 
   * @param txData The incoming transaction raw data and execution receipts
   * @param invoice The target invoice expecting payment
   * @returns Comprehensive validation outcome
   */
  public async verify(
    txData: IRawTronTransactionData,
    invoice: IInvoice
  ): Promise<IValidationResult> {
    // LAYER 1: Immutable Contract Whitelist Check
    if (!ContractWhitelist.isOfficialUsdt(txData.contractAddress)) {
      return {
        isValid: false,
        failureReason: 'Layer 1 Violation: Contract address does not match official Tether smart contract.',
        layerFailed: 1,
      };
    }

    // LAYER 2: TVM Execution Receipt Verification
    if (!TvmReceiptValidator.isExecutionSuccessful(txData.executionPayload)) {
      return {
        isValid: false,
        failureReason: 'Layer 2 Violation: Transaction failed, reverted, or ran out of energy in the TVM.',
        layerFailed: 2,
      };
    }

    // LAYER 3: Binary ABI Parameter Decoding & Matching
    const isAbiValid = AbiDecoder.validateTransferParameters(
      txData.rawDataHex,
      invoice.receivingAddress,
      invoice.amount
    );
    if (!isAbiValid) {
      return {
        isValid: false,
        failureReason: 'Layer 3 Violation: Method selector is not transfer(address,uint256) or parameters mismatch.',
        layerFailed: 3,
      };
    }

    // LAYER 4: Direct State Query (balanceOf) on Official Contract
    const hasSufficientStateBalance = await this.stateValidator.verifyBalanceSufficiency(
      invoice.receivingAddress,
      invoice.amount
    );
    if (!hasSufficientStateBalance) {
      return {
        isValid: false,
        failureReason: 'Layer 4 Violation: On-chain balanceOf query on official contract did not confirm expected balance.',
        layerFailed: 4,
      };
    }

    // LAYER 5: Consensus Finality (Solidified Block Depth)
    const isFinalized = await this.consensusValidator.isTransactionFinalized(txData.blockNumber);
    if (!isFinalized) {
      return {
        isValid: false,
        failureReason: 'Layer 5 Violation: Transaction block has not yet been solidified by Super Representatives.',
        layerFailed: 5,
      };
    }

    return {
      isValid: true,
    };
  }
}