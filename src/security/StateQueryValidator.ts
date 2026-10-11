/**
 * src/security/StateQueryValidator.ts
 * Layer 4: Direct state query via balanceOf on the immutable official Tether contract.
 */

import { HttpClient } from '../utils/http';
import { ContractWhitelist } from './ContractWhitelist';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const TronWeb = require('tronweb');

export class StateQueryValidator {
  private httpClient: HttpClient;
  private tronRpcUrl: string;

  constructor(tronRpcUrl: string = 'https://api.trongrid.io', httpClient?: HttpClient) {
    this.tronRpcUrl = tronRpcUrl;
    this.httpClient = httpClient || new HttpClient({ baseURL: this.tronRpcUrl });
  }

  /**
   * Queries the official Tether contract on-chain storage to retrieve the genuine token balance of an address.
   * 
   * @param targetAddressBase58 The address whose balance is being queried
   * @returns The balance in Sun (base units) as a BigInt
   */
  public async queryOnChainBalance(targetAddressBase58: string): Promise<bigint> {
    try {
      const targetHex = TronWeb.address.toHex(targetAddressBase58);
      // Remove '41' network byte prefix to obtain raw 20-byte address, then pad to 32 bytes (64 hex chars)
      const cleanHex20 = targetHex.startsWith('41') ? targetHex.substring(2) : targetHex;
      const parameterPadded = cleanHex20.padStart(64, '0');

      // Function selector for balanceOf(address) is 70a08231
      const requestPayload = {
        owner_address: ContractWhitelist.OFFICIAL_USDT_HEX,
        contract_address: ContractWhitelist.OFFICIAL_USDT_HEX,
        function_selector: 'balanceOf(address)',
        parameter: parameterPadded,
        visible: false,
      };

      interface IConstantContractResponse {
        result?: { result: boolean };
        constant_result?: string[];
      }

      const response = await this.httpClient.post<IConstantContractResponse>(
        '/wallet/triggerconstantcontract',
        requestPayload
      );

      if (!response.data || !response.data.constant_result || response.data.constant_result.length === 0) {
        throw new Error('State query call returned empty constant_result payload.');
      }

      const balanceHex = response.data.constant_result[0];
      return BigInt(`0x${balanceHex}`);
    } catch (error) {
      const errMessage = error instanceof Error ? error.message : 'State query exception';
      throw new Error(`Failed to verify on-chain balance via official contract: ${errMessage}`);
    }
  }

  /**
   * Confirms that the target address has received at least the expected invoice amount.
   * 
   * @param targetAddressBase58 The receiving address
   * @param expectedAmountString The expected amount in standard tokens (e.g. "50.00")
   * @returns Boolean indicating verified on-chain funds existence
   */
  public async verifyBalanceSufficiency(
    targetAddressBase58: string,
    expectedAmountString: string
  ): Promise<boolean> {
    try {
      const currentBalance = await this.queryOnChainBalance(targetAddressBase58);
      const expectedBaseUnits = BigInt(Math.floor(parseFloat(expectedAmountString) * 1_000_000));
      return currentBalance >= expectedBaseUnits;
    } catch {
      return false;
    }
  }
}