/**
 * src/security/MoneroFinalityValidator.ts
 * Layer 5: Monero blockchain height query and confirmation finality validator.
 */

import { HttpClient } from '../utils/http';

export class MoneroFinalityValidator {
  private httpClient: HttpClient;
  private moneroRpcUrl: string;

  constructor(
    moneroRpcUrl: string = 'https://xmr-node.cakewallet.com:18081',
    httpClient?: HttpClient,
  ) {
    this.moneroRpcUrl = moneroRpcUrl;
    this.httpClient = httpClient || new HttpClient({ baseURL: this.moneroRpcUrl });
  }

  /**
   * Queries the Monero daemon /get_height endpoint to obtain the current blockchain height.
   *
   * @returns The current top block height of the Monero network
   */
  public async getCurrentChainHeight(): Promise<number> {
    try {
      interface IMoneroHeightResponse {
        height?: number;
        status?: string;
      }

      const response = await this.httpClient.get<IMoneroHeightResponse>('/get_height');
      const height = response.data?.height;

      if (typeof height !== 'number' || !Number.isInteger(height) || height <= 0) {
        throw new Error('Invalid block height returned by Monero daemon.');
      }

      return height;
    } catch (error) {
      const errMessage = error instanceof Error ? error.message : 'Daemon RPC query error';
      throw new Error(`Failed to retrieve Monero blockchain height: ${errMessage}`);
    }
  }

  /**
   * Calculates the number of confirmations for a given transaction block height.
   */
  public async calculateConfirmations(
    transactionBlockHeight?: number,
    inPool: boolean = false,
  ): Promise<number> {
    if (
      inPool ||
      transactionBlockHeight === undefined ||
      !Number.isInteger(transactionBlockHeight) ||
      transactionBlockHeight <= 0
    ) {
      return 0;
    }

    const currentHeight = await this.getCurrentChainHeight();
    if (currentHeight < transactionBlockHeight) {
      return 0;
    }

    return currentHeight - transactionBlockHeight + 1;
  }

  /**
   * Evaluates whether a mined Monero transaction has reached the required confirmation threshold.
   *
   * @param transactionBlockHeight The block height where the transaction was mined
   * @param requiredConfirmations Required block confirmations (defaults to 1)
   */
  public async isTransactionFinalized(
    transactionBlockHeight: number,
    requiredConfirmations: number = 1,
  ): Promise<boolean> {
    try {
      if (!Number.isInteger(transactionBlockHeight) || transactionBlockHeight <= 0) {
        return false;
      }
      const confirmations = await this.calculateConfirmations(transactionBlockHeight, false);
      return confirmations >= requiredConfirmations;
    } catch {
      return false;
    }
  }
}