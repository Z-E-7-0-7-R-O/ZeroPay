/**
 * src/scanners/UtxoScanner.ts
 * Blockchain scanner for monitoring UTXO networks (Litecoin and Dogecoin).
 */

import axios, { AxiosInstance } from 'axios';
import { IInvoice, IZeroPayConfig, InvoiceStatus, Network } from '../types';

export class UtxoScanner {
  private apiClient: AxiosInstance;
  private static readonly BLOCKCYPHER_BASE_URL = 'https://api.blockcypher.com/v1';

  // Prefixing the parameter with an underscore (_config) instructs the TypeScript compiler
  // to intentionally ignore the 'noUnusedParameters' rule for this specific variable,
  // maintaining compatibility with the ScannerFactory instantiation.
  constructor(_config: IZeroPayConfig) {
    // Initialize Axios client. BlockCypher limits unauthenticated requests to 3 per second.
    // In a production environment with high volume, a token should be passed in the config.
    this.apiClient = axios.create({
      baseURL: UtxoScanner.BLOCKCYPHER_BASE_URL,
      timeout: 10000,
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
      let coinPath = '';
      if (invoice.network === Network.LITECOIN) {
        coinPath = 'ltc/main';
      } else if (invoice.network === Network.DOGECOIN) {
        coinPath = 'doge/main';
      } else {
        throw new Error(`Unsupported network for UTXO scanner: ${invoice.network}`);
      }

      // Fetch address details. This endpoint returns both confirmed (txrefs) and unconfirmed (unconfirmed_txrefs) transactions.
      const response = await this.apiClient.get(`/${coinPath}/addrs/${invoice.receivingAddress}`);
      
      if (!response.data) {
        return null;
      }

      const data = response.data;
      
      // Convert the decimal invoice amount to base units (Satoshis)
      // 1 LTC/DOGE = 100,000,000 base units
      const expectedBaseUnits = Math.floor(parseFloat(invoice.amount) * 100_000_000);

      // 1. Check Unconfirmed Transactions (Mempool)
      if (data.unconfirmed_txrefs && Array.isArray(data.unconfirmed_txrefs)) {
        for (const tx of data.unconfirmed_txrefs) {
          // tx_input_n === -1 indicates that this address is the receiver (output) in this transaction
          if (tx.tx_input_n === -1 && tx.value === expectedBaseUnits) {
            if (invoice.status === InvoiceStatus.PENDING) {
              return {
                ...invoice,
                status: InvoiceStatus.DETECTED,
                txHash: tx.tx_hash,
                confirmations: 0,
              };
            }
          }
        }
      }

      // 2. Check Confirmed Transactions
      if (data.txrefs && Array.isArray(data.txrefs)) {
        for (const tx of data.txrefs) {
          if (tx.tx_input_n === -1 && tx.value === expectedBaseUnits) {
            const currentConfirmations = tx.confirmations || 0;
            let newStatus = invoice.status;

            if (currentConfirmations >= requiredConfirmations) {
              newStatus = InvoiceStatus.CONFIRMED;
            } else if (invoice.status === InvoiceStatus.PENDING) {
              newStatus = InvoiceStatus.DETECTED;
            }

            // Return updated invoice if status or confirmation count has changed
            if (invoice.status !== newStatus || invoice.confirmations !== currentConfirmations) {
              return {
                ...invoice,
                status: newStatus,
                txHash: tx.tx_hash,
                confirmations: currentConfirmations,
              };
            }
          }
        }
      }

      return null;
    } catch (error) {
      // API Rate limits (HTTP 429) or network timeouts are handled by silent failure.
      // The polling loop in the Core Engine will retry the operation automatically.
      return null;
    }
  }
}