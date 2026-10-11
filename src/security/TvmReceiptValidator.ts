/**
 * src/security/TvmReceiptValidator.ts
 * Layer 2: TVM execution receipt validation to detect reverted or failed transactions.
 */

export interface ITronTransactionPayload {
  ret?: Array<{
    contractRet?: string;
    fee?: number;
  }>;
  receipt?: {
    result?: string;
    energy_fee?: number;
    energy_usage_total?: number;
    net_fee?: number;
  };
  [key: string]: unknown;
}

export class TvmReceiptValidator {
  private static readonly SUCCESS_STATUS: string = 'SUCCESS';

  /**
   * Evaluates the execution state of the transaction within the TVM.
   * Blocks reverted transactions, energy exhaustion errors, and unhandled exceptions.
   * 
   * @param txPayload The raw transaction JSON or transaction info response from TronGrid
   * @returns Boolean indicating genuine execution finality
   */
  public static isExecutionSuccessful(txPayload: ITronTransactionPayload): boolean {
    if (!txPayload || typeof txPayload !== 'object') {
      return false;
    }

    // 1. Check top-level contract return array in standard transaction payload
    if (Array.isArray(txPayload.ret) && txPayload.ret.length > 0) {
      const primaryResult = txPayload.ret[0];
      if (primaryResult.contractRet !== this.SUCCESS_STATUS) {
        return false;
      }
    }

    // 2. Check transaction info receipt result if present
    if (txPayload.receipt && typeof txPayload.receipt === 'object') {
      if (txPayload.receipt.result && txPayload.receipt.result !== this.SUCCESS_STATUS) {
        return false;
      }
    }

    // 3. Reject if contractRet is missing entirely in a finished transaction
    if (!txPayload.ret && !txPayload.receipt) {
      return false;
    }

    return true;
  }
}