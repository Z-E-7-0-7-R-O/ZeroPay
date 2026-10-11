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
});