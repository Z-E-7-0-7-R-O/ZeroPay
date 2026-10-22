/**
 * tests/scanners.test.ts
 * Unit tests for TronScanner, UtxoScanner, and ScannerFactory using network mocking.
 */

import axios from 'axios';
import { TronScanner } from '../src/scanners/TronScanner';
import { UtxoScanner } from '../src/scanners/UtxoScanner';
import { MoneroScanner } from '../src/scanners/MoneroScanner';
import { ScannerFactory } from '../src/scanners/ScannerFactory';
import { CryptonoteEngine } from '../src/engines/CryptonoteEngine';
import { RingCtVerifier } from '../src/security/RingCtVerifier';
import { MoneroCryptoUtils } from '../src/utils/moneroCrypto';
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

  describe('MoneroScanner', () => {
    const spendScalar = 1111111111111111111n;
    const viewScalar = 2222222222222222222n;
    const moneroPublicSpendKey = MoneroCryptoUtils.bytesToHex(
      MoneroCryptoUtils.scalarMultBase(spendScalar),
    );
    const moneroPrivateViewKey = MoneroCryptoUtils.bytesToHex(
      MoneroCryptoUtils.bigIntToBytesLE(viewScalar, 32),
    );
    const subaddrKeys = CryptonoteEngine.deriveSubaddressKeys(
      moneroPublicSpendKey,
      moneroPrivateViewKey,
      0,
    );

    const sampleMoneroInvoice: IInvoice = {
      id: 'inv-xmr-1',
      amount: '1.25',
      currency: Currency.XMR,
      network: Network.MONERO,
      receivingAddress: subaddrKeys.address,
      derivationIndex: 0,
      status: InvoiceStatus.PENDING,
      confirmations: 0,
      createdAt: Date.now(),
      expiresAt: Date.now() + 3600000,
    };

    it('should detect unconfirmed Monero transfer in mempool via Watch-Only Wallet RPC', async () => {
      const mockPost = jest.fn().mockResolvedValue({
        data: {
          result: {
            pool: [
              {
                txid: 'tx_xmr_pool_111',
                amount: '1250000000000', // 1.25 XMR in Piconero
                confirmations: 0,
                unlock_time: 0,
                double_spend_seen: false,
                subaddr_index: { major: 0, minor: 1 },
              },
            ],
          },
        },
      });

      mockedAxios.create.mockReturnValue({
        post: mockPost,
      } as never);

      const scanner = new MoneroScanner({
        ...config,
        moneroPublicSpendKey,
        moneroPrivateViewKey,
        moneroWalletRpcUrl: 'http://localhost:18082',
      });

      const updated = await scanner.scanForPayment(sampleMoneroInvoice, 10);
      expect(updated).not.toBeNull();
      expect(updated?.status).toBe(InvoiceStatus.DETECTED);
      expect(updated?.txHash).toBe('tx_xmr_pool_111');
      expect(updated?.confirmations).toBe(0);
    });

    it('should cryptographically verify and confirm Monero RingCT output via Daemon RPC', async () => {
      const txSecretR = 7777777777777777777n;
      const txPubKeyHex = MoneroCryptoUtils.bytesToHex(
        MoneroCryptoUtils.scalarMultBase(txSecretR),
      );
      const derivation = MoneroCryptoUtils.generateKeyDerivation(
        txPubKeyHex,
        moneroPrivateViewKey,
      );
      const outputScalar = MoneroCryptoUtils.deriveOutputScalar(derivation, 0);
      const outputScalarHex = MoneroCryptoUtils.bytesToHex(
        MoneroCryptoUtils.bigIntToBytesLE(outputScalar, 32),
      );
      const stealthKeyHex = MoneroCryptoUtils.bytesToHex(
        MoneroCryptoUtils.pointAdd(
          MoneroCryptoUtils.scalarMultBase(outputScalar),
          MoneroCryptoUtils.hexToBytes(subaddrKeys.subaddressPublicSpendKeyHex),
        ),
      );

      const amountPiconero = BigInt('1250000000000');
      const encryptedAmount = RingCtVerifier.encryptRingCtAmount(amountPiconero, outputScalarHex);
      const commitment = RingCtVerifier.computePedersenCommitment(amountPiconero, outputScalarHex);

      const mockPost = jest.fn().mockResolvedValue({
        data: {
          status: 'OK',
          chain_height: 3_100_020,
          transactions: [
            {
              tx_hash: 'tx_xmr_daemon_confirmed_999',
              tx_pub_key: txPubKeyHex,
              unlock_time: 0,
              double_spend_seen: false,
              in_pool: false,
              block_height: 3_100_010, // 11 confirmations
              vout: [
                {
                  amount: 0,
                  target: { tagged_key: { key: stealthKeyHex } },
                },
              ],
              rct_signatures: {
                ecdhInfo: [{ amount: encryptedAmount }],
                outPk: [{ mask: commitment }],
              },
            },
          ],
        },
      });

      mockedAxios.create.mockReturnValue({
        post: mockPost,
      } as never);

      const scanner = new MoneroScanner({
        ...config,
        moneroPublicSpendKey,
        moneroPrivateViewKey,
      });

      const updated = await scanner.scanForPayment(sampleMoneroInvoice, 10);
      expect(updated).not.toBeNull();
      expect(updated?.status).toBe(InvoiceStatus.CONFIRMED);
      expect(updated?.txHash).toBe('tx_xmr_daemon_confirmed_999');
      expect(updated?.confirmations).toBe(11);
    });
  });

  describe('ScannerFactory', () => {
    it('should correctly route TRON, UTXO, and MONERO invoices to their respective scanners', async () => {
      const factory = new ScannerFactory(config);

      const tronSpy = jest.spyOn(TronScanner.prototype, 'scanForPayment').mockResolvedValue(null);
      const utxoSpy = jest.spyOn(UtxoScanner.prototype, 'scanForPayment').mockResolvedValue(null);
      const moneroSpy = jest
        .spyOn(MoneroScanner.prototype, 'scanForPayment')
        .mockResolvedValue(null);

      await factory.scan(sampleTronInvoice);
      expect(tronSpy).toHaveBeenCalledTimes(1);

      await factory.scan(sampleLtcInvoice);
      expect(utxoSpy).toHaveBeenCalledTimes(1);

      const dummyMoneroInvoice: IInvoice = {
        ...sampleLtcInvoice,
        currency: Currency.XMR,
        network: Network.MONERO,
      };
      await factory.scan(dummyMoneroInvoice);
      expect(moneroSpy).toHaveBeenCalledTimes(1);
    });
  });
});