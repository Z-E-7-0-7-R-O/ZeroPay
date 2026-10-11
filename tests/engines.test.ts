/**
 * tests/engines.test.ts
 * Unit tests evaluating the cryptographic deterministic address derivation engines.
 */

import * as crypto from 'crypto';
import * as bitcoin from 'bitcoinjs-lib';
import { BIP32Factory } from 'bip32';
import * as ecc from 'tiny-secp256k1';

import { UtxoEngine } from '../src/engines/UtxoEngine';
import { TrvmEngine } from '../src/engines/TrvmEngine';
import { AddressGenerator } from '../src/engines/AddressGenerator';
import { CryptoUtils } from '../src/utils/crypto';
import { Network, IZeroPayConfig } from '../src/types';

const bip32 = BIP32Factory(ecc);

// Custom network parameters matching the internal engine definitions
const LITECOIN_NETWORK: bitcoin.Network = {
  messagePrefix: '\x19Litecoin Signed Message:\n',
  bech32: 'ltc',
  bip32: { public: 0x019da462, private: 0x019d9cfe },
  pubKeyHash: 0x30,
  scriptHash: 0x32,
  wif: 0xb0,
};

const DOGECOIN_NETWORK: bitcoin.Network = {
  messagePrefix: '\x19Dogecoin Signed Message:\n',
  bech32: '',
  bip32: { public: 0x02facafd, private: 0x02fac398 },
  pubKeyHash: 0x1e,
  scriptHash: 0x16,
  wif: 0x9e,
};

describe('Cryptographic Address Derivation Engines', () => {
  let ltcXpub: string;
  let dogeXpub: string;
  let tronXpub: string;

  beforeAll(() => {
    // Generate mathematically valid xPubs dynamically from cryptographic seed entropy
    const seed = crypto.randomBytes(64);
    
    // Litecoin Account xPub (Ltub prefix)
    const ltcMaster = bip32.fromSeed(seed, LITECOIN_NETWORK);
    const ltcAccount = ltcMaster.derivePath("m/84'/2'/0'");
    ltcXpub = ltcAccount.neutered().toBase58();

    // Dogecoin Account xPub (dgub prefix)
    const dogeMaster = bip32.fromSeed(seed, DOGECOIN_NETWORK);
    const dogeAccount = dogeMaster.derivePath("m/44'/3'/0'");
    dogeXpub = dogeAccount.neutered().toBase58();

    // TRON Account xPub (standard Bitcoin serialization format prefix 0x0488b21e)
    const tronMaster = bip32.fromSeed(seed);
    const tronAccount = tronMaster.derivePath("m/44'/195'/0'");
    tronXpub = tronAccount.neutered().toBase58();
  });

  describe('UtxoEngine', () => {
    it('should derive valid Native SegWit addresses for Litecoin', () => {
      const address0 = UtxoEngine.generateAddress(ltcXpub, 0, Network.LITECOIN);
      const address1 = UtxoEngine.generateAddress(ltcXpub, 1, Network.LITECOIN);

      expect(address0).toBeDefined();
      expect(address0.startsWith('ltc1')).toBe(true);
      expect(CryptoUtils.isValidLitecoinAddress(address0)).toBe(true);

      expect(address1).toBeDefined();
      expect(address1.startsWith('ltc1')).toBe(true);
      expect(address0).not.toEqual(address1); // Deterministic difference
    });

    it('should derive valid Legacy P2PKH addresses for Dogecoin', () => {
      const address0 = UtxoEngine.generateAddress(dogeXpub, 0, Network.DOGECOIN);
      const address1 = UtxoEngine.generateAddress(dogeXpub, 1, Network.DOGECOIN);

      expect(address0).toBeDefined();
      expect(address0.startsWith('D')).toBe(true);
      expect(address0.length).toBe(34);
      expect(CryptoUtils.isValidDogecoinAddress(address0)).toBe(true);

      expect(address1).toBeDefined();
      expect(address1.startsWith('D')).toBe(true);
      expect(address0).not.toEqual(address1);
    });

    it('should throw an error if an unsupported network is requested', () => {
      expect(() => {
        UtxoEngine.generateAddress(ltcXpub, 0, Network.TRON);
      }).toThrow('Unsupported network requested in UtxoEngine');
    });
  });

  describe('TrvmEngine', () => {
    it('should derive valid Base58Check addresses for TRON', () => {
      const address0 = TrvmEngine.generateAddress(tronXpub, 0, Network.TRON);
      const address1 = TrvmEngine.generateAddress(tronXpub, 1, Network.TRON);

      expect(address0).toBeDefined();
      expect(address0.startsWith('T')).toBe(true);
      expect(address0.length).toBe(34);
      expect(CryptoUtils.isValidTronAddress(address0)).toBe(true);

      expect(address1).toBeDefined();
      expect(address1.startsWith('T')).toBe(true);
      expect(CryptoUtils.isValidTronAddress(address1)).toBe(true);
      expect(address0).not.toEqual(address1);
    });

    it('should throw an error if a non-TRON network is passed to TrvmEngine', () => {
      expect(() => {
        TrvmEngine.generateAddress(tronXpub, 0, Network.LITECOIN);
      }).toThrow('Unsupported network requested in TrvmEngine');
    });
  });

  describe('AddressGenerator Facade', () => {
    it('should route derivation requests correctly across all supported networks', () => {
      const config: IZeroPayConfig = {
        xpubLitecoin: ltcXpub,
        xpubDogecoin: dogeXpub,
        xpubTron: tronXpub,
        webhookSecret: 'test-secret',
      };

      const ltcAddress = AddressGenerator.generate(config, Network.LITECOIN, 0);
      const dogeAddress = AddressGenerator.generate(config, Network.DOGECOIN, 0);
      const tronAddress = AddressGenerator.generate(config, Network.TRON, 0);

      expect(ltcAddress.startsWith('ltc1')).toBe(true);
      expect(dogeAddress.startsWith('D')).toBe(true);
      expect(tronAddress.startsWith('T')).toBe(true);
    });

    it('should throw explicit error when an xPub is missing from the configuration', () => {
      const incompleteConfig: IZeroPayConfig = {
        webhookSecret: 'test-secret',
      };

      expect(() => {
        AddressGenerator.generate(incompleteConfig, Network.LITECOIN, 0);
      }).toThrow('Litecoin xPub is missing in the configuration.');
    });
  });

  describe('Checkpoint Alpha: Mathematical Collision Resistance', () => {
    it('should derive 100 consecutive TRON addresses with 100% uniqueness', () => {
      const generatedAddresses = new Set<string>();
      const totalCount = 100;

      for (let index = 0; index < totalCount; index++) {
        const address = TrvmEngine.generateAddress(tronXpub, index, Network.TRON);
        generatedAddresses.add(address);
      }

      // If any collision occurred, Set size would be strictly less than totalCount
      expect(generatedAddresses.size).toBe(totalCount);
    });
  });
});