/**
 * tests/scanners.test.ts
 * Unit tests for TronScanner, UtxoScanner, and ScannerFactory using network mocking.
 */

import axios from 'axios';
import { TronScanner } from '../src/scanners/TronScanner';
import { UtxoScanner } from '../src/scanners/UtxoScanner';
import { ScannerFactory } from '../src/scanners/ScannerFactory';
import { IInvoice, InvoiceStatus, Currency, Network, IZeroPayConfig } from '../src/types';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

describe('Blockchain Scanners and Factory', () => {
  const config: IZeroPayConfig = {
    webhookSecret: 'test-secret',
    tronApiKey: 'test-tron-key',
  };

  const sampleTronInvoice: IInvoice = {
    id: 'inv-tron-1',
    amount: '50.00',
    currency: Currency.USDT,
    network: Network.TRON,
    receivingAddress: 'TGr79hzbPXVfUekprRXVEx7mkM1kyWPoyb',
    derivationIndex: 0,
    status: InvoiceStatus.PENDING,
    confirmations: 0,
    createdAt: Date.now(),
    expiresAt: Date.now() + 3600000,
  };

  const sampleLtcInvoice: IInvoice = {
    id: 'inv-ltc-1',
    amount: '1.50',
    currency: Currency.LTC,
    network: Network.LITECOIN,
    receivingAddress: 'ltc1qtestreceivingaddress987654321',
    derivationIndex: 1,
    status: InvoiceStatus.PENDING,
    confirmations: 0,
    createdAt: Date.now(),
    expiresAt: Date.now() + 3600000,
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('TronScanner', () => {
    it('should detect incoming TRC20 USDT transfer when amount matches exactly', async () => {
      const mockGet = jest.fn().mockResolvedValue({
        data: {
          data: [
            {
              transaction_id: 'tx_tron_mock_123',
              value: '50000000', // 50 USDT in base units
              block_timestamp: (Date.now() - 30000).toString(), // 30 seconds ago (10 blocks)
            },
          ],
        },
      });

      mockedAxios.create.mockReturnValue({
        get: mockGet,
      } as never);

      const scanner = new TronScanner(config);
      const updatedInvoice = await scanner.scanForPayment(sampleTronInvoice, 1);

      expect(updatedInvoice).not.toBeNull();
      expect(updatedInvoice?.status).toBe(InvoiceStatus.CONFIRMED);
      expect(updatedInvoice?.txHash).toBe('tx_tron_mock_123');
    });

    it('should return null if no matching transactions are returned by TronGrid', async () => {
      const mockGet = jest.fn().mockResolvedValue({
        data: { data: [] },
      });

      mockedAxios.create.mockReturnValue({
        get: mockGet,
      } as never);

      const scanner = new TronScanner(config);
      const result = await scanner.scanForPayment(sampleTronInvoice, 1);
      expect(result).toBeNull();
    });

    it('should fail silently and return null on network exception', async () => {
      const mockGet = jest.fn().mockRejectedValue(new Error('Network Timeout'));
      mockedAxios.create.mockReturnValue({
        get: mockGet,
      } as never);

      const scanner = new TronScanner(config);
      const result = await scanner.scanForPayment(sampleTronInvoice, 1);
      expect(result).toBeNull();
    });
  });

  describe('UtxoScanner', () => {
    it('should detect unconfirmed UTXO transaction in mempool and set status to DETECTED', async () => {
      const mockGet = jest.fn().mockResolvedValue({
        data: {
          unconfirmed_txrefs: [
            {
              tx_hash: 'tx_ltc_mempool_456',
              tx_input_n: -1, // Output receiver
              value: 150000000, // 1.50 LTC in Litoshis
            },
          ],
        },
      });

      mockedAxios.create.mockReturnValue({
        get: mockGet,
      } as never);

      const scanner = new UtxoScanner(config);
      const updatedInvoice = await scanner.scanForPayment(sampleLtcInvoice, 1);

      expect(updatedInvoice).not.toBeNull();
      expect(updatedInvoice?.status).toBe(InvoiceStatus.DETECTED);
      expect(updatedInvoice?.txHash).toBe('tx_ltc_mempool_456');
      expect(updatedInvoice?.confirmations).toBe(0);
    });

    it('should confirm UTXO transaction when confirmations meet requirement', async () => {
      const mockGet = jest.fn().mockResolvedValue({
        data: {
          txrefs: [
            {
              tx_hash: 'tx_ltc_confirmed_789',
              tx_input_n: -1,
              value: 150000000,
              confirmations: 3,
            },
          ],
        },
      });

      mockedAxios.create.mockReturnValue({
        get: mockGet,
      } as never);

      const scanner = new UtxoScanner(config);
      const updatedInvoice = await scanner.scanForPayment(sampleLtcInvoice, 2);

      expect(updatedInvoice).not.toBeNull();
      expect(updatedInvoice?.status).toBe(InvoiceStatus.CONFIRMED);
      expect(updatedInvoice?.confirmations).toBe(3);
    });
  });

  describe('ScannerFactory', () => {
    it('should correctly route TRON invoices to TronScanner and UTXO invoices to UtxoScanner', async () => {
      const factory = new ScannerFactory(config);

      const tronSpy = jest.spyOn(TronScanner.prototype, 'scanForPayment').mockResolvedValue(null);
      const utxoSpy = jest.spyOn(UtxoScanner.prototype, 'scanForPayment').mockResolvedValue(null);

      await factory.scan(sampleTronInvoice);
      expect(tronSpy).toHaveBeenCalledTimes(1);

      await factory.scan(sampleLtcInvoice);
      expect(utxoSpy).toHaveBeenCalledTimes(1);
    });
  });
});