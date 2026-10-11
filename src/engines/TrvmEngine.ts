/**
 * src/engines/TrvmEngine.ts
 * Cryptographic engine for generating TRVM-based addresses (TRON, USDT TRC20) from an xPub.
 */

import { BIP32Factory } from 'bip32';
import * as ecc from 'tiny-secp256k1';
import { utils } from 'ethers';
import { Network } from '../types';

// In TypeScript, tronweb does not always expose built-in types correctly for its crypto utils.
// Using require ensures stable runtime execution without type definition conflicts.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const TronWeb = require('tronweb');

// Initialize the BIP32 factory with the secp256k1 elliptic curve cryptography library
const bip32 = BIP32Factory(ecc);

export class TrvmEngine {
  /**
   * Generates a deterministic receiving address for the TRON network based on the provided xPub.
   * 
   * @param xpub The Extended Public Key at the account level (e.g., m/44'/195'/0')
   * @param index The unique derivation index for the specific invoice
   * @param targetNetwork The target blockchain network (Must be TRON)
   * @returns The generated TRON wallet address in Base58Check format (starts with 'T')
   */
  public static generateAddress(xpub: string, index: number, targetNetwork: Network): string {
    if (targetNetwork !== Network.TRON) {
      throw new Error(`Unsupported network requested in TrvmEngine: ${targetNetwork}`);
    }

    try {
      // Decode the Base58 xPub. 
      // TRON xPubs utilize the standard Bitcoin BIP32 serialization format (prefix 0x0488b21e).
      const node = bip32.fromBase58(xpub);
      
      // Derive the receiving address node.
      // Index 0 specifies the external receiving chain, followed by the invoice-specific index.
      const childNode = node.derive(0).derive(index);

      // Extract the 33-byte compressed public key
      const publicKey = childNode.publicKey;

      // Compute the EVM equivalent address (Keccak256 hash of the uncompressed public key)
      // The ethers library robustly handles the conversion from compressed to uncompressed internally.
      const evmAddress = utils.computeAddress(publicKey);

      // TRON addresses share the exact mathematical derivation as EVM addresses,
      // with the exception that the '0x' prefix is replaced by the byte '41'.
      const tronHexAddress = '41' + evmAddress.substring(2);

      // Apply Base58Check encoding to generate the final TRON string format.
      const tronBase58Address = TronWeb.address.fromHex(tronHexAddress);

      if (!tronBase58Address || !tronBase58Address.startsWith('T')) {
        throw new Error('Address calculation resulted in an invalid TRON format.');
      }

      return tronBase58Address;
    } catch (error) {
      const errMessage = error instanceof Error ? error.message : 'Unknown cryptographic exception';
      throw new Error(`TRON address generation failed: ${errMessage}`);
    }
  }
}