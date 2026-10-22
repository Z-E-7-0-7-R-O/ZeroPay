/**
 * src/utils/moneroCrypto.ts
 * Low-level cryptographic primitives for the Monero (CryptoNote / RingCT) protocol.
 * Implements Block-Based Monero Base58, Ed25519 scalar/point arithmetic, Keccak-256 hashing,
 * ECDH key derivation, and deterministic Piconero unit conversion.
 */

import { ed25519 } from '@noble/curves/ed25519';
import { keccak_256 } from '@noble/hashes/sha3';

export interface IDecodedMoneroAddress {
  prefix: number;
  publicSpendKey: Uint8Array;
  publicViewKey: Uint8Array;
  paymentId?: Uint8Array;
  isSubaddress: boolean;
  isIntegrated: boolean;
}

export class MoneroCryptoUtils {
  /**
   * Ed25519 prime subgroup order l = 2^252 + 27742317777372353535851937790883648493
   */
  public static readonly ED25519_CURVE_ORDER: bigint = BigInt(
    '7237005577332262213973186563042994240857116359379907606001950938285454250989',
  );

  /**
   * Official Monero Mainnet Network Prefix Bytes
   */
  public static readonly MAINNET_PRIMARY_ADDRESS_PREFIX: number = 0x12; // 18 (Starts with '4')
  public static readonly MAINNET_INTEGRATED_ADDRESS_PREFIX: number = 0x13; // 19 (Starts with '4')
  public static readonly MAINNET_SUBADDRESS_PREFIX: number = 0x2a; // 42 (Starts with '8')

  /**
   * Monero RingCT Pedersen Commitment secondary generator point H (compressed Ed25519 point)
   * H = 8 * toPoint(keccak256(toBytes(G)))
   */
  public static readonly PEDERSEN_H_POINT_HEX: string =
    '8b655970153799af2aeadc9ff1add0ea6c7251d54154cfa92c173a0dd39c1f94';

  /**
   * Monero atomic unit precision: 1 XMR = 10^12 Piconero
   */
  public static readonly PICONERO_DECIMALS: number = 12;

  private static readonly BASE58_ALPHABET: string =
    '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

  private static readonly FULL_BLOCK_SIZE: number = 8;
  private static readonly FULL_ENCODED_BLOCK_SIZE: number = 11;

  /**
   * Lookup table mapping raw byte block lengths (0..8) to Monero Base58 character lengths.
   */
  private static readonly ENCODED_BLOCK_SIZES: readonly number[] = [0, 2, 3, 5, 6, 7, 9, 10, 11];

  /**
   * Converts a hexadecimal string into a Uint8Array.
   */
  public static hexToBytes(hex: string): Uint8Array {
    if (typeof hex !== 'string') {
      throw new Error('Input must be a hexadecimal string.');
    }
    const cleanHex = hex.trim().replace(/^0x/i, '');
    if (cleanHex.length === 0 || cleanHex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(cleanHex)) {
      throw new Error('Invalid hexadecimal string format.');
    }
    return new Uint8Array(Buffer.from(cleanHex, 'hex'));
  }

  /**
   * Converts a Uint8Array into a lowercase hexadecimal string.
   */
  public static bytesToHex(bytes: Uint8Array): string {
    return Buffer.from(bytes).toString('hex').toLowerCase();
  }

  /**
   * Concatenates multiple Uint8Array buffers into a single contiguous Uint8Array.
   */
  public static concatBytes(...arrays: Uint8Array[]): Uint8Array {
    const totalLength = arrays.reduce((acc, arr) => acc + arr.length, 0);
    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const arr of arrays) {
      result.set(arr, offset);
      offset += arr.length;
    }
    return result;
  }

  /**
   * Interprets a byte array as an unsigned Little-Endian BigInt.
   */
  public static bytesToBigIntLE(bytes: Uint8Array): bigint {
    let result = 0n;
    for (let i = bytes.length - 1; i >= 0; i--) {
      result = (result << 8n) + BigInt(bytes[i]);
    }
    return result;
  }

  /**
   * Serializes an unsigned BigInt into a Little-Endian byte array of fixed length.
   */
  public static bigIntToBytesLE(value: bigint, length: number = 32): Uint8Array {
    if (value < 0n) {
      throw new Error('Cannot serialize negative BigInt to unsigned Little-Endian bytes.');
    }
    const bytes = new Uint8Array(length);
    let temp = value;
    for (let i = 0; i < length; i++) {
      bytes[i] = Number(temp & 0xffn);
      temp >>= 8n;
    }
    return bytes;
  }

  /**
   * Interprets a byte array as an unsigned Big-Endian BigInt.
   */
  public static bytesToBigIntBE(bytes: Uint8Array): bigint {
    let result = 0n;
    for (let i = 0; i < bytes.length; i++) {
      result = (result << 8n) + BigInt(bytes[i]);
    }
    return result;
  }

  /**
   * Serializes an unsigned BigInt into a Big-Endian byte array of fixed length.
   */
  public static bigIntToBytesBE(value: bigint, length: number): Uint8Array {
    if (value < 0n) {
      throw new Error('Cannot serialize negative BigInt to unsigned Big-Endian bytes.');
    }
    const bytes = new Uint8Array(length);
    let temp = value;
    for (let i = length - 1; i >= 0; i--) {
      bytes[i] = Number(temp & 0xffn);
      temp >>= 8n;
    }
    return bytes;
  }

  /**
   * Computes the original Keccak-256 digest used throughout the Monero protocol.
   */
  public static keccak256(data: Uint8Array): Uint8Array {
    return keccak_256(data);
  }

  /**
   * Reduces a 32-byte Little-Endian integer modulo the Ed25519 curve order l (sc_reduce32).
   */
  public static scReduce32ToBigInt(bytes: Uint8Array): bigint {
    if (bytes.length !== 32) {
      throw new Error('scReduce32 requires an exact 32-byte input buffer.');
    }
    const rawInt = this.bytesToBigIntLE(bytes);
    return rawInt % this.ED25519_CURVE_ORDER;
  }

  /**
   * Reduces a 32-byte buffer modulo l and returns the 32-byte Little-Endian representation.
   */
  public static scReduce32(bytes: Uint8Array): Uint8Array {
    const reduced = this.scReduce32ToBigInt(bytes);
    return this.bigIntToBytesLE(reduced, 32);
  }

  /**
   * Monero H_s(data) function: Keccak-256 followed by sc_reduce32.
   */
  public static hashToScalar(data: Uint8Array): bigint {
    const digest = this.keccak256(data);
    return this.scReduce32ToBigInt(digest);
  }

  /**
   * Monero H_s(data) returning a 32-byte Little-Endian scalar buffer.
   */
  public static hashToScalarBytes(data: Uint8Array): Uint8Array {
    const scalar = this.hashToScalar(data);
    return this.bigIntToBytesLE(scalar, 32);
  }

  /**
   * Encodes a non-negative integer into CryptoNote Variable-Length Integer (VarInt) format.
   */
  public static encodeVarInt(value: number | bigint): Uint8Array {
    let v = BigInt(value);
    if (v < 0n) {
      throw new Error('VarInt encoding requires a non-negative integer.');
    }
    const bytes: number[] = [];
    while (v >= 0x80n) {
      bytes.push(Number((v & 0x7fn) | 0x80n));
      v >>= 7n;
    }
    bytes.push(Number(v));
    return new Uint8Array(bytes);
  }

  /**
   * Encodes an unsigned 32-bit integer into a 4-byte Little-Endian Uint8Array.
   */
  public static encodeUint32LE(value: number): Uint8Array {
    if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
      throw new Error('Value out of bounds for unsigned 32-bit integer.');
    }
    const buffer = Buffer.alloc(4);
    buffer.writeUInt32LE(value >>> 0, 0);
    return new Uint8Array(buffer);
  }

  /**
   * Checks whether a 32-byte buffer represents a valid compressed point on the Ed25519 curve.
   */
  public static isValidPublicKeyBytes(pubkeyBytes: Uint8Array): boolean {
    if (!pubkeyBytes || pubkeyBytes.length !== 32) {
      return false;
    }
    try {
      ed25519.ExtendedPoint.fromHex(pubkeyBytes);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Verifies that a 32-byte public key is on the Ed25519 curve and is not a small-order torsion point.
   */
  public static isTorsionFreePublicKey(pubkeyBytes: Uint8Array): boolean {
    if (!pubkeyBytes || pubkeyBytes.length !== 32) {
      return false;
    }
    try {
      const point = ed25519.ExtendedPoint.fromHex(pubkeyBytes);
      if (point.equals(ed25519.ExtendedPoint.ZERO)) {
        return false;
      }
      return !point.isSmallOrder();
    } catch {
      return false;
    }
  }

  /**
   * Multiplies the Ed25519 base point G by a scalar modulo l: R = s * G.
   */
  public static scalarMultBase(scalar: bigint): Uint8Array {
    const normScalar =
      ((scalar % this.ED25519_CURVE_ORDER) + this.ED25519_CURVE_ORDER) % this.ED25519_CURVE_ORDER;
    if (normScalar === 0n) {
      return ed25519.ExtendedPoint.ZERO.toRawBytes();
    }
    return ed25519.ExtendedPoint.BASE.multiply(normScalar).toRawBytes();
  }

  /**
   * Multiplies an arbitrary compressed Ed25519 point P by a scalar modulo l: R = s * P.
   */
  public static scalarMultPoint(pointBytes: Uint8Array, scalar: bigint): Uint8Array {
    const point = ed25519.ExtendedPoint.fromHex(pointBytes);
    const normScalar =
      ((scalar % this.ED25519_CURVE_ORDER) + this.ED25519_CURVE_ORDER) % this.ED25519_CURVE_ORDER;
    if (normScalar === 0n) {
      return ed25519.ExtendedPoint.ZERO.toRawBytes();
    }
    return point.multiply(normScalar).toRawBytes();
  }

  /**
   * Adds two compressed Ed25519 points: R = A + B.
   */
  public static pointAdd(pointABytes: Uint8Array, pointBBytes: Uint8Array): Uint8Array {
    const pointA = ed25519.ExtendedPoint.fromHex(pointABytes);
    const pointB = ed25519.ExtendedPoint.fromHex(pointBBytes);
    return pointA.add(pointB).toRawBytes();
  }

  /**
   * Subtracts compressed Ed25519 point B from point A: R = A - B.
   */
  public static pointSubtract(pointABytes: Uint8Array, pointBBytes: Uint8Array): Uint8Array {
    const pointA = ed25519.ExtendedPoint.fromHex(pointABytes);
    const pointB = ed25519.ExtendedPoint.fromHex(pointBBytes);
    return pointA.subtract(pointB).toRawBytes();
  }

  /**
   * Computes Monero ECDH key derivation: D_ecdh = 8 * a * R.
   *
   * @param txPublicKeyHex 32-byte transaction public key R in hex
   * @param privateKeyHex 32-byte private key (e.g., merchant private view key a) in hex
   * @returns 32-byte compressed point representing 8aR
   */
  public static generateKeyDerivation(txPublicKeyHex: string, privateKeyHex: string): Uint8Array {
    const txPubBytes = this.hexToBytes(txPublicKeyHex);
    const privBytes = this.hexToBytes(privateKeyHex);
    if (txPubBytes.length !== 32 || privBytes.length !== 32) {
      throw new Error('Monero key derivation requires 32-byte public and private keys.');
    }

    const pointR = ed25519.ExtendedPoint.fromHex(txPubBytes);
    const scalarA = this.scReduce32ToBigInt(privBytes);
    if (scalarA === 0n) {
      throw new Error('Private key scalar cannot be zero.');
    }

    // Multiply by scalarA and clear cofactor (multiply by 8) per CryptoNote generate_key_derivation
    const derivedPoint = pointR.multiply(scalarA).clearCofactor();
    return derivedPoint.toRawBytes();
  }

  /**
   * Derives the per-output scalar s_k = H_s(derivation || varint(outputIndex)).
   */
  public static deriveOutputScalar(keyDerivationBytes: Uint8Array, outputIndex: number): bigint {
    if (keyDerivationBytes.length !== 32) {
      throw new Error('Key derivation buffer must be 32 bytes.');
    }
    const indexVarInt = this.encodeVarInt(outputIndex);
    const payload = this.concatBytes(keyDerivationBytes, indexVarInt);
    return this.hashToScalar(payload);
  }

  /**
   * Encodes a byte array using Monero's block-based Base58 specification.
   * Splits input into 8-byte blocks (encoded as 11 chars) and a final remainder block.
   */
  public static encodeMoneroBase58(data: Uint8Array): string {
    if (data.length === 0) {
      return '';
    }

    const fullBlockCount = Math.floor(data.length / this.FULL_BLOCK_SIZE);
    const lastBlockSize = data.length % this.FULL_BLOCK_SIZE;
    let result = '';

    for (let i = 0; i < fullBlockCount; i++) {
      const block = data.subarray(i * this.FULL_BLOCK_SIZE, (i + 1) * this.FULL_BLOCK_SIZE);
      result += this.encodeBase58Block(block, this.FULL_ENCODED_BLOCK_SIZE);
    }

    if (lastBlockSize > 0) {
      const lastBlock = data.subarray(fullBlockCount * this.FULL_BLOCK_SIZE);
      const encodedSize = this.ENCODED_BLOCK_SIZES[lastBlockSize];
      result += this.encodeBase58Block(lastBlock, encodedSize);
    }

    return result;
  }

  /**
   * Decodes a Monero block-based Base58 string back into a Uint8Array.
   */
  public static decodeMoneroBase58(encoded: string): Uint8Array {
    if (typeof encoded !== 'string') {
      throw new Error('Base58 input must be a string.');
    }
    if (encoded.length === 0) {
      return new Uint8Array(0);
    }

    const fullBlockCount = Math.floor(encoded.length / this.FULL_ENCODED_BLOCK_SIZE);
    const lastEncodedSize = encoded.length % this.FULL_ENCODED_BLOCK_SIZE;
    const lastDecodedSize = this.ENCODED_BLOCK_SIZES.indexOf(lastEncodedSize);

    if (lastDecodedSize < 0) {
      throw new Error('Invalid Monero Base58 string length.');
    }

    const totalDecodedLength = fullBlockCount * this.FULL_BLOCK_SIZE + lastDecodedSize;
    const output = new Uint8Array(totalDecodedLength);

    for (let i = 0; i < fullBlockCount; i++) {
      const slice = encoded.substring(
        i * this.FULL_ENCODED_BLOCK_SIZE,
        (i + 1) * this.FULL_ENCODED_BLOCK_SIZE,
      );
      const decodedBlock = this.decodeBase58Block(slice, this.FULL_BLOCK_SIZE);
      output.set(decodedBlock, i * this.FULL_BLOCK_SIZE);
    }

    if (lastDecodedSize > 0) {
      const lastSlice = encoded.substring(fullBlockCount * this.FULL_ENCODED_BLOCK_SIZE);
      const decodedLastBlock = this.decodeBase58Block(lastSlice, lastDecodedSize);
      output.set(decodedLastBlock, fullBlockCount * this.FULL_BLOCK_SIZE);
    }

    return output;
  }

  /**
   * Constructs a 95-character Monero address (Primary or Subaddress) from prefix and public keys.
   */
  public static encodeMoneroAddress(
    prefixByte: number,
    publicSpendKey: Uint8Array,
    publicViewKey: Uint8Array,
  ): string {
    if (publicSpendKey.length !== 32 || publicViewKey.length !== 32) {
      throw new Error('Public spend key and public view key must each be 32 bytes.');
    }
    const prefix = this.encodeVarInt(prefixByte);
    const payload = this.concatBytes(prefix, publicSpendKey, publicViewKey);
    const checksum = this.keccak256(payload).subarray(0, 4);
    const fullBytes = this.concatBytes(payload, checksum);
    return this.encodeMoneroBase58(fullBytes);
  }

  /**
   * Decodes and cryptographically verifies a Monero Mainnet address (Primary, Subaddress, or Integrated).
   */
  public static decodeMoneroAddress(address: string): IDecodedMoneroAddress {
    if (!address || typeof address !== 'string') {
      throw new Error('Monero address must be a non-empty string.');
    }

    const trimmed = address.trim();
    if (trimmed.length !== 95 && trimmed.length !== 106) {
      throw new Error('Invalid Monero address length. Expected 95 or 106 characters.');
    }

    const rawBytes = this.decodeMoneroBase58(trimmed);
    if (rawBytes.length !== 69 && rawBytes.length !== 77) {
      throw new Error('Invalid decoded Monero address byte length.');
    }

    const prefix = rawBytes[0];
    const isPrimary = prefix === this.MAINNET_PRIMARY_ADDRESS_PREFIX && rawBytes.length === 69;
    const isSubaddress = prefix === this.MAINNET_SUBADDRESS_PREFIX && rawBytes.length === 69;
    const isIntegrated = prefix === this.MAINNET_INTEGRATED_ADDRESS_PREFIX && rawBytes.length === 77;

    if (!isPrimary && !isSubaddress && !isIntegrated) {
      throw new Error(`Unsupported or mismatched Monero network prefix byte: ${prefix}`);
    }

    const payload = rawBytes.subarray(0, rawBytes.length - 4);
    const providedChecksum = rawBytes.subarray(rawBytes.length - 4);
    const expectedChecksum = this.keccak256(payload).subarray(0, 4);

    for (let i = 0; i < 4; i++) {
      if (providedChecksum[i] !== expectedChecksum[i]) {
        throw new Error('Monero address Keccak-256 checksum verification failed.');
      }
    }

    const publicSpendKey = rawBytes.subarray(1, 33);
    const publicViewKey = rawBytes.subarray(33, 65);

    if (!this.isValidPublicKeyBytes(publicSpendKey) || !this.isValidPublicKeyBytes(publicViewKey)) {
      throw new Error('Monero address contains invalid Ed25519 public key points.');
    }

    const paymentId = isIntegrated ? rawBytes.subarray(65, 73) : undefined;

    return {
      prefix,
      publicSpendKey,
      publicViewKey,
      paymentId,
      isSubaddress,
      isIntegrated,
    };
  }

  /**
   * Deterministically converts a decimal currency string into atomic base units (BigInt)
   * without IEEE-754 floating-point precision loss.
   */
  public static parseDecimalToUnits(amountString: string, decimals: number): bigint {
    if (typeof amountString !== 'string' || !Number.isInteger(decimals) || decimals < 0) {
      throw new Error('Invalid parameters for decimal unit conversion.');
    }

    const trimmed = amountString.trim();
    if (!/^\d+(\.\d+)?$/.test(trimmed)) {
      throw new Error(`Invalid numeric amount format: "${amountString}"`);
    }

    const parts = trimmed.split('.');
    const integerPart = parts[0];
    const fractionalPart = parts[1] || '';

    if (fractionalPart.length > decimals) {
      const excessDigits = fractionalPart.substring(decimals);
      if (!/^0+$/.test(excessDigits)) {
        throw new Error(
          `Amount "${amountString}" exceeds maximum supported precision of ${decimals} decimal places.`,
        );
      }
    }

    const paddedFraction = fractionalPart.substring(0, decimals).padEnd(decimals, '0');
    const combined = `${integerPart}${paddedFraction}`;
    return BigInt(combined);
  }

  private static encodeBase58Block(block: Uint8Array, encodedSize: number): string {
    let num = this.bytesToBigIntBE(block);
    const chars = new Array<string>(encodedSize).fill(this.BASE58_ALPHABET[0]);
    let index = encodedSize - 1;

    while (num > 0n && index >= 0) {
      const remainder = Number(num % 58n);
      num = num / 58n;
      chars[index] = this.BASE58_ALPHABET[remainder];
      index--;
    }

    return chars.join('');
  }

  private static decodeBase58Block(encodedBlock: string, decodedSize: number): Uint8Array {
    let num = 0n;
    for (let i = 0; i < encodedBlock.length; i++) {
      const charIndex = this.BASE58_ALPHABET.indexOf(encodedBlock[i]);
      if (charIndex < 0) {
        throw new Error(`Invalid Base58 character encountered: "${encodedBlock[i]}"`);
      }
      num = num * 58n + BigInt(charIndex);
    }

    const maxAllowedValue = 1n << BigInt(decodedSize * 8);
    if (num >= maxAllowedValue) {
      throw new Error('Monero Base58 block integer overflow detected.');
    }

    return this.bigIntToBytesBE(num, decodedSize);
  }
}