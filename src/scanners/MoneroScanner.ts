/**
 * src/scanners/MoneroScanner.ts
 * Blockchain scanner for monitoring Monero (XMR) transactions across both
 * Watch-Only Wallet JSON-RPC and Direct Cryptographic Daemon/RingCT verification modes.
 */

import axios, { AxiosInstance } from 'axios';
import { IInvoice, IZeroPayConfig, InvoiceStatus, Currency, Network } from '../types';
import { CryptoUtils } from '../utils/crypto';
import { MoneroCryptoUtils } from '../utils/moneroCrypto';
import { MoneroTimelockValidator } from '../security/MoneroTimelockValidator';
import {
  MoneroAntiSpoofEngine,
  IRawMoneroTransactionData,
} from '../security/MoneroAntiSpoofEngine';

export interface IMoneroWalletTransferEntry {
  txid: string;
  amount: number | string;
  confirmations?: number;
  unlock_time?: number;
  double_spend_seen?: boolean;
  address?: string;
  subaddr_index?: {
    major: number;
    minor: number;
  };
}

export interface IMoneroWalletTransfersRpcResponse {
  result?: {
    in?: IMoneroWalletTransferEntry[];
    pool?: IMoneroWalletTransferEntry[];
  };
}

export interface IMoneroDaemonOutputTarget {
  key?: string;
  tagged_key?: {
    key: string;
    view_tag?: string;
  };
}

export interface IMoneroDaemonTransaction {
  tx_hash?: string;
  txid?: string;
  tx_pub_key?: string;
  extra?: number[] | string;
  unlock_time?: number;
  double_spend_seen?: boolean;
  failed?: boolean;
  in_pool?: boolean;
  block_height?: number;
  confirmations?: number;
  vout?: Array<{
    amount?: number;
    target?: IMoneroDaemonOutputTarget;
  }>;
  rct_signatures?: {
    type?: number;
    ecdhInfo?: Array<{
      amount: string;
    }>;
    outPk?: Array<string | { mask: string }>;
  };
}

export interface IMoneroDaemonTransactionsResponse {
  status?: string;
  chain_height?: number;
  transactions?: IMoneroDaemonTransaction[];
  txs?: IMoneroDaemonTransaction[];
}

export class MoneroScanner {
  private config: IZeroPayConfig;
  private apiClient: AxiosInstance;
  private antiSpoofEngine: MoneroAntiSpoofEngine;
  private static readonly DEFAULT_MONERO_RPC_URL = 'https://xmr-node.cakewallet.com:18081';

  constructor(config: IZeroPayConfig) {
    this.config = config;
    const baseURL =
      config.moneroWalletRpcUrl || config.moneroRpcUrl || MoneroScanner.DEFAULT_MONERO_RPC_URL;

    this.apiClient = axios.create({
      baseURL,
      timeout: 10000,
      headers: {
        'Content-Type': 'application/json',
      },
    });

    this.antiSpoofEngine = new MoneroAntiSpoofEngine(config);
  }

  /**
   * Scans the Monero network to detect and cryptographically verify incoming XMR payments.
   *
   * @param invoice The target Monero invoice
   * @param requiredConfirmations Minimum confirmations required to mark as CONFIRMED
   * @returns Updated invoice object if status or confirmation count changed, otherwise null
   */
  public async scanForPayment(
    invoice: IInvoice,
    requiredConfirmations: number = 1,
  ): Promise<IInvoice | null> {
    try {
      if (invoice.network !== Network.MONERO || invoice.currency !== Currency.XMR) {
        throw new Error(
          `Invalid network/currency pair passed to MoneroScanner: ${invoice.network}/${invoice.currency}`,
        );
      }

      if (this.config.moneroWalletRpcUrl) {
        return await this.scanViaWatchOnlyWalletRpc(invoice, requiredConfirmations);
      }

      return await this.scanViaCryptographicDaemonRpc(invoice, requiredConfirmations);
    } catch {
      // Fail silently during network drops or RPC timeouts to allow polling retry on next cycle
      return null;
    }
  }

  /**
   * Mode 1: Scans incoming and mempool transfers via a Watch-Only monero-wallet-rpc endpoint.
   */
  private async scanViaWatchOnlyWalletRpc(
    invoice: IInvoice,
    requiredConfirmations: number,
  ): Promise<IInvoice | null> {
    const expectedMinorIndex = invoice.derivationIndex + 1;
    const expectedPiconero = CryptoUtils.amountToBaseUnits(
      invoice.amount,
      MoneroCryptoUtils.PICONERO_DECIMALS,
    );

    const rpcPayload = {
      jsonrpc: '2.0',
      id: '0',
      method: 'get_transfers',
      params: {
        in: true,
        pool: true,
        account_index: 0,
        subaddr_indices: [expectedMinorIndex],
      },
    };

    const response = await this.apiClient.post<IMoneroWalletTransfersRpcResponse>(
      '/json_rpc',
      rpcPayload,
    );

    const result = response.data?.result;
    if (!result) {
      return null;
    }

    // 1. Evaluate Mempool (pool) transfers for 0-confirmation detection
    if (Array.isArray(result.pool)) {
      for (const tx of result.pool) {
        if (!this.matchesTargetSubaddress(tx, invoice, expectedMinorIndex)) {
          continue;
        }

        const isSafe = MoneroTimelockValidator.isExecutionAndTimelockSafe({
          unlockTime: tx.unlock_time ?? 0,
          doubleSpendSeen: tx.double_spend_seen,
        });

        if (!isSafe) {
          continue;
        }

        const receivedPiconero = BigInt(tx.amount);
        if (receivedPiconero >= expectedPiconero) {
          const newStatus =
            requiredConfirmations === 0 ? InvoiceStatus.CONFIRMED : InvoiceStatus.DETECTED;

          if (invoice.status !== newStatus) {
            return {
              ...invoice,
              status: newStatus,
              txHash: tx.txid,
              confirmations: 0,
            };
          }
        }
      }
    }

    // 2. Evaluate Confirmed (in) transfers
    if (Array.isArray(result.in)) {
      for (const tx of result.in) {
        if (!this.matchesTargetSubaddress(tx, invoice, expectedMinorIndex)) {
          continue;
        }

        const isSafe = MoneroTimelockValidator.isExecutionAndTimelockSafe({
          unlockTime: tx.unlock_time ?? 0,
          doubleSpendSeen: tx.double_spend_seen,
        });

        if (!isSafe) {
          continue;
        }

        const receivedPiconero = BigInt(tx.amount);
        if (receivedPiconero >= expectedPiconero) {
          const currentConfirmations = tx.confirmations ?? 0;
          let newStatus = invoice.status;

          if (currentConfirmations >= requiredConfirmations) {
            newStatus = InvoiceStatus.CONFIRMED;
          } else if (invoice.status === InvoiceStatus.PENDING) {
            newStatus = InvoiceStatus.DETECTED;
          }

          if (invoice.status !== newStatus || invoice.confirmations !== currentConfirmations) {
            return {
              ...invoice,
              status: newStatus,
              txHash: tx.txid,
              confirmations: currentConfirmations,
            };
          }
        }
      }
    }

    return null;
  }

  /**
   * Mode 2: Fetches raw RingCT transaction data from the Monero daemon/indexer and
   * executes the 5-Layer MoneroAntiSpoofEngine cryptographic verification pipeline.
   */
  private async scanViaCryptographicDaemonRpc(
    invoice: IInvoice,
    requiredConfirmations: number,
  ): Promise<IInvoice | null> {
    if (!this.config.moneroPrivateViewKey) {
      return null;
    }

    const response = await this.apiClient.post<IMoneroDaemonTransactionsResponse>(
      '/get_transactions',
      {
        address: invoice.receivingAddress,
        include_pool: true,
        decode_as_json: true,
      },
    );

    const data = response.data;
    if (!data) {
      return null;
    }

    const candidateTxs = data.transactions || data.txs || [];
    if (!Array.isArray(candidateTxs) || candidateTxs.length === 0) {
      return null;
    }

    const chainHeight = data.chain_height;

    for (const tx of candidateTxs) {
      const txId = tx.tx_hash || tx.txid || '';
      const txPublicKeyHex = tx.tx_pub_key || this.extractTxPublicKeyFromExtra(tx.extra);

      if (!txId || !txPublicKeyHex || !Array.isArray(tx.vout)) {
        continue;
      }

      const ecdhInfoList = tx.rct_signatures?.ecdhInfo || [];
      const outPkList = tx.rct_signatures?.outPk || [];

      for (let outputIndex = 0; outputIndex < tx.vout.length; outputIndex++) {
        const voutEntry = tx.vout[outputIndex];
        const outputStealthKeyHex =
          voutEntry.target?.tagged_key?.key || voutEntry.target?.key || '';
        const encryptedAmountHex = ecdhInfoList[outputIndex]?.amount || '';

        if (!outputStealthKeyHex || !encryptedAmountHex) {
          continue;
        }

        const rawOutPk = outPkList[outputIndex];
        const commitmentHex =
          typeof rawOutPk === 'string'
            ? rawOutPk
            : typeof rawOutPk === 'object' && rawOutPk !== null
              ? rawOutPk.mask
              : undefined;

        const rawTxData: IRawMoneroTransactionData = {
          transactionId: txId,
          txPublicKeyHex,
          outputIndex,
          outputStealthKeyHex,
          encryptedAmountHex,
          commitmentHex,
          executionState: {
            unlockTime: tx.unlock_time ?? 0,
            doubleSpendSeen: tx.double_spend_seen,
            failed: tx.failed,
          },
          blockHeight: tx.block_height,
          inPool: tx.in_pool,
        };

        // Execute Layers 1-4 via MoneroAntiSpoofEngine (passing 0 confirmations to evaluate cryptographic ownership & amount first)
        const verification = await this.antiSpoofEngine.verify(rawTxData, invoice, 0);
        if (!verification.isValid) {
          continue;
        }

        // Compute confirmation count
        let currentConfirmations = 0;
        if (typeof tx.confirmations === 'number' && tx.confirmations >= 0) {
          currentConfirmations = tx.confirmations;
        } else if (
          !tx.in_pool &&
          typeof tx.block_height === 'number' &&
          tx.block_height > 0 &&
          typeof chainHeight === 'number' &&
          chainHeight >= tx.block_height
        ) {
          currentConfirmations = chainHeight - tx.block_height + 1;
        }

        let newStatus = invoice.status;
        if (currentConfirmations >= requiredConfirmations) {
          newStatus = InvoiceStatus.CONFIRMED;
        } else if (invoice.status === InvoiceStatus.PENDING) {
          newStatus = InvoiceStatus.DETECTED;
        }

        if (invoice.status !== newStatus || invoice.confirmations !== currentConfirmations) {
          return {
            ...invoice,
            status: newStatus,
            txHash: txId,
            confirmations: currentConfirmations,
          };
        }
      }
    }

    return null;
  }

  /**
   * Extracts the 32-byte Transaction Public Key R from the CryptoNote extra field (Tag 0x01).
   */
  public extractTxPublicKeyFromExtra(extra?: number[] | string): string | null {
    if (!extra) {
      return null;
    }

    try {
      let bytes: Uint8Array;
      if (typeof extra === 'string') {
        bytes = MoneroCryptoUtils.hexToBytes(extra);
      } else if (Array.isArray(extra)) {
        bytes = new Uint8Array(extra);
      } else {
        return null;
      }

      // Tag 0x01 (TX_EXTRA_TAG_PUBKEY) is followed immediately by the 32-byte public key R
      for (let i = 0; i <= bytes.length - 33; i++) {
        if (bytes[i] === 0x01) {
          const candidateKey = bytes.subarray(i + 1, i + 33);
          if (MoneroCryptoUtils.isTorsionFreePublicKey(candidateKey)) {
            return MoneroCryptoUtils.bytesToHex(candidateKey);
          }
        }
      }

      return null;
    } catch {
      return null;
    }
  }

  private matchesTargetSubaddress(
    tx: IMoneroWalletTransferEntry,
    invoice: IInvoice,
    expectedMinorIndex: number,
  ): boolean {
    if (tx.address && tx.address === invoice.receivingAddress) {
      return true;
    }
    if (
      tx.subaddr_index &&
      tx.subaddr_index.major === 0 &&
      tx.subaddr_index.minor === expectedMinorIndex
    ) {
      return true;
    }
    return !tx.address && !tx.subaddr_index;
  }
}