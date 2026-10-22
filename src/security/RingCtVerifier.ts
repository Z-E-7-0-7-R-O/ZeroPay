/**
 * src/security/RingCtVerifier.ts
 * Layer 4: RingCT ECDH amount decryption, Piconero sufficiency verification,
 * and Pedersen Commitment (C = yG + bH) mathematical validation.
 */

import { MoneroCryptoUtils } from '../utils/moneroCrypto';

export interface IRingCtVerificationResult {
  isValid: boolean;
  decryptedAmountPiconero?: bigint;
  computedCommitmentHex?: string;
}

export class RingCtVerifier {
  /**
   * 6-byte ASCII domain prefix "amount" used in Monero RingCT ecdhHash.
   */
  private static readonly AMOUNT_DOMAIN_PREFIX: Uint8Array = new Uint8Array([
    0x61, 0x6d, 0x6f, 0x75, 0x6e, 0x74,
  ]);

  /**
   * 15-byte ASCII domain prefix "commitment_mask" used in Monero RingCT genCommitmentMask.
   */
  private static readonly COMMITMENT_MASK_DOMAIN_PREFIX: Uint8Array = new Uint8Array([
    0x63, 0x6f, 0x6d, 0x6d, 0x69, 0x74, 0x6d, 0x65, 0x6e, 0x74, 0x5f, 0x6d, 0x61, 0x73, 0x6b,
  ]);

  /**
   * Decrypts the 8-byte RingCT encrypted amount from ecdhInfo using the derived output scalar s_k.
   *
   * @param encryptedAmountHex 16-character (8-byte) or 64-character (32-byte) hex string from ecdhInfo.amount
   * @param outputScalarHex 64-character (32-byte) hex string representing s_k = H_s(8aR || varint(k))
   * @returns The decrypted amount in Piconero as a BigInt
   */
  public static decryptRingCtAmount(encryptedAmountHex: string, outputScalarHex: string): bigint {
    const encryptedBytes = MoneroCryptoUtils.hexToBytes(encryptedAmountHex);
    if (encryptedBytes.length !== 8 && encryptedBytes.length !== 32) {
      throw new Error('Encrypted RingCT amount must be 8 bytes (v2) or 32 bytes (v1).');
    }

    const scalarBytes = MoneroCryptoUtils.hexToBytes(outputScalarHex);
    if (scalarBytes.length !== 32) {
      throw new Error('Output scalar must be 32 bytes.');
    }

    // mask = Keccak256("amount" || s_k)
    const hashInput = MoneroCryptoUtils.concatBytes(this.AMOUNT_DOMAIN_PREFIX, scalarBytes);
    const amountMask = MoneroCryptoUtils.keccak256(hashInput);

    // XOR the first 8 bytes (64-bit unsigned Little-Endian integer)
    const decrypted8Bytes = new Uint8Array(8);
    for (let i = 0; i < 8; i++) {
      decrypted8Bytes[i] = encryptedBytes[i] ^ amountMask[i];
    }

    return MoneroCryptoUtils.bytesToBigIntLE(decrypted8Bytes);
  }

  /**
   * Encrypts a Piconero amount using the output scalar s_k (symmetric XOR).
   * Useful for deterministic test vector construction and verification.
   */
  public static encryptRingCtAmount(amountPiconero: bigint, outputScalarHex: string): string {
    if (amountPiconero < 0n || amountPiconero > 0xffffffffffffffffn) {
      throw new Error('Piconero amount must fit within an unsigned 64-bit integer.');
    }

    const scalarBytes = MoneroCryptoUtils.hexToBytes(outputScalarHex);
    if (scalarBytes.length !== 32) {
      throw new Error('Output scalar must be 32 bytes.');
    }

    const hashInput = MoneroCryptoUtils.concatBytes(this.AMOUNT_DOMAIN_PREFIX, scalarBytes);
    const amountMask = MoneroCryptoUtils.keccak256(hashInput);
    const amountBytes = MoneroCryptoUtils.bigIntToBytesLE(amountPiconero, 8);

    const encrypted8Bytes = new Uint8Array(8);
    for (let i = 0; i < 8; i++) {
      encrypted8Bytes[i] = amountBytes[i] ^ amountMask[i];
    }

    return MoneroCryptoUtils.bytesToHex(encrypted8Bytes);
  }

  /**
   * Computes the deterministic RingCT Pedersen Commitment C_k = y_k * G + b * H
   * where y_k = H_s("commitment_mask" || s_k) and b is the amount in Piconero.
   */
  public static computePedersenCommitment(amountPiconero: bigint, outputScalarHex: string): string {
    const scalarBytes = MoneroCryptoUtils.hexToBytes(outputScalarHex);
    if (scalarBytes.length !== 32) {
      throw new Error('Output scalar must be 32 bytes.');
    }

    // y_k = H_s("commitment_mask" || s_k)
    const maskInput = MoneroCryptoUtils.concatBytes(
      this.COMMITMENT_MASK_DOMAIN_PREFIX,
      scalarBytes,
    );
    const blindingFactorY = MoneroCryptoUtils.hashToScalar(maskInput);

    // y_k * G
    const yG = MoneroCryptoUtils.scalarMultBase(blindingFactorY);

    if (amountPiconero === 0n) {
      return MoneroCryptoUtils.bytesToHex(yG);
    }

    // b * H
    const pointHBytes = MoneroCryptoUtils.hexToBytes(MoneroCryptoUtils.PEDERSEN_H_POINT_HEX);
    const bH = MoneroCryptoUtils.scalarMultPoint(pointHBytes, amountPiconero);

    // C_k = y_k * G + b * H
    const commitmentBytes = MoneroCryptoUtils.pointAdd(yG, bH);
    return MoneroCryptoUtils.bytesToHex(commitmentBytes);
  }

  /**
   * Decrypts the RingCT amount, checks sufficiency against the invoice amount,
   * and verifies the Pedersen Commitment if provided.
   *
   * @param encryptedAmountHex Encrypted amount hex from ecdhInfo
   * @param outputScalarHex Derived output scalar s_k in hex
   * @param expectedAmountXmr Invoice amount string in XMR (e.g. "1.25")
   * @param providedCommitmentHex Optional on-chain Pedersen Commitment C_k to verify against
   */
  public static verifyRingCtPayment(
    encryptedAmountHex: string,
    outputScalarHex: string,
    expectedAmountXmr: string,
    providedCommitmentHex?: string,
  ): IRingCtVerificationResult {
    try {
      const decryptedAmountPiconero = this.decryptRingCtAmount(encryptedAmountHex, outputScalarHex);
      const expectedPiconero = MoneroCryptoUtils.parseDecimalToUnits(
        expectedAmountXmr,
        MoneroCryptoUtils.PICONERO_DECIMALS,
      );

      if (decryptedAmountPiconero < expectedPiconero) {
        return {
          isValid: false,
          decryptedAmountPiconero,
        };
      }

      const computedCommitmentHex = this.computePedersenCommitment(
        decryptedAmountPiconero,
        outputScalarHex,
      );

      if (providedCommitmentHex !== undefined) {
        const cleanProvided = providedCommitmentHex.trim().replace(/^0x/i, '').toLowerCase();
        if (cleanProvided !== computedCommitmentHex) {
          return {
            isValid: false,
            decryptedAmountPiconero,
            computedCommitmentHex,
          };
        }
      }

      return {
        isValid: true,
        decryptedAmountPiconero,
        computedCommitmentHex,
      };
    } catch {
      return { isValid: false };
    }
  }
}