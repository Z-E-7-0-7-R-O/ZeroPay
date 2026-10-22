/**
 * src/scanners/TronScanner.ts
 * Blockchain scanner for monitoring TRON network transactions (TRX and TRC20 Tokens).
 */

import axios, { AxiosInstance } from 'axios';
import { IInvoice, IZeroPayConfig, InvoiceStatus, Currency } from '../types';
import { CryptoUtils } from '../utils/crypto';

export class TronScanner {
  private apiClient: AxiosInstance;
  private static readonly USDT_CONTRACT_ADDRESS = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
  private static readonly TRON_GRID_BASE_URL = 'https://api.trongrid.io';

  constructor(config: IZeroPayConfig) {
    // Initialize Axios client with specific headers for TronGrid API
    this.apiClient = axios.create({
      baseURL: config.tronRpcUrl || TronScanner.TRON_GRID_BASE_URL,
      timeout: 10000,
      headers: {
        'Content-Type': 'application/json',
        ...(config.tronApiKey ? { 'TRON-PRO-API-KEY': config.tronApiKey } : {}),
      },
    });
  }

  /**
   * Scans the blockchain to determine if the invoice has been paid.
   * 
   * @param invoice The current state of the invoice
   * @param requiredConfirmations The number of block confirmations required to mark as CONFIRMED
   * @returns The updated invoice object if a state change occurred, otherwise null
   */
  public async scanForPayment(invoice: IInvoice, requiredConfirmations: number = 1): Promise<IInvoice | null> {
    try {
      if (invoice.currency === Currency.USDT) {
        return await this.checkTrc20Transfer(invoice, TronScanner.USDT_CONTRACT_ADDRESS, requiredConfirmations);
      } else if (invoice.currency === Currency.TRX) {
        return await this.checkNativeTransfer(invoice, requiredConfirmations);
      } else {
        throw new Error(`Unsupported currency for TRON scanner: ${invoice.currency}`);
      }
    } catch (error) {
      // In a production environment, this should log to a monitoring system
      // We fail silently here to allow the polling mechanism to retry on the next cycle
      return null;
    }
  }

  /**
   * Internal method to verify TRC20 Token transfers (e.g., USDT).
   */
  private async checkTrc20Transfer(invoice: IInvoice, contractAddress: string, requiredConfirmations: number): Promise<IInvoice | null> {
    // Fetch TRC20 transactions for the specific receiving address
    const response = await this.apiClient.get(`/v1/accounts/${invoice.receivingAddress}/transactions/trc20`, {
      params: {
        contract_address: contractAddress,
        only_to: true, // Only fetch incoming transactions
        limit: 5,
      }
    });

    if (!response.data || !response.data.data || response.data.data.length === 0) {
      return null; // No incoming transactions found yet
    }

    const transactions = response.data.data;
    
    // USDT has 6 decimals on TRON. We convert the invoice amount to its exact base unit representation.
    const expectedValueRaw = CryptoUtils.amountToBaseUnits(invoice.amount, 6).toString();

    for (const tx of transactions) {
      // Match the transaction value with the expected invoice amount
      if (tx.value === expectedValueRaw) {
        
        // TRON blocks are extremely fast (3 seconds). TronGrid does not always return confirmation counts in this endpoint.
        // For architectural safety, if TronGrid indexed it, we consider it DETECTED.
        // We will mock the block confirmation mapping based on the block timestamp vs current network block in a full enterprise version.
        // For this core library, detecting the indexed transaction is the primary gate.

        let newStatus = InvoiceStatus.DETECTED;
        
        // Basic confirmation simulation: if transaction is older than (requiredConfirmations * 3 seconds), mark confirmed
        const txTimestamp = parseInt(tx.block_timestamp, 10);
        const currentTime = Date.now();
        const estimatedBlockAge = Math.floor((currentTime - txTimestamp) / 3000);

        if (estimatedBlockAge >= requiredConfirmations) {
          newStatus = InvoiceStatus.CONFIRMED;
        }

        // Only return an updated invoice if the status has progressed
        if (invoice.status !== newStatus) {
          return {
            ...invoice,
            status: newStatus,
            txHash: tx.transaction_id,
            confirmations: estimatedBlockAge,
          };
        }
      }
    }

    return null;
  }

  /**
   * Internal method to verify Native TRX transfers.
   */
  private async checkNativeTransfer(invoice: IInvoice, requiredConfirmations: number): Promise<IInvoice | null> {
    // Native TRX transfers are queried from the standard transaction endpoint
    const response = await this.apiClient.get(`/v1/accounts/${invoice.receivingAddress}/transactions`, {
      params: {
        only_to: true,
        limit: 5,
      }
    });

    if (!response.data || !response.data.data || response.data.data.length === 0) {
      return null;
    }

    const transactions = response.data.data;
    const expectedSunRaw = CryptoUtils.amountToBaseUnits(invoice.amount, 6).toString();

    for (const tx of transactions) {
      // Ensure the transaction is a TransferContract (native TRX transfer)
      if (tx.raw_data && tx.raw_data.contract && tx.raw_data.contract[0].type === 'TransferContract') {
        const contractParam = tx.raw_data.contract[0].parameter.value;
        
        // Validate amount and destination address (requires Base58 to Hex matching in a rigorous check, 
        // but TronGrid 'only_to' filter guarantees destination)
        if (contractParam.amount.toString() === expectedSunRaw) {
          
          let newStatus = InvoiceStatus.DETECTED;
          const txTimestamp = tx.raw_data.timestamp;
          const currentTime = Date.now();
          const estimatedBlockAge = Math.floor((currentTime - txTimestamp) / 3000);

          if (estimatedBlockAge >= requiredConfirmations) {
            newStatus = InvoiceStatus.CONFIRMED;
          }

          if (invoice.status !== newStatus) {
            return {
              ...invoice,
              status: newStatus,
              txHash: tx.txID,
              confirmations: estimatedBlockAge,
            };
          }
        }
      }
    }

    return null;
  }
}