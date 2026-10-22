/**
 * tests/security.test.ts
 * Comprehensive unit tests for the 5-layer anti-counterfeit and anti-flash token defense subsystem.
 */

import { ContractWhitelist } from '../src/security/ContractWhitelist';
import { TvmReceiptValidator } from '../src/security/TvmReceiptValidator';
import { AbiDecoder } from '../src/security/AbiDecoder';
import { StateQueryValidator } from '../src/security/StateQueryValidator';
import { ConsensusFinalityValidator } from '../src/security/ConsensusFinalityValidator';
import { AntiCounterfeitEngine, IRawTronTransactionData } from '../src/security/AntiCounterfeitEngine';
import { MoneroKeyValidator } from '../src/security/MoneroKeyValidator';
import { MoneroTimelockValidator } from '../src/security/MoneroTimelockValidator';
import { StealthOutputVerifier } from '../src/security/StealthOutputVerifier';
import { RingCtVerifier } from '../src/security/RingCtVerifier';
import { MoneroFinalityValidator } from '../src/security/MoneroFinalityValidator';
import {
  MoneroAntiSpoofEngine,
  IRawMoneroTransactionData,
} from '../src/security/MoneroAntiSpoofEngine';
import { CryptonoteEngine } from '../src/engines/CryptonoteEngine';
import { MoneroCryptoUtils } from '../src/utils/moneroCrypto';
import { HttpClient } from '../src/utils/http';
import { IInvoice, InvoiceStatus, Currency, Network, IZeroPayConfig } from '../src/types';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const TronWeb = require('tronweb');

describe('Anti-Counterfeit & Anti-Flash Subsystem', () => {
  const targetAddressBase58 = 'TGr79hzbPXVfUekprRXVEx7mkM1kyWPoyb';
  let targetAddressHex20: string;
  let validDataHex: string;

  beforeAll(() => {
    const fullHex = TronWeb.address.toHex(targetAddressBase58);
    targetAddressHex20 = fullHex.startsWith('41') ? fullHex.substring(2) : fullHex;
    const addressPadded = targetAddressHex20.padStart(64, '0');
    // Using BigInt directly but converting to hex string immediately to prevent scope leakage
    const amountSun = BigInt(50_000_000); // 50.00 USDT (6 decimals)
    const amountPadded = amountSun.toString(16).padStart(64, '0');
    validDataHex = `a9059cbb${addressPadded}${amountPadded}`;
  });

  describe('Layer 1: ContractWhitelist', () => {
    it('should approve official Tether contract in Base58 format', () => {
      expect(ContractWhitelist.isOfficialUsdt('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t')).toBe(true);
    });

    it('should approve official Tether contract in Hex format', () => {
      expect(ContractWhitelist.isOfficialUsdt('41a614f803b6fd780986a42c78ec9c7f77e6ded13c')).toBe(true);
    });

    it('should reject spoofed or fake contract addresses', () => {
      expect(ContractWhitelist.isOfficialUsdt('TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf')).toBe(false);
      expect(ContractWhitelist.isOfficialUsdt('410000000000000000000000000000000000000000')).toBe(false);
    });

    it('should safely reject empty or non-string inputs', () => {
      expect(ContractWhitelist.isOfficialUsdt('')).toBe(false);
      // @ts-expect-error Testing defensive runtime handling
      expect(ContractWhitelist.isOfficialUsdt(null)).toBe(false);
    });
  });

  describe('Layer 2: TvmReceiptValidator', () => {
    it('should validate successful execution receipt with contractRet SUCCESS', () => {
      const validPayload = {
        ret: [{ contractRet: 'SUCCESS', fee: 1000 }],
      };
      expect(TvmReceiptValidator.isExecutionSuccessful(validPayload)).toBe(true);
    });

    it('should reject transactions that were reverted or ran out of energy', () => {
      expect(TvmReceiptValidator.isExecutionSuccessful({ ret: [{ contractRet: 'REVERT' }] })).toBe(false);
      expect(TvmReceiptValidator.isExecutionSuccessful({ ret: [{ contractRet: 'OUT_OF_ENERGY' }] })).toBe(false);
      expect(TvmReceiptValidator.isExecutionSuccessful({ ret: [{ contractRet: 'FAILED' }] })).toBe(false);
    });

    it('should reject malformed or empty execution payloads', () => {
      expect(TvmReceiptValidator.isExecutionSuccessful({})).toBe(false);
      // @ts-expect-error Testing defensive runtime handling
      expect(TvmReceiptValidator.isExecutionSuccessful(null)).toBe(false);
    });
  });

  describe('Layer 3: AbiDecoder', () => {
    it('should decode genuine transfer(address,uint256) data and match parameters', () => {
      const decoded = AbiDecoder.decodeTransfer(validDataHex);
      
      // Isolate BigInt from Jest serializers by evaluating booleans and strings
      expect(decoded !== null).toBe(true);
      expect(decoded?.methodSelector).toBe('a9059cbb');
      expect(decoded?.recipientAddressBase58).toBe(targetAddressBase58);
      expect(decoded?.amountUnits.toString()).toBe('50000000');

      const isValid = AbiDecoder.validateTransferParameters(validDataHex, targetAddressBase58, '50.00');
      expect(isValid).toBe(true);
    });

    it('should reject transaction if method selector is not transfer (e.g. approve 095ea7b3)', () => {
      const invalidSelectorHex = `095ea7b3${validDataHex.substring(8)}`;
      const decoded = AbiDecoder.decodeTransfer(invalidSelectorHex);
      expect(decoded === null).toBe(true);
      expect(AbiDecoder.validateTransferParameters(invalidSelectorHex, targetAddressBase58, '50.00')).toBe(false);
    });

    it('should reject transaction if transfer amount does not match invoice requirements', () => {
      // Expecting 50.00 USDT, but data payload only sends 10.00 USDT
      const isValid = AbiDecoder.validateTransferParameters(validDataHex, targetAddressBase58, '10.00');
      expect(isValid).toBe(false);
    });

    it('should reject transaction if recipient address does not match invoice receiving address', () => {
      const differentAddress = 'TNN2qW84F3w6h6oR5o1W6Z3aU2e7X4y5Z6';
      const isValid = AbiDecoder.validateTransferParameters(validDataHex, differentAddress, '50.00');
      expect(isValid).toBe(false);
    });
  });

  describe('Layer 4: StateQueryValidator', () => {
    it('should query on-chain balance and confirm sufficiency using mocked HTTP client', async () => {
      const mockHttpClient = new HttpClient();
      jest.spyOn(mockHttpClient, 'post').mockResolvedValue({
        data: {
          result: { result: true },
          // Correct Hex for 50,000,000 is 02faf080
          constant_result: ['0000000000000000000000000000000000000000000000000000000002faf080'],
        },
        status: 200,
        statusText: 'OK',
        headers: {},
        config: {},
      } as never);

      const stateValidator = new StateQueryValidator('https://api.trongrid.io', mockHttpClient);
      const balance = await stateValidator.queryOnChainBalance(targetAddressBase58);
      
      // Isolate BigInt from Jest Matcher
      expect(balance.toString()).toBe('50000000');

      const isSufficient = await stateValidator.verifyBalanceSufficiency(targetAddressBase58, '50.00');
      expect(isSufficient).toBe(true);

      const isUnderfunded = await stateValidator.verifyBalanceSufficiency(targetAddressBase58, '100.00');
      expect(isUnderfunded).toBe(false);
    });
  });

  describe('Layer 5: ConsensusFinalityValidator', () => {
    it('should verify transaction finality when block number is below or equal to solidified block', async () => {
      const mockHttpClient = new HttpClient();
      jest.spyOn(mockHttpClient, 'post').mockResolvedValue({
        data: {
          block_header: {
            raw_data: {
              number: 65_000_000,
            },
          },
        },
        status: 200,
        statusText: 'OK',
        headers: {},
        config: {},
      } as never);

      const finalityValidator = new ConsensusFinalityValidator('https://api.trongrid.io', mockHttpClient);
      const isFinalized = await finalityValidator.isTransactionFinalized(64_999_990);
      expect(isFinalized).toBe(true);

      const isUnsolidified = await finalityValidator.isTransactionFinalized(65_000_050);
      expect(isUnsolidified).toBe(false);
    });
  });

  describe('AntiCounterfeitEngine Pipeline Orchestrator', () => {
    let mockHttpClient: HttpClient;
    let engine: AntiCounterfeitEngine;
    let sampleInvoice: IInvoice;

    beforeEach(() => {
      mockHttpClient = new HttpClient();
      // Mock Layer 4 on-chain state balance query
      jest.spyOn(mockHttpClient, 'post').mockImplementation((url: string) => {
        if (url === '/wallet/triggerconstantcontract') {
          return Promise.resolve({
            // Correct Hex for 50,000,000 is 02faf080
            data: { constant_result: ['0000000000000000000000000000000000000000000000000000000002faf080'] },
          } as never);
        }
        if (url === '/walletsolidity/getnowblock') {
          return Promise.resolve({
            data: { block_header: { raw_data: { number: 65_000_000 } } },
          } as never);
        }
        return Promise.reject(new Error('Unrecognized mock endpoint'));
      });

      const config: IZeroPayConfig = { webhookSecret: 'test-secret' };
      engine = new AntiCounterfeitEngine(config, mockHttpClient);

      sampleInvoice = {
        id: 'test-invoice-uuid',
        amount: '50.00',
        currency: Currency.USDT,
        network: Network.TRON,
        receivingAddress: targetAddressBase58,
        derivationIndex: 0,
        status: InvoiceStatus.PENDING,
        confirmations: 0,
        createdAt: Date.now(),
        expiresAt: Date.now() + 3600000,
      };
    });

    it('should completely approve transaction passing all 5 verification layers', async () => {
      const validTxData: IRawTronTransactionData = {
        transactionId: '0xabc123',
        contractAddress: ContractWhitelist.OFFICIAL_USDT_BASE58,
        rawDataHex: validDataHex,
        executionPayload: { ret: [{ contractRet: 'SUCCESS' }] },
        blockNumber: 64_999_900,
      };

      const result = await engine.verify(validTxData, sampleInvoice);
      expect(result.isValid).toBe(true);
      expect(result.failureReason).toBeUndefined();
    });

    it('should halt and fail at Layer 1 if counterfeit contract is detected', async () => {
      const fakeContractTx: IRawTronTransactionData = {
        transactionId: '0xabc123',
        contractAddress: 'TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf', // Fake token contract
        rawDataHex: validDataHex,
        executionPayload: { ret: [{ contractRet: 'SUCCESS' }] },
        blockNumber: 64_999_900,
      };

      const result = await engine.verify(fakeContractTx, sampleInvoice);
      expect(result.isValid).toBe(false);
      expect(result.layerFailed).toBe(1);
    });

    it('should halt and fail at Layer 2 if transaction execution failed in TVM', async () => {
      const revertedTx: IRawTronTransactionData = {
        transactionId: '0xabc123',
        contractAddress: ContractWhitelist.OFFICIAL_USDT_BASE58,
        rawDataHex: validDataHex,
        executionPayload: { ret: [{ contractRet: 'REVERT' }] },
        blockNumber: 64_999_900,
      };

      const result = await engine.verify(revertedTx, sampleInvoice);
      expect(result.isValid).toBe(false);
      expect(result.layerFailed).toBe(2);
    });

    it('should halt and fail at Layer 3 if ABI parameters mismatch invoice', async () => {
      const wrongAmountTx: IRawTronTransactionData = {
        transactionId: '0xabc123',
        contractAddress: ContractWhitelist.OFFICIAL_USDT_BASE58,
        rawDataHex: `a9059cbb${targetAddressHex20.padStart(64, '0')}${'0000000000000000000000000000000000000000000000000000000000000001'}`, // Amount is 1 Sun instead of 50M
        executionPayload: { ret: [{ contractRet: 'SUCCESS' }] },
        blockNumber: 64_999_900,
      };

      const result = await engine.verify(wrongAmountTx, sampleInvoice);
      expect(result.isValid).toBe(false);
      expect(result.layerFailed).toBe(3);
    });

    it('should halt and fail at Layer 5 if block is unsolidified', async () => {
      const unsolidifiedTx: IRawTronTransactionData = {
        transactionId: '0xabc123',
        contractAddress: ContractWhitelist.OFFICIAL_USDT_BASE58,
        rawDataHex: validDataHex,
        executionPayload: { ret: [{ contractRet: 'SUCCESS' }] },
        blockNumber: 65_000_100, // Higher than latest solidified block (65_000_000)
      };

      const result = await engine.verify(unsolidifiedTx, sampleInvoice);
      expect(result.isValid).toBe(false);
      expect(result.layerFailed).toBe(5);
    });
  });

  describe('Monero 5-Layer Anti-Spoofing & RingCT Verification Subsystem', () => {
    let moneroPublicSpendKey: string;
    let moneroPrivateViewKey: string;
    let targetSubaddress: string;
    let txPublicKeyHex: string;
    let outputStealthKeyHex: string;
    let outputScalarHex: string;
    let encryptedAmountHex: string;
    let commitmentHex: string;
    const outputIndex = 0;

    beforeAll(() => {
      // Deterministic test scalars for merchant keys
      const spendScalar = 1234567890123456789n;
      const viewScalar = 9876543210987654321n;

      moneroPublicSpendKey = MoneroCryptoUtils.bytesToHex(
        MoneroCryptoUtils.scalarMultBase(spendScalar),
      );
      moneroPrivateViewKey = MoneroCryptoUtils.bytesToHex(
        MoneroCryptoUtils.bigIntToBytesLE(viewScalar, 32),
      );

      // Derive subaddress for invoice index 0 (Minor Index 1)
      const subaddrKeys = CryptonoteEngine.deriveSubaddressKeys(
        moneroPublicSpendKey,
        moneroPrivateViewKey,
        0,
      );
      targetSubaddress = subaddrKeys.address;

      // Simulate sender constructing a genuine Monero RingCT output for 2.50 XMR (2,500,000,000,000 Piconero)
      const txEphemeralScalarR = 5555555555555555555n;
      txPublicKeyHex = MoneroCryptoUtils.bytesToHex(
        MoneroCryptoUtils.scalarMultBase(txEphemeralScalarR),
      );

      // Shared secret derivation D_ecdh = 8 * a * R
      const keyDerivationBytes = MoneroCryptoUtils.generateKeyDerivation(
        txPublicKeyHex,
        moneroPrivateViewKey,
      );
      const outputScalar = MoneroCryptoUtils.deriveOutputScalar(keyDerivationBytes, outputIndex);
      outputScalarHex = MoneroCryptoUtils.bytesToHex(
        MoneroCryptoUtils.bigIntToBytesLE(outputScalar, 32),
      );

      // One-time stealth output key P_k = s_k * G + D_subaddr
      const sG = MoneroCryptoUtils.scalarMultBase(outputScalar);
      const subaddrSpendBytes = MoneroCryptoUtils.hexToBytes(
        subaddrKeys.subaddressPublicSpendKeyHex,
      );
      outputStealthKeyHex = MoneroCryptoUtils.bytesToHex(
        MoneroCryptoUtils.pointAdd(sG, subaddrSpendBytes),
      );

      // Encrypt 2.50 XMR in Piconero and compute Pedersen Commitment
      const amountPiconero = BigInt('2500000000000');
      encryptedAmountHex = RingCtVerifier.encryptRingCtAmount(amountPiconero, outputScalarHex);
      commitmentHex = RingCtVerifier.computePedersenCommitment(amountPiconero, outputScalarHex);
    });

    describe('Monero Layer 1: MoneroKeyValidator', () => {
      it('should approve valid torsion-free Ed25519 public keys', () => {
        expect(
          MoneroKeyValidator.validateTransactionKeys(
            txPublicKeyHex,
            outputStealthKeyHex,
            commitmentHex,
          ),
        ).toBe(true);
      });

      it('should reject identity or small-order torsion curve points', () => {
        const identityPointHex =
          '0100000000000000000000000000000000000000000000000000000000000000';
        expect(MoneroKeyValidator.isSafePublicKey(identityPointHex)).toBe(false);
        expect(MoneroKeyValidator.isSafePublicKey('invalid-hex')).toBe(false);
      });
    });

    describe('Monero Layer 2: MoneroTimelockValidator', () => {
      it('should approve standard unlocked transactions with no failure flags', () => {
        expect(
          MoneroTimelockValidator.isExecutionAndTimelockSafe({
            unlockTime: 0,
            doubleSpendSeen: false,
            failed: false,
          }),
        ).toBe(true);
      });

      it('should reject transactions flagged with double_spend_seen or failed', () => {
        expect(
          MoneroTimelockValidator.isExecutionAndTimelockSafe({
            unlockTime: 0,
            doubleSpendSeen: true,
          }),
        ).toBe(false);

        expect(
          MoneroTimelockValidator.isExecutionAndTimelockSafe({
            unlockTime: 0,
            failed: true,
          }),
        ).toBe(false);
      });

      it('should reject malicious future block or timestamp unlock_time values', () => {
        // Malicious future block lock
        expect(
          MoneroTimelockValidator.isExecutionAndTimelockSafe(
            { unlockTime: 3_500_000 },
            3_000_000,
          ),
        ).toBe(false);

        // Malicious future Unix timestamp lock (year 2100)
        expect(
          MoneroTimelockValidator.isExecutionAndTimelockSafe({
            unlockTime: 4_102_444_800,
          }),
        ).toBe(false);
      });
    });

    describe('Monero Layer 3: StealthOutputVerifier', () => {
      it('should cryptographically prove stealth output ownership for the target subaddress', () => {
        const result = StealthOutputVerifier.verifyOutputOwnership(
          txPublicKeyHex,
          outputStealthKeyHex,
          outputIndex,
          moneroPrivateViewKey,
          targetSubaddress,
        );

        expect(result.isOwned).toBe(true);
        expect(result.outputScalarHex).toBe(outputScalarHex);
      });

      it('should reject stealth output when checked against a different subaddress', () => {
        const otherSubaddress = CryptonoteEngine.generateAddress(
          moneroPublicSpendKey,
          moneroPrivateViewKey,
          5,
          Network.MONERO,
        );

        const result = StealthOutputVerifier.verifyOutputOwnership(
          txPublicKeyHex,
          outputStealthKeyHex,
          outputIndex,
          moneroPrivateViewKey,
          otherSubaddress,
        );

        expect(result.isOwned).toBe(false);
      });
    });

    describe('Monero Layer 4: RingCtVerifier', () => {
      it('should decrypt RingCT amount and validate Pedersen Commitment C = yG + bH', () => {
        const result = RingCtVerifier.verifyRingCtPayment(
          encryptedAmountHex,
          outputScalarHex,
          '2.50',
          commitmentHex,
        );

        expect(result.isValid).toBe(true);
        expect(result.decryptedAmountPiconero?.toString()).toBe('2500000000000');
      });

      it('should reject RingCT payment if decrypted amount is less than invoice requirement', () => {
        const result = RingCtVerifier.verifyRingCtPayment(
          encryptedAmountHex,
          outputScalarHex,
          '5.00',
          commitmentHex,
        );

        expect(result.isValid).toBe(false);
      });

      it('should reject RingCT payment if Pedersen Commitment is forged', () => {
        const forgedCommitment = MoneroCryptoUtils.bytesToHex(
          MoneroCryptoUtils.scalarMultBase(999n),
        );
        const result = RingCtVerifier.verifyRingCtPayment(
          encryptedAmountHex,
          outputScalarHex,
          '2.50',
          forgedCommitment,
        );

        expect(result.isValid).toBe(false);
      });
    });

    describe('Monero Layer 5 & MoneroAntiSpoofEngine Orchestrator', () => {
      let mockHttpClient: HttpClient;
      let moneroEngine: MoneroAntiSpoofEngine;
      let moneroInvoice: IInvoice;

      beforeEach(() => {
        mockHttpClient = new HttpClient();
        jest.spyOn(mockHttpClient, 'get').mockResolvedValue({
          data: { height: 3_200_015, status: 'OK' },
          status: 200,
          statusText: 'OK',
          headers: {},
          config: {},
        } as never);

        const config: IZeroPayConfig = {
          webhookSecret: 'test-secret',
          moneroPublicSpendKey,
          moneroPrivateViewKey,
        };
        moneroEngine = new MoneroAntiSpoofEngine(config, mockHttpClient);

        moneroInvoice = {
          id: 'monero-invoice-1',
          amount: '2.50',
          currency: Currency.XMR,
          network: Network.MONERO,
          receivingAddress: targetSubaddress,
          derivationIndex: 0,
          status: InvoiceStatus.PENDING,
          confirmations: 0,
          createdAt: Date.now(),
          expiresAt: Date.now() + 3600000,
        };
      });

      it('should approve a valid Monero transaction passing all 5 cryptographic layers', async () => {
        const validTx: IRawMoneroTransactionData = {
          transactionId: 'tx_xmr_valid_001',
          txPublicKeyHex,
          outputIndex,
          outputStealthKeyHex,
          encryptedAmountHex,
          commitmentHex,
          executionState: { unlockTime: 0, doubleSpendSeen: false },
          blockHeight: 3_200_005, // 11 confirmations at height 3,200,015
          inPool: false,
        };

        const result = await moneroEngine.verify(validTx, moneroInvoice, 10);
        expect(result.isValid).toBe(true);
        expect(result.confirmations).toBe(11);
        expect(result.decryptedAmountPiconero?.toString()).toBe('2500000000000');
      });

      it('should fail at Layer 5 if transaction confirmation depth is below requirement', async () => {
        const shallowBlockTx: IRawMoneroTransactionData = {
          transactionId: 'tx_xmr_shallow_002',
          txPublicKeyHex,
          outputIndex,
          outputStealthKeyHex,
          encryptedAmountHex,
          commitmentHex,
          executionState: { unlockTime: 0 },
          blockHeight: 3_200_014, // Only 2 confirmations
          inPool: false,
        };

        const validator = new MoneroFinalityValidator(
          'https://xmr-node.cakewallet.com:18081',
          mockHttpClient,
        );
        expect(await validator.isTransactionFinalized(3_200_014, 10)).toBe(false);

        const result = await moneroEngine.verify(shallowBlockTx, moneroInvoice, 10);
        expect(result.isValid).toBe(false);
        expect(result.layerFailed).toBe(5);
      });
    });
  });
});