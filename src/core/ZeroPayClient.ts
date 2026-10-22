/**
 * src/core/ZeroPayClient.ts
 * The primary execution wrapper and interface for the ZeroPay Protocol.
 */

import * as crypto from 'crypto';
import { IZeroPayConfig, IInvoice, IStorageAdapter, Currency, Network, InvoiceStatus } from '../types';
import { AddressGenerator } from '../engines/AddressGenerator';
import { ScannerFactory } from '../scanners/ScannerFactory';
import { WebhookManager } from './WebhookManager';
import { MemoryStorage } from '../storage/MemoryStorage';
import { ConfigManager } from './ConfigManager';

export class ZeroPayClient {
  private config: IZeroPayConfig;
  private storage: IStorageAdapter;
  private scannerFactory: ScannerFactory;
  private pollingIntervalId?: NodeJS.Timeout;
  private isPollingCycleRunning: boolean = false;

  constructor(config: IZeroPayConfig, storageAdapter?: IStorageAdapter) {
    // Process, validate, and apply defaults via ConfigManager
    this.config = ConfigManager.process(config);
    this.storage = storageAdapter || new MemoryStorage();
    this.scannerFactory = new ScannerFactory(this.config);
  }

  public async createInvoice(amount: string, currency: Currency, network: Network): Promise<IInvoice> {
    this.validateAmountFormat(amount);
    this.validateCurrencyNetworkPair(currency, network);

    const index = await this.storage.getLatestDerivationIndex(network);
    const receivingAddress = AddressGenerator.generate(this.config, network, index);

    const now = Date.now();
    const expirationMinutes = this.config.defaultExpirationMinutes!;
    
    const invoice: IInvoice = {
      id: crypto.randomUUID(),
      amount: amount.trim(),
      currency: currency,
      network: network,
      receivingAddress: receivingAddress,
      derivationIndex: index,
      status: InvoiceStatus.PENDING,
      confirmations: 0,
      createdAt: now,
      expiresAt: now + (expirationMinutes * 60 * 1000),
    };

    await this.storage.saveInvoice(invoice);

    return invoice;
  }

  public startPolling(intervalMs: number = 30000): void {
    if (this.pollingIntervalId) {
      throw new Error('Polling mechanism is already running.');
    }

    this.pollingIntervalId = setInterval(async () => {
      await this.executePollingCycle();
    }, intervalMs);
  }

  public stopPolling(): void {
    if (this.pollingIntervalId) {
      clearInterval(this.pollingIntervalId);
      this.pollingIntervalId = undefined;
    }
  }

  private validateAmountFormat(amount: string): void {
    if (!amount || typeof amount !== 'string' || !/^\d+(\.\d+)?$/.test(amount.trim())) {
      throw new Error('Invalid invoice amount: "amount" must be a valid positive decimal string.');
    }
    if (parseFloat(amount) <= 0) {
      throw new Error('Invalid invoice amount: "amount" must be strictly greater than zero.');
    }
  }

  private validateCurrencyNetworkPair(currency: Currency, network: Network): void {
    const validPairs: Record<Network, Currency[]> = {
      [Network.TRON]: [Currency.USDT, Currency.TRX],
      [Network.LITECOIN]: [Currency.LTC],
      [Network.DOGECOIN]: [Currency.DOGE],
      [Network.MONERO]: [Currency.XMR],
    };

    const allowedCurrencies = validPairs[network];
    if (!allowedCurrencies || !allowedCurrencies.includes(currency)) {
      throw new Error(
        `Incompatible currency and network combination: ${currency} is not supported on ${network}.`,
      );
    }
  }

  private async executePollingCycle(): Promise<void> {
    if (this.isPollingCycleRunning) {
      return;
    }

    this.isPollingCycleRunning = true;
    try {
      const activeInvoices = await this.storage.getActiveInvoices();

      for (const invoice of activeInvoices) {
        if (Date.now() > invoice.expiresAt && invoice.status === InvoiceStatus.PENDING) {
          await this.storage.updateInvoiceStatus(invoice.id, InvoiceStatus.EXPIRED);
          continue;
        }

        const requiredConfirmations = this.config.defaultConfirmations!;
        const updatedInvoice = await this.scannerFactory.scan(invoice, requiredConfirmations);

        if (updatedInvoice) {
          await this.storage.updateInvoiceStatus(
            updatedInvoice.id,
            updatedInvoice.status,
            updatedInvoice.txHash,
            updatedInvoice.confirmations,
          );

          if (updatedInvoice.status === InvoiceStatus.CONFIRMED && this.config.webhookUrl) {
            await WebhookManager.dispatch(updatedInvoice, this.config.webhookUrl, this.config.webhookSecret);
          }
        }
      }
    } catch (error) {
      // Polling cycle suppresses unhandled errors to avoid crashing the event loop
    } finally {
      this.isPollingCycleRunning = false;
    }
  }
}