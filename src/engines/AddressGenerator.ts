/**
 * src/engines/AddressGenerator.ts
 * Facade pattern for routing address generation requests to the appropriate cryptographic engine.
 */

import { Network, IZeroPayConfig } from '../types';
import { UtxoEngine } from './UtxoEngine';
import { TrvmEngine } from './TrvmEngine';

export class AddressGenerator {
  /**
   * Routes the address generation request based on the target network.
   * 
   * @param config The zero pay configuration containing extended public keys (xPubs)
   * @param network The target blockchain network
   * @param index The deterministic derivation index
   * @returns The generated cryptographic address
   */
  public static generate(config: IZeroPayConfig, network: Network, index: number): string {
    switch (network) {
      case Network.LITECOIN:
        if (!config.xpubLitecoin) {
          throw new Error('Litecoin xPub is missing in the configuration.');
        }
        return UtxoEngine.generateAddress(config.xpubLitecoin, index, network);
        
      case Network.DOGECOIN:
        if (!config.xpubDogecoin) {
          throw new Error('Dogecoin xPub is missing in the configuration.');
        }
        return UtxoEngine.generateAddress(config.xpubDogecoin, index, network);
        
      case Network.TRON:
        if (!config.xpubTron) {
          throw new Error('TRON xPub is missing in the configuration.');
        }
        return TrvmEngine.generateAddress(config.xpubTron, index, network);
        
      default:
        throw new Error(`Unsupported network in AddressGenerator: ${network}`);
    }
  }
}