/**
 * src/utils/crypto.ts
 * Cryptographic utility functions for hashing, timing-safe verification, and address validation.
 */

import * as crypto from 'crypto';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const TronWeb = require('tronweb');

export class CryptoUtils {
  /**
   * Validates an HMAC-SHA256 signature using timing-safe byte comparison
   * to eliminate vulnerabilities to side-channel timing attacks.
   * 
   * @param payload The serialized JSON payload received in the webhook request body
   * @param signature The hexadecimal signature provided in the HTTP header
   * @param secret The merchant's shared secret key
   * @returns Boolean indicating whether the payload authenticity is confirmed
   */
  public static verifyHmacSignature(payload: string, signature: string, secret: string): boolean {
    if (!payload || !signature || !secret) {
      return false;
    }

    try {
      const computedSignature = crypto
        .createHmac('sha256', secret)
        .update(payload)
        .digest('hex');

      const signatureBuffer = Buffer.from(signature, 'hex');
      const computedBuffer = Buffer.from(computedSignature, 'hex');

      // Buffers must have identical length for timingSafeEqual execution
      if (signatureBuffer.length !== computedBuffer.length) {
        return false;
      }

      return crypto.timingSafeEqual(signatureBuffer, computedBuffer);
    } catch {
      return false;
    }
  }

  /**
   * Calculates a standard SHA-256 hash representation.
   */
  public static sha256(data: string | Buffer): string {
    return crypto.createHash('sha256').update(data).digest('hex');
  }

  /**
   * Computes a double SHA-256 hash (HASH256), a cryptographic primitive used in UTXO consensus.
   */
  public static doubleSha256(data: Buffer): Buffer {
    const firstDigest = crypto.createHash('sha256').update(data).digest();
    return crypto.createHash('sha256').update(firstDigest).digest();
  }

  /**
   * Validates the structural integrity and Base58Check checksum of a TRON address.
   */
  public static isValidTronAddress(address: string): boolean {
    if (!address || typeof address !== 'string') {
      return false;
    }

    // TRON mainnet addresses strictly start with 'T' and span 34 characters
    if (!address.startsWith('T') || address.length !== 34) {
      return false;
    }

    try {
      return TronWeb.isAddress(address);
    } catch {
      return false;
    }
  }

  /**
   * Validates standard address formats for Litecoin (Native SegWit Bech32 or Legacy Base58).
   */
  public static isValidLitecoinAddress(address: string): boolean {
    if (!address || typeof address !== 'string') {
      return false;
    }

    // Native SegWit: starts with 'ltc1'
    if (address.startsWith('ltc1')) {
      return address.length >= 42 && address.length <= 64;
    }

    // Legacy / P2SH: starts with 'L' or 'M'
    if (address.startsWith('L') || address.startsWith('M')) {
      return address.length === 34;
    }

    return false;
  }

  /**
   * Validates standard address format for Dogecoin (Legacy P2PKH Base58).
   */
  public static isValidDogecoinAddress(address: string): boolean {
    if (!address || typeof address !== 'string') {
      return false;
    }

    // Dogecoin P2PKH addresses start with 'D' and span 34 characters
    if (address.startsWith('D')) {
      return address.length === 34;
    }

    return false;
  }
}