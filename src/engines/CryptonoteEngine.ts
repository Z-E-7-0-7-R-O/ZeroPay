/**
 * src/engines/CryptonoteEngine.ts
 * Cryptographic engine for deterministic, offline generation of Monero (XMR) Subaddresses
 * and Primary Addresses using Ed25519 curve arithmetic and Keccak-256 scalar derivation.
 */

import { Network } from '../types';
import { MoneroCryptoUtils } from '../utils/moneroCrypto';

export interface IMoneroSubaddressKeys {
  address: string;
  majorIndex: number;
  minorIndex: number;
  scalarTweakHex: string;
  subaddressPublicSpendKeyHex: string;
  subaddressPublicViewKeyHex: string;
}

export class CryptonoteEngine {
  /**
   * Constant 8-byte domain separator "SubAddr\0" specified in the Monero protocol
   * for deterministic subaddress scalar tweak derivation.
   */
  private static readonly SUBADDRESS_DOMAIN_PREFIX: Uint8Array = new Uint8Array([
    0x53, 0x75, 0x62, 0x41, 0x64, 0x64, 0x72, 0x00,
  ]);

  /**
   * Generates a unique 95-character Monero Mainnet Subaddress (starting with '8')
   * for a specific invoice derivation index.
   *
   * @param publicSpendKeyHex The merchant's 32-byte Public Spend Key B (64 hex chars)
   * @param privateViewKeyHex The merchant's 32-byte Private View Key a (64 hex chars)
   * @param index The zero-based invoice derivation index (mapped to Minor Index = index + 1)
   * @param targetNetwork Must be Network.MONERO
   * @returns The Base58-encoded Monero Subaddress
   */
  public static generateAddress(
    publicSpendKeyHex: string,
    privateViewKeyHex: string,
    index: number,
    targetNetwork: Network,
  ): string {
    return this.generateSubaddress(publicSpendKeyHex, privateViewKeyHex, index, targetNetwork);
  }

  /**
   * Generates a deterministic Monero Subaddress for the specified invoice index.
   */
  public static generateSubaddress(
    publicSpendKeyHex: string,
    privateViewKeyHex: string,
    index: number,
    targetNetwork: Network,
  ): string {
    if (targetNetwork !== Network.MONERO) {
      throw new Error(`Unsupported network requested in CryptonoteEngine: ${targetNetwork}`);
    }

    const derived = this.deriveSubaddressKeys(publicSpendKeyHex, privateViewKeyHex, index, 0);
    return derived.address;
  }

  /**
   * Derives the full set of cryptographic keys and address string for a Monero Subaddress.
   * Implements:
   *   m = H_s("SubAddr\0" || a || uint32_le(majorIndex) || uint32_le(minorIndex))
   *   D = B + mG
   *   C = a * D
   *
   * @param publicSpendKeyHex 32-byte Public Spend Key B in hexadecimal
   * @param privateViewKeyHex 32-byte Private View Key a in hexadecimal
   * @param index Invoice derivation index (0, 1, 2, ...), mapped to minorIndex = index + 1
   * @param majorAccountIndex Monero account index (defaults to 0)
   */
  public static deriveSubaddressKeys(
    publicSpendKeyHex: string,
    privateViewKeyHex: string,
    index: number,
    majorAccountIndex: number = 0,
  ): IMoneroSubaddressKeys {
    if (!Number.isInteger(index) || index < 0) {
      throw new Error('Derivation index must be a non-negative integer.');
    }

    if (!Number.isInteger(majorAccountIndex) || majorAccountIndex < 0) {
      throw new Error('Major account index must be a non-negative integer.');
    }

    try {
      const publicSpendKeyBytes = MoneroCryptoUtils.hexToBytes(publicSpendKeyHex);
      const privateViewKeyBytes = MoneroCryptoUtils.hexToBytes(privateViewKeyHex);

      if (publicSpendKeyBytes.length !== 32 || privateViewKeyBytes.length !== 32) {
        throw new Error('Monero public spend key and private view key must each be 32 bytes.');
      }

      if (!MoneroCryptoUtils.isTorsionFreePublicKey(publicSpendKeyBytes)) {
        throw new Error(
          'Provided Monero public spend key is invalid or lies in a small-order subgroup.',
        );
      }

      const viewKeyScalar = MoneroCryptoUtils.scReduce32ToBigInt(privateViewKeyBytes);
      if (viewKeyScalar === 0n) {
        throw new Error('Provided Monero private view key reduces to a zero scalar.');
      }

      const canonicalViewKeyBytes = MoneroCryptoUtils.bigIntToBytesLE(viewKeyScalar, 32);

      // In Monero, (0, 0) is reserved for the Primary Address ('4...').
      // Invoice-specific subaddresses are derived starting at minorIndex = index + 1.
      const majorIndex = majorAccountIndex;
      const minorIndex = index + 1;

      const majorIndexBytes = MoneroCryptoUtils.encodeUint32LE(majorIndex);
      const minorIndexBytes = MoneroCryptoUtils.encodeUint32LE(minorIndex);

      // Construct 48-byte input: "SubAddr\0" (8B) || a (32B) || major (4B) || minor (4B)
      const derivationInput = MoneroCryptoUtils.concatBytes(
        this.SUBADDRESS_DOMAIN_PREFIX,
        canonicalViewKeyBytes,
        majorIndexBytes,
        minorIndexBytes,
      );

      // m = H_s(derivationInput)
      const scalarTweakM = MoneroCryptoUtils.hashToScalar(derivationInput);
      const scalarTweakBytes = MoneroCryptoUtils.bigIntToBytesLE(scalarTweakM, 32);

      // mG = m * G
      const mGPoint = MoneroCryptoUtils.scalarMultBase(scalarTweakM);

      // D = B + mG (Subaddress Public Spend Key)
      const subaddressSpendKeyD = MoneroCryptoUtils.pointAdd(publicSpendKeyBytes, mGPoint);

      // C = a * D (Subaddress Public View Key)
      const subaddressViewKeyC = MoneroCryptoUtils.scalarMultPoint(
        subaddressSpendKeyD,
        viewKeyScalar,
      );

      const subaddress = MoneroCryptoUtils.encodeMoneroAddress(
        MoneroCryptoUtils.MAINNET_SUBADDRESS_PREFIX,
        subaddressSpendKeyD,
        subaddressViewKeyC,
      );

      if (!subaddress.startsWith('8') || subaddress.length !== 95) {
        throw new Error('Derived Monero subaddress failed structural prefix or length check.');
      }

      return {
        address: subaddress,
        majorIndex,
        minorIndex,
        scalarTweakHex: MoneroCryptoUtils.bytesToHex(scalarTweakBytes),
        subaddressPublicSpendKeyHex: MoneroCryptoUtils.bytesToHex(subaddressSpendKeyD),
        subaddressPublicViewKeyHex: MoneroCryptoUtils.bytesToHex(subaddressViewKeyC),
      };
    } catch (error) {
      const errMessage =
        error instanceof Error ? error.message : 'Unknown Monero cryptographic exception';
      throw new Error(`Monero subaddress generation failed: ${errMessage}`);
    }
  }

  /**
   * Generates the merchant's 95-character Primary Monero Address (starting with '4')
   * corresponding to index (0, 0) from the Public Spend Key B and Private View Key a.
   */
  public static generatePrimaryAddress(
    publicSpendKeyHex: string,
    privateViewKeyHex: string,
  ): string {
    const publicSpendKeyBytes = MoneroCryptoUtils.hexToBytes(publicSpendKeyHex);
    const privateViewKeyBytes = MoneroCryptoUtils.hexToBytes(privateViewKeyHex);

    if (publicSpendKeyBytes.length !== 32 || privateViewKeyBytes.length !== 32) {
      throw new Error('Monero public spend key and private view key must each be 32 bytes.');
    }

    if (!MoneroCryptoUtils.isTorsionFreePublicKey(publicSpendKeyBytes)) {
      throw new Error('Provided Monero public spend key is invalid.');
    }

    const viewKeyScalar = MoneroCryptoUtils.scReduce32ToBigInt(privateViewKeyBytes);
    if (viewKeyScalar === 0n) {
      throw new Error('Provided Monero private view key reduces to a zero scalar.');
    }

    // Primary Public View Key A = a * G
    const publicViewKeyBytes = MoneroCryptoUtils.scalarMultBase(viewKeyScalar);

    return MoneroCryptoUtils.encodeMoneroAddress(
      MoneroCryptoUtils.MAINNET_PRIMARY_ADDRESS_PREFIX,
      publicSpendKeyBytes,
      publicViewKeyBytes,
    );
  }
}