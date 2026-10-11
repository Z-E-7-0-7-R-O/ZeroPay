/**
 * src/security/ConsensusFinalityValidator.ts
 * Layer 5: Consensus finality validator checking against TRON DPoS Solidified Blocks.
 */

import { HttpClient } from '../utils/http';

export class ConsensusFinalityValidator {
  private httpClient: HttpClient;
  private tronRpcUrl: string;

  constructor(tronRpcUrl: string = 'https://api.trongrid.io', httpClient?: HttpClient) {
    this.tronRpcUrl = tronRpcUrl;
    this.httpClient = httpClient || new HttpClient({ baseURL: this.tronRpcUrl });
  }

  /**
   * Fetches the height of the most recently solidified block agreed upon by 2/3+ Super Representatives.
   * 
   * @returns The solidified block number as an integer
   */
  public async getLatestSolidifiedBlockNumber(): Promise<number> {
    try {
      interface ISolidifiedBlockResponse {
        block_header?: {
          raw_data?: {
            number?: number;
          };
        };
      }

      const response = await this.httpClient.post<ISolidifiedBlockResponse>(
        '/walletsolidity/getnowblock',
        {}
      );

      const blockNumber = response.data?.block_header?.raw_data?.number;
      if (typeof blockNumber !== 'number') {
        throw new Error('Unable to extract valid block number from solidified node response.');
      }

      return blockNumber;
    } catch (error) {
      const errMessage = error instanceof Error ? error.message : 'Consensus query failure';
      throw new Error(`Failed to retrieve solidified block height: ${errMessage}`);
    }
  }

  /**
   * Evaluates if a transaction block has attained consensus finality.
   * 
   * @param transactionBlockNumber The block height where the transaction was mined
   * @returns Boolean indicating mathematical irreversibility
   */
  public async isTransactionFinalized(transactionBlockNumber: number): Promise<boolean> {
    try {
      const latestSolidified = await this.getLatestSolidifiedBlockNumber();
      return transactionBlockNumber <= latestSolidified;
    } catch {
      return false;
    }
  }
}