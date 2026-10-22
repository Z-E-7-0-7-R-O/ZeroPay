/**
 * src/storage/MemoryStorage.ts
 * A default, in-memory implementation of the IStorageAdapter for testing and rapid prototyping.
 * Warning: Data is lost when the Node.js process terminates.
 */

import { IStorageAdapter, IInvoice, InvoiceStatus, Network } from '../types';

export class MemoryStorage implements IStorageAdapter {
  private invoices: Map<string, IInvoice> = new Map();
  private derivationIndices: Map<Network, number> = new Map();

  public async saveInvoice(invoice: IInvoice): Promise<void> {
    this.invoices.set(invoice.id, invoice);
  }

  public async getInvoiceById(id: string): Promise<IInvoice | null> {
    const invoice = this.invoices.get(id);
    return invoice || null;
  }

  public async getInvoiceByAddress(address: string): Promise<IInvoice | null> {
    for (const invoice of this.invoices.values()) {
      if (invoice.receivingAddress === address) {
        return invoice;
      }
    }
    return null;
  }

  public async updateInvoiceStatus(
    id: string,
    status: InvoiceStatus,
    txHash?: string,
    confirmations?: number,
  ): Promise<void> {
    const invoice = this.invoices.get(id);
    if (invoice) {
      invoice.status = status;
      if (txHash !== undefined) {
        invoice.txHash = txHash;
      }
      if (confirmations !== undefined) {
        invoice.confirmations = confirmations;
      }
      this.invoices.set(id, invoice);
    }
  }

  public async getLatestDerivationIndex(network: Network): Promise<number> {
    // Retrieve the current index, default to 0 if it does not exist
    const currentIndex = this.derivationIndices.get(network) || 0;
    
    // Increment the index for the next request to ensure cryptographic uniqueness
    this.derivationIndices.set(network, currentIndex + 1);
    
    return currentIndex;
  }

  /**
   * Utility method specific to the polling engine to retrieve active invoices.
   */
  public async getActiveInvoices(): Promise<IInvoice[]> {
    const activeInvoices: IInvoice[] = [];
    for (const invoice of this.invoices.values()) {
      if (invoice.status === InvoiceStatus.PENDING || invoice.status === InvoiceStatus.DETECTED) {
        activeInvoices.push(invoice);
      }
    }
    return activeInvoices;
  }
}