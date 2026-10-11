/**
 * src/engines/UtxoEngine.ts
 * Cryptographic engine for generating UTXO-based addresses (Litecoin, Dogecoin) from an xPub.
 */

import * as bitcoin from 'bitcoinjs-lib';
import { BIP32Factory } from 'bip32';
import * as ecc from 'tiny-secp256k1';
import { Network } from '../types';

// Initialize the BIP32 factory with the secp256k1 elliptic curve cryptography library
const bip32 = BIP32Factory(ecc);

/**
 * Custom network parameters for Litecoin Mainnet.
 * Required for correct Base58 decoding and address generation.
 */
const LITECOIN_NETWORK: bitcoin.Network = {
  messagePrefix: '\x19Litecoin Signed Message:\n',
  bech32: 'ltc',
  bip32: {
    public: 0x019da462, // Ltub
    private: 0x019d9cfe, // Ltpv
  },
  pubKeyHash: 0x30, // Addresses start with 'L'
  scriptHash: 0x32, // Addresses start with 'M'
  wif: 0xb0,
};

/**
 * Custom network parameters for Dogecoin Mainnet.
 * Dogecoin does not support Bech32/SegWit formats.
 */
const DOGECOIN_NETWORK: bitcoin.Network = {
  messagePrefix: '\x19Dogecoin Signed Message:\n',
  bech32: '', 
  bip32: {
    public: 0x02facafd, // dgub
    private: 0x02fac398, // dgpv
  },
  pubKeyHash: 0x1e, // Addresses start with 'D'
  scriptHash: 0x16, // Addresses start with '9' or 'A'
  wif: 0x9e,
};

export class UtxoEngine {
  /**
   * Generates a deterministic receiving address based on the provided xPub and derivation index.
   * 
   * @param xpub The Extended Public Key at the account level (e.g., m/44'/2'/0')
   * @param index The unique derivation index for the specific invoice
   * @param targetNetwork The target blockchain network (LITECOIN or DOGECOIN)
   * @returns The generated wallet address as a string
   */
  public static generateAddress(xpub: string, index: number, targetNetwork: Network): string {
    if (targetNetwork !== Network.LITECOIN && targetNetwork !== Network.DOGECOIN) {
      throw new Error(`Unsupported network requested in UtxoEngine: ${targetNetwork}`);
    }

    const networkParams = targetNetwork === Network.LITECOIN ? LITECOIN_NETWORK : DOGECOIN_NETWORK;

    try {
      // Decode the Base58 xPub using the specific network parameters
      const node = bip32.fromBase58(xpub, networkParams);
      
      // Derive the receiving address node. 
      // 0 defines the external (receiving) chain, followed by the specific index.
      const childNode = node.derive(0).derive(index);

      let address: string | undefined;

      if (targetNetwork === Network.LITECOIN) {
        // Litecoin modern standard: Native SegWit (Pay-to-Witness-Public-Key-Hash)
        const payment = bitcoin.payments.p2wpkh({
          pubkey: childNode.publicKey,
          network: networkParams,
        });
        address = payment.address;
      } else if (targetNetwork === Network.DOGECOIN) {
        // Dogecoin standard: Legacy (Pay-to-Public-Key-Hash)
        const payment = bitcoin.payments.p2pkh({
          pubkey: childNode.publicKey,
          network: networkParams,
        });
        address = payment.address;
      }

      if (!address) {
        throw new Error('Cryptographic payment object returned undefined address.');
      }

      return address;
    } catch (error) {
      const errMessage = error instanceof Error ? error.message : 'Unknown cryptographic exception';
      throw new Error(`Address generation failed for ${targetNetwork}: ${errMessage}`);
    }
  }
}