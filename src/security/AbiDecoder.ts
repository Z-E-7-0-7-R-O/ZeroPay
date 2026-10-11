/**
 * src/security/AbiDecoder.ts
 * Layer 3: Binary ABI parameter decoder for TRC20 transfer method selector validation.
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const TronWeb = require('tronweb');

export interface IDecodedTransfer {
  methodSelector: string;
  recipientAddressBase58: string;
  amountUnits: bigint;
}

export class AbiDecoder {
  /**
   * Method selector for ERC20/TRC20 transfer(address,uint256):
   * Keccak-256("transfer(address,uint256)").slice(0, 4) = 0xa9059cbb
   */
  public static readonly TRANSFER_METHOD_SELECTOR: string = 'a9059cbb';

  /**
   * Parses raw hexadecimal invocation data from a smart contract transaction.
   * 
   * @param rawDataHex The raw parameter data string (without or with '0x' prefix)
   * @returns Decoded method selector, recipient address in Base58, and transfer amount in base units
   */
  public static decodeTransfer(rawDataHex: string): IDecodedTransfer | null {
    if (!rawDataHex || typeof rawDataHex !== 'string') {
      return null;
    }

    // Normalize input string by removing 0x prefix
    let cleanHex = rawDataHex.trim();
    if (cleanHex.startsWith('0x') || cleanHex.startsWith('0X')) {
      cleanHex = cleanHex.substring(2);
    }

    // A standard transfer(address,uint256) requires exactly 8 chars (selector) + 64 chars (address) + 64 chars (amount) = 136 chars
    if (cleanHex.length !== 136) {
      return null;
    }

    const methodSelector = cleanHex.substring(0, 8).toLowerCase();
    if (methodSelector !== this.TRANSFER_METHOD_SELECTOR) {
      return null;
    }

    // Extract 32-byte left-padded address (take last 20 bytes = 40 hex chars)
    const addressSegment = cleanHex.substring(8, 72);
    const addressHex20 = addressSegment.substring(24); // Remove 24 zero chars (12 bytes of padding)
    const tronHexAddress = `41${addressHex20}`; // Prepend TRON network byte (0x41)

    let recipientBase58: string;
    try {
      recipientBase58 = TronWeb.address.fromHex(tronHexAddress);
    } catch {
      return null;
    }

    // Extract 32-byte amount parameter
    const amountSegment = cleanHex.substring(72, 136);
    let amountUnits: bigint;
    try {
      amountUnits = BigInt(`0x${amountSegment}`);
    } catch {
      return null;
    }

    return {
      methodSelector,
      recipientAddressBase58: recipientBase58,
      amountUnits,
    };
  }

  /**
   * Validates that the transaction payload matches the invoice requirements strictly.
   * 
   * @param rawDataHex Raw binary payload
   * @param expectedRecipientBase58 The generated receiving address of the invoice
   * @param expectedAmountString The expected amount in standard currency unit (e.g. "50.00")
   * @returns Boolean indicating strict parameter alignment
   */
  public static validateTransferParameters(
    rawDataHex: string,
    expectedRecipientBase58: string,
    expectedAmountString: string
  ): boolean {
    const decoded = this.decodeTransfer(rawDataHex);
    if (!decoded) {
      return false;
    }

    // Verify recipient address match
    if (decoded.recipientAddressBase58 !== expectedRecipientBase58) {
      return false;
    }

    // Convert invoice amount to base units (USDT has 6 decimals on TRON)
    const expectedBaseUnits = BigInt(Math.floor(parseFloat(expectedAmountString) * 1_000_000));

    // Numerical match verification
    if (decoded.amountUnits !== expectedBaseUnits) {
      return false;
    }

    return true;
  }
}