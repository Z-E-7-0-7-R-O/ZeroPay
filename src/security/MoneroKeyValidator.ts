/**
 * src/security/MoneroKeyValidator.ts
 * Layer 1: Cryptographic curve-point and torsion-subgroup validation for Monero Ed25519 keys.
 */

import { MoneroCryptoUtils } from '../utils/moneroCrypto';

export class MoneroKeyValidator {
  /**
   * Verifies that a hexadecimal string represents a valid 32-byte compressed Ed25519 point
   * that is not the identity element and does not lie in a small-order torsion subgroup.
   *
   * @param publicKeyHex 64-character hexadecimal representation of the 32-byte point
   * @returns Boolean indicating whether the key is safe for CryptoNote ECDH operations
   */
  public static isSafePublicKey(publicKeyHex: string): boolean {
    if (!publicKeyHex || typeof publicKeyHex !== 'string') {
      return false;
    }

    const trimmed = publicKeyHex.trim().replace(/^0x/i, '');
    if (trimmed.length !== 64 || !/^[0-9a-fA-F]{64}$/.test(trimmed)) {
      return false;
    }

    try {
      const keyBytes = MoneroCryptoUtils.hexToBytes(trimmed);
      return MoneroCryptoUtils.isTorsionFreePublicKey(keyBytes);
    } catch {
      return false;
    }
  }

  /**
   * Verifies that a hexadecimal string represents a structurally valid 32-byte compressed
   * Ed25519 curve point (used for Pedersen Commitment points C_k).
   */
  public static isValidCommitmentPoint(commitmentHex: string): boolean {
    if (!commitmentHex || typeof commitmentHex !== 'string') {
      return false;
    }

    const trimmed = commitmentHex.trim().replace(/^0x/i, '');
    if (trimmed.length !== 64 || !/^[0-9a-fA-F]{64}$/.test(trimmed)) {
      return false;
    }

    try {
      const pointBytes = MoneroCryptoUtils.hexToBytes(trimmed);
      return MoneroCryptoUtils.isValidPublicKeyBytes(pointBytes);
    } catch {
      return false;
    }
  }

  /**
   * Validates all cryptographic curve points associated with an incoming Monero transaction output.
   *
   * @param txPublicKeyHex The transaction public key R from the extra field
   * @param outputStealthKeyHex The one-time output stealth public key P_k
   * @param commitmentHex Optional RingCT Pedersen Commitment C_k
   * @returns Boolean indicating complete Layer 1 curve integrity
   */
  public static validateTransactionKeys(
    txPublicKeyHex: string,
    outputStealthKeyHex: string,
    commitmentHex?: string,
  ): boolean {
    if (!this.isSafePublicKey(txPublicKeyHex)) {
      return false;
    }

    if (!this.isSafePublicKey(outputStealthKeyHex)) {
      return false;
    }

    if (commitmentHex !== undefined && !this.isValidCommitmentPoint(commitmentHex)) {
      return false;
    }

    return true;
  }
}