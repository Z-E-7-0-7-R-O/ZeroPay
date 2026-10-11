/**
 * src/security/ContractWhitelist.ts
 * Layer 1: Immutable Whitelist validation for official smart contract addresses.
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const TronWeb = require('tronweb');

export class ContractWhitelist {
  /**
   * Official Tether USD (USDT) TRC20 Contract Address on TRON Mainnet.
   * Base58 format: TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t
   * Hex format: 41a614f803b6fd780986a42c78ec9c7f77e6ded13c
   */
  public static readonly OFFICIAL_USDT_BASE58: string = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
  public static readonly OFFICIAL_USDT_HEX: string = '41a614f803b6fd780986a42c78ec9c7f77e6ded13c';

  /**
   * Verifies if a given smart contract address strictly matches the genuine Tether contract.
   * Rejects any forged, duplicate, or secondary contracts.
   * 
   * @param contractAddress The contract address extracted from the transaction (Base58 or Hex)
   * @returns Boolean indicating strict identity match
   */
  public static isOfficialUsdt(contractAddress: string): boolean {
    if (!contractAddress || typeof contractAddress !== 'string') {
      return false;
    }

    const cleanAddress = contractAddress.trim();

    // Direct comparison against Base58 representation
    if (cleanAddress === this.OFFICIAL_USDT_BASE58) {
      return true;
    }

    // Direct comparison against Hex representation (case-insensitive)
    const lowerClean = cleanAddress.toLowerCase();
    if (lowerClean === this.OFFICIAL_USDT_HEX || lowerClean === `0x${this.OFFICIAL_USDT_HEX.substring(2)}`) {
      return true;
    }

    // Normalized conversion check via TronWeb address utilities
    try {
      const convertedHex = TronWeb.address.toHex(cleanAddress).toLowerCase();
      return convertedHex === this.OFFICIAL_USDT_HEX;
    } catch {
      return false;
    }
  }
}