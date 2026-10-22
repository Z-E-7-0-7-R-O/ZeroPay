/**
 * src/security/StealthOutputVerifier.ts
 * Layer 3: Elliptic Curve Diffie-Hellman (ECDH) stealth output ownership verification.
 */

import { MoneroCryptoUtils } from '../utils/moneroCrypto';

export interface IStealthOwnershipResult {
  isOwned: boolean;
  keyDerivationHex?: string;
  outputScalarHex?: string;
  outputScalarBigInt?: bigint;
  recoveredSpendKeyHex?: string;
}

export class StealthOutputVerifier {
  /**
   * Cryptographically verifies whether a Monero transaction output at a specific index
   * is addressed to the expected invoice subaddress.
   *
   * Mathematical proof:
   *   1. D_ecdh = 8 * a * R
   *   2. s_k = H_s(D_ecdh || varint(k))
   *   3. D_recovered = P_k - s_k * G
   *   4. Verify D_recovered == D_subaddress
   *
   * @param txPublicKeyHex The 32-byte transaction public key R in hex
   * @param outputStealthKeyHex The 32-byte one-time output stealth key P_k in hex
   * @param outputIndex The zero-based index k of the output in the transaction's vout array
   * @param privateViewKeyHex The merchant's 32-byte private view key a in hex
   * @param expectedSubaddress The 95-character Monero subaddress generated for the invoice
   */
  public static verifyOutputOwnership(
    txPublicKeyHex: string,
    outputStealthKeyHex: string,
    outputIndex: number,
    privateViewKeyHex: string,
    expectedSubaddress: string,
  ): IStealthOwnershipResult {
    if (!Number.isInteger(outputIndex) || outputIndex < 0) {
      return { isOwned: false };
    }

    try {
      // Decode expected subaddress to extract its 32-byte Public Spend Key D
      const decodedAddress = MoneroCryptoUtils.decodeMoneroAddress(expectedSubaddress);
      const expectedSpendKeyHex = MoneroCryptoUtils.bytesToHex(decodedAddress.publicSpendKey);

      // Compute ECDH shared secret point: D_ecdh = 8 * a * R
      const keyDerivationBytes = MoneroCryptoUtils.generateKeyDerivation(
        txPublicKeyHex,
        privateViewKeyHex,
      );

      // Compute per-output scalar: s_k = H_s(D_ecdh || varint(outputIndex))
      const outputScalarBigInt = MoneroCryptoUtils.deriveOutputScalar(
        keyDerivationBytes,
        outputIndex,
      );
      const outputScalarBytes = MoneroCryptoUtils.bigIntToBytesLE(outputScalarBigInt, 32);

      // Compute s_k * G
      const scalarBasePoint = MoneroCryptoUtils.scalarMultBase(outputScalarBigInt);

      // Compute recovered spend key: D_recovered = P_k - s_k * G
      const outputStealthKeyBytes = MoneroCryptoUtils.hexToBytes(outputStealthKeyHex);
      const recoveredSpendKeyBytes = MoneroCryptoUtils.pointSubtract(
        outputStealthKeyBytes,
        scalarBasePoint,
      );
      const recoveredSpendKeyHex = MoneroCryptoUtils.bytesToHex(recoveredSpendKeyBytes);

      const isOwned = recoveredSpendKeyHex === expectedSpendKeyHex;

      return {
        isOwned,
        keyDerivationHex: MoneroCryptoUtils.bytesToHex(keyDerivationBytes),
        outputScalarHex: MoneroCryptoUtils.bytesToHex(outputScalarBytes),
        outputScalarBigInt,
        recoveredSpendKeyHex,
      };
    } catch {
      return { isOwned: false };
    }
  }
}