/**
 * src/security/MoneroTimelockValidator.ts
 * Layer 2: Consensus execution state, double-spend key-image check, and malicious unlock_time protection.
 */

export interface IMoneroTransactionExecutionState {
  unlockTime: number;
  doubleSpendSeen?: boolean;
  failed?: boolean;
  invalidInput?: boolean;
  invalidOutput?: boolean;
  overspend?: boolean;
}

export class MoneroTimelockValidator {
  /**
   * Threshold defined in Monero cryptonote_config.h (CRYPTONOTE_MAX_BLOCK_NUMBER = 500,000,000).
   * Values below this threshold are interpreted as block heights; values >= are Unix timestamps.
   */
  public static readonly BLOCK_HEIGHT_THRESHOLD: number = 500_000_000;

  /**
   * Validates that a Monero transaction is not flagged as a double-spend or failed execution,
   * and verifies that its unlock_time does not maliciously freeze merchant funds.
   *
   * @param state Execution flags and unlock_time extracted from the Monero daemon/RPC
   * @param currentChainHeight Optional current blockchain height for evaluating block-based timelocks
   * @param maxAllowedBlockLockDelta Maximum future blocks allowed if unlock_time > 0 (default: 0)
   * @returns Boolean indicating whether the transaction execution and timelock are safe
   */
  public static isExecutionAndTimelockSafe(
    state: IMoneroTransactionExecutionState,
    currentChainHeight?: number,
    maxAllowedBlockLockDelta: number = 0,
  ): boolean {
    if (!state || typeof state !== 'object') {
      return false;
    }

    // 1. Reject if any double-spend or consensus failure flag is raised
    if (
      state.doubleSpendSeen === true ||
      state.failed === true ||
      state.invalidInput === true ||
      state.invalidOutput === true ||
      state.overspend === true
    ) {
      return false;
    }

    // 2. Validate unlockTime structural integrity
    if (
      typeof state.unlockTime !== 'number' ||
      !Number.isInteger(state.unlockTime) ||
      state.unlockTime < 0
    ) {
      return false;
    }

    // Standard unlocked transaction (unlock_time === 0)
    if (state.unlockTime === 0) {
      return true;
    }

    // 3. Evaluate non-zero unlock_time against block height or Unix timestamp rules
    if (state.unlockTime < this.BLOCK_HEIGHT_THRESHOLD) {
      // Interpreted as a block height lock
      if (
        currentChainHeight === undefined ||
        !Number.isInteger(currentChainHeight) ||
        currentChainHeight <= 0
      ) {
        return false;
      }
      return state.unlockTime <= currentChainHeight + maxAllowedBlockLockDelta;
    } else {
      // Interpreted as a Unix timestamp lock (in seconds)
      const currentUnixSeconds = Math.floor(Date.now() / 1000);
      return state.unlockTime <= currentUnixSeconds;
    }
  }
}