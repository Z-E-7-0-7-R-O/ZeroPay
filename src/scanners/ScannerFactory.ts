/**
 * src/scanners/ScannerFactory.ts
 * Factory class to abstract the instantiation and routing of specific blockchain scanners.
 */

import { IInvoice, IZeroPayConfig, Network } from '../types';
import { TronScanner } from './TronScanner';
import { UtxoScanner } from './UtxoScanner';
import { MoneroScanner } from './MoneroScanner';

export class ScannerFactory {
  private tronScanner: TronScanner;
  private utxoScanner: UtxoScanner;
  private moneroScanner: MoneroScanner;

  constructor(config: IZeroPayConfig) {
    this.tronScanner = new TronScanner(config);
    this.utxoScanner = new UtxoScanner(config);
    this.moneroScanner = new MoneroScanner(config);
  }

  /**
   * Routes the invoice to the appropriate blockchain scanner based on its network.
   * 
   * @param invoice The invoice to scan for
   * @param requiredConfirmations The confirmations required for finality
   * @returns The updated invoice or null if no state change occurred
   */
  public async scan(invoice: IInvoice, requiredConfirmations?: number): Promise<IInvoice | null> {
    if (invoice.network === Network.TRON) {
      return this.tronScanner.scanForPayment(invoice, requiredConfirmations);
    } 
    
    if (invoice.network === Network.LITECOIN || invoice.network === Network.DOGECOIN) {
      return this.utxoScanner.scanForPayment(invoice, requiredConfirmations);
    }

    if (invoice.network === Network.MONERO) {
      return this.moneroScanner.scanForPayment(invoice, requiredConfirmations);
    }

    throw new Error(`Unsupported network in ScannerFactory: ${invoice.network}`);
  }
}