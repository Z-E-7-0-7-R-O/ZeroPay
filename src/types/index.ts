/**
 * src/types/index.ts
 * Core data models and interfaces for the ZeroPay Protocol.
 */

export enum Currency {
  USDT = 'USDT',
  TRX = 'TRX',
  LTC = 'LTC',
  DOGE = 'DOGE',
}

export enum Network {
  TRON = 'TRON',
  LITECOIN = 'LITECOIN',
  DOGECOIN = 'DOGECOIN',
}

export enum InvoiceStatus {
  PENDING = 'PENDING',       // Invoice created, waiting for network detection
  DETECTED = 'DETECTED',     // Transaction seen in mempool (0 confirmations)
  CONFIRMED = 'CONFIRMED',   // Reached the required block confirmations
  EXPIRED = 'EXPIRED',       // Payment time window closed
  FAILED = 'FAILED',         // Insufficient amount or network error
}

export interface IZeroPayConfig {
  xpubLitecoin?: string;
  xpubDogecoin?: string;
  xpubTron?: string;
  
  webhookSecret: string;
  webhookUrl?: string;
  
  tronRpcUrl?: string; // Default can be public node, but configurable for enterprise
  tronApiKey?: string;
  
  defaultConfirmations?: number; // E.g., 1 for LTC, 12 for TRON
  defaultExpirationMinutes?: number;
}

export interface IInvoice {
  id: string; // Unique identifier (UUIDv4)
  amount: string; // Defined as string to prevent JavaScript float precision loss in financial data
  currency: Currency;
  network: Network;
  receivingAddress: string; // The dynamically generated address for this specific invoice
  derivationIndex: number; // The BIP44 index used to generate this address from the xPub
  status: InvoiceStatus;
  confirmations: number;
  txHash?: string; // The transaction hash on the blockchain once detected
  createdAt: number; // Unix timestamp
  expiresAt: number; // Unix timestamp
}

export interface IStorageAdapter {
  /**
   * Persists a newly created invoice to the database.
   */
  saveInvoice(invoice: IInvoice): Promise<void>;

  /**
   * Retrieves an invoice by its unique ID.
   */
  getInvoiceById(id: string): Promise<IInvoice | null>;

  /**
   * Retrieves an invoice by the dynamically generated receiving address.
   * This is critical for the Blockchain Scanners to match incoming funds to the correct invoice.
   */
  getInvoiceByAddress(address: string): Promise<IInvoice | null>;

  /**
   * Updates the state of an existing invoice (e.g., PENDING to CONFIRMED).
   */
  updateInvoiceStatus(id: string, status: InvoiceStatus, txHash?: string): Promise<void>;

  /**
   * Atomically retrieves and increments the derivation index for a specific network.
   * This ensures that two concurrent invoice requests do not generate the same receiving address.
   */
  getLatestDerivationIndex(network: Network): Promise<number>;
}

export interface IAddressGenerationResult {
  address: string;
  index: number;
}