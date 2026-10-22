/**
 * tests/core.test.ts
 * Unit and integration tests for ConfigManager, MemoryStorage, WebhookManager, and ZeroPayClient.
 */

import axios from 'axios';
import { ConfigManager } from '../src/core/ConfigManager';
import { MemoryStorage } from '../src/storage/MemoryStorage';
import { WebhookManager } from '../src/core/WebhookManager';
import { ZeroPayClient } from '../src/core/ZeroPayClient';
import { CryptoUtils } from '../src/utils/crypto';
import { IInvoice, InvoiceStatus, Currency, Network, IZeroPayConfig } from '../src/types';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

describe('Core Orchestration and Utilities', () => {
  const validMockXpub = 'xpub661MyMwAqRbcFtXgS5sYJABqqG9YLmC4Q1Rdap9gSE8NqtwybGhePY2gZ29ESFjqJoCu1Rupje8YtGqsefD265TMg7usUDFdp6W1EGMcet8';
  // Ed25519 base point G and a valid 32-byte scalar in hexadecimal
  const validMoneroPublicSpendKey =
    '5866666666666666666666666666666666666666666666666666666666666666';
  const validMoneroPrivateViewKey =
    '0100000000000000000000000000000000000000000000000000000000000000';

  describe('ConfigManager', () => {
    it('should validate complete configuration and apply deterministic defaults', () => {
      const rawConfig: IZeroPayConfig = {
        webhookSecret: 'top-secret-key',
        xpubTron: validMockXpub,
      };

      const processed = ConfigManager.process(rawConfig);
      expect(processed.webhookSecret).toBe('top-secret-key');
      expect(processed.tronRpcUrl).toBe('https://api.trongrid.io');
      expect(processed.defaultConfirmations).toBe(1);
      expect(processed.defaultExpirationMinutes).toBe(60);
    });

    it('should throw an error if webhookSecret is empty or missing', () => {
      expect(() => {
        ConfigManager.process({ webhookSecret: '' });
      }).toThrow('Invalid configuration: "webhookSecret" must be a non-empty string');
    });

    it('should throw an error if webhookUrl has an invalid protocol', () => {
      expect(() => {
        ConfigManager.process({
          webhookSecret: 'key',
          webhookUrl: 'ftp://invalidscheme.com',
        });
      }).toThrow('Protocol must be HTTP or HTTPS');
    });

    it('should throw an error if xPub format fails length boundary check', () => {
      expect(() => {
        ConfigManager.process({
          webhookSecret: 'key',
          xpubTron: 'too-short-xpub',
        });
      }).toThrow('does not conform to the expected length for an Extended Public Key');
    });

    it('should validate Monero key pairs and reject incomplete or malformed keys', () => {
      const processed = ConfigManager.process({
        webhookSecret: 'key',
        moneroPublicSpendKey: validMoneroPublicSpendKey,
        moneroPrivateViewKey: validMoneroPrivateViewKey,
      });
      expect(processed.moneroRpcUrl).toBe('https://xmr-node.cakewallet.com:18081');

      expect(() => {
        ConfigManager.process({
          webhookSecret: 'key',
          moneroPublicSpendKey: validMoneroPublicSpendKey,
        });
      }).toThrow('Both "moneroPublicSpendKey" and "moneroPrivateViewKey" must be provided together');

      expect(() => {
        ConfigManager.process({
          webhookSecret: 'key',
          moneroPublicSpendKey: 'short-hex',
          moneroPrivateViewKey: validMoneroPrivateViewKey,
        });
      }).toThrow('must be a 64-character hexadecimal string');
    });
  });

  describe('MemoryStorage', () => {
    let storage: MemoryStorage;

    beforeEach(() => {
      storage = new MemoryStorage();
    });

    it('should atomically retrieve and increment derivation indices per network', async () => {
      const index0 = await storage.getLatestDerivationIndex(Network.TRON);
      const index1 = await storage.getLatestDerivationIndex(Network.TRON);
      const ltcIndex0 = await storage.getLatestDerivationIndex(Network.LITECOIN);

      expect(index0).toBe(0);
      expect(index1).toBe(1);
      expect(ltcIndex0).toBe(0); // Network isolation
    });

    it('should persist, retrieve, and update invoice records correctly', async () => {
      const invoice: IInvoice = {
        id: 'uuid-1234',
        amount: '100.00',
        currency: Currency.USDT,
        network: Network.TRON,
        receivingAddress: 'TTestAddress123456789012345678901',
        derivationIndex: 0,
        status: InvoiceStatus.PENDING,
        confirmations: 0,
        createdAt: Date.now(),
        expiresAt: Date.now() + 3600000,
      };

      await storage.saveInvoice(invoice);
      const retrieved = await storage.getInvoiceById('uuid-1234');
      expect(retrieved).toEqual(invoice);

      const byAddress = await storage.getInvoiceByAddress('TTestAddress123456789012345678901');
      expect(byAddress).toEqual(invoice);

      await storage.updateInvoiceStatus('uuid-1234', InvoiceStatus.CONFIRMED, 'tx_hash_confirmed');
      const updated = await storage.getInvoiceById('uuid-1234');
      expect(updated?.status).toBe(InvoiceStatus.CONFIRMED);
      expect(updated?.txHash).toBe('tx_hash_confirmed');
    });

    it('should accurately filter active invoices (PENDING and DETECTED)', async () => {
      const activeInv: IInvoice = {
        id: 'inv-active',
        amount: '50.00',
        currency: Currency.USDT,
        network: Network.TRON,
        receivingAddress: 'TAddr1',
        derivationIndex: 0,
        status: InvoiceStatus.PENDING,
        confirmations: 0,
        createdAt: Date.now(),
        expiresAt: Date.now() + 3600000,
      };

      const finishedInv: IInvoice = {
        id: 'inv-finished',
        amount: '50.00',
        currency: Currency.USDT,
        network: Network.TRON,
        receivingAddress: 'TAddr2',
        derivationIndex: 1,
        status: InvoiceStatus.CONFIRMED,
        confirmations: 12,
        createdAt: Date.now(),
        expiresAt: Date.now() + 3600000,
      };

      await storage.saveInvoice(activeInv);
      await storage.saveInvoice(finishedInv);

      const activeList = await storage.getActiveInvoices();
      expect(activeList.length).toBe(1);
      expect(activeList[0].id).toBe('inv-active');
    });
  });

  describe('WebhookManager', () => {
    it('should generate valid HMAC-SHA256 signature and dispatch POST payload', async () => {
      let capturedHeaders: Record<string, string> = {};
      let capturedPayload = '';

      mockedAxios.post.mockImplementation((_url, data, config) => {
        capturedPayload = data as string;
        capturedHeaders = config?.headers as Record<string, string>;
        return Promise.resolve({ status: 200 });
      });

      const invoice: IInvoice = {
        id: 'inv-webhook-test',
        amount: '25.00',
        currency: Currency.USDT,
        network: Network.TRON,
        receivingAddress: 'TAddr3',
        derivationIndex: 0,
        status: InvoiceStatus.CONFIRMED,
        confirmations: 1,
        createdAt: Date.now(),
        expiresAt: Date.now() + 3600000,
      };

      const secret = 'webhook-cryptographic-secret';
      const success = await WebhookManager.dispatch(invoice, 'https://merchant.com/webhook', secret);

      expect(success).toBe(true);
      expect(capturedHeaders['X-ZeroPay-Signature']).toBeDefined();

      // Verify signature authenticity using CryptoUtils timing-safe validation
      const isAuthentic = CryptoUtils.verifyHmacSignature(
        capturedPayload,
        capturedHeaders['X-ZeroPay-Signature'],
        secret
      );
      expect(isAuthentic).toBe(true);
    });

    it('should return false when destination server returns HTTP error status', async () => {
      mockedAxios.post.mockRejectedValue(new Error('Internal Server Error'));

      const dummyInvoice = {} as IInvoice;
      const success = await WebhookManager.dispatch(dummyInvoice, 'https://merchant.com/webhook', 'secret');
      expect(success).toBe(false);
    });
  });

  describe('ZeroPayClient', () => {
    it('should construct an invoice atomically with valid cryptographic address and metadata', async () => {
      const config: IZeroPayConfig = {
        webhookSecret: 'secret-123',
        xpubTron: validMockXpub,
      };

      const client = new ZeroPayClient(config);
      const invoice = await client.createInvoice('75.00', Currency.USDT, Network.TRON);

      expect(invoice.id).toBeDefined();
      expect(invoice.amount).toBe('75.00');
      expect(invoice.currency).toBe(Currency.USDT);
      expect(invoice.network).toBe(Network.TRON);
      expect(invoice.receivingAddress.startsWith('T')).toBe(true);
      expect(invoice.derivationIndex).toBe(0);
      expect(invoice.status).toBe(InvoiceStatus.PENDING);
    });

    it('should construct a Monero (XMR) invoice with a valid 95-character subaddress', async () => {
      const config: IZeroPayConfig = {
        webhookSecret: 'secret-123',
        moneroPublicSpendKey: validMoneroPublicSpendKey,
        moneroPrivateViewKey: validMoneroPrivateViewKey,
      };

      const client = new ZeroPayClient(config);
      const xmrInvoice = await client.createInvoice('1.50', Currency.XMR, Network.MONERO);

      expect(xmrInvoice.id).toBeDefined();
      expect(xmrInvoice.amount).toBe('1.50');
      expect(xmrInvoice.currency).toBe(Currency.XMR);
      expect(xmrInvoice.network).toBe(Network.MONERO);
      expect(xmrInvoice.receivingAddress.startsWith('8')).toBe(true);
      expect(xmrInvoice.receivingAddress.length).toBe(95);
      expect(xmrInvoice.derivationIndex).toBe(0);
    });

    it('should reject incompatible currency and network combinations', async () => {
      const config: IZeroPayConfig = {
        webhookSecret: 'secret-123',
        xpubTron: validMockXpub,
        moneroPublicSpendKey: validMoneroPublicSpendKey,
        moneroPrivateViewKey: validMoneroPrivateViewKey,
      };

      const client = new ZeroPayClient(config);
      await expect(client.createInvoice('10.00', Currency.XMR, Network.TRON)).rejects.toThrow(
        'Incompatible currency and network combination',
      );
    });

    it('should manage polling cycle interval state safely', () => {
      const config: IZeroPayConfig = {
        webhookSecret: 'secret-123',
        xpubTron: validMockXpub,
      };

      const client = new ZeroPayClient(config);
      expect(() => client.startPolling(5000)).not.toThrow();
      expect(() => client.startPolling(5000)).toThrow('Polling mechanism is already running.');
      expect(() => client.stopPolling()).not.toThrow();
    });
  });
});