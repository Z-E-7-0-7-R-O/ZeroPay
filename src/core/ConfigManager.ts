/**
 * src/core/ConfigManager.ts
 * Validates, sanitizes, and applies fallback defaults to the ZeroPay configuration object.
 */

import { IZeroPayConfig } from '../types';

export class ConfigManager {
  private static readonly DEFAULT_EXPIRATION_MINUTES = 60;
  private static readonly DEFAULT_CONFIRMATIONS = 1;
  private static readonly DEFAULT_TRON_RPC_URL = 'https://api.trongrid.io';

  /**
   * Validates and normalizes the provided ZeroPay configuration.
   * Enforces the fail-fast principle to protect cryptographic and network operations.
   * 
   * @param config The raw configuration supplied by the developer
   * @returns A sanitized configuration object with guaranteed defaults
   */
  public static process(config: IZeroPayConfig): IZeroPayConfig {
    this.validate(config);
    return this.applyDefaults(config);
  }

  /**
   * Executes strict deterministic validation rules across all configuration fields.
   */
  public static validate(config: IZeroPayConfig): void {
    if (!config) {
      throw new Error('Configuration object cannot be null or undefined.');
    }

    // Webhook Secret Validation
    if (!config.webhookSecret || typeof config.webhookSecret !== 'string' || config.webhookSecret.trim().length === 0) {
      throw new Error('Invalid configuration: "webhookSecret" must be a non-empty string for HMAC signature generation.');
    }

    // Webhook URL Validation
    if (config.webhookUrl) {
      this.validateUrl(config.webhookUrl, 'webhookUrl');
    }

    // TRON RPC URL Validation
    if (config.tronRpcUrl) {
      this.validateUrl(config.tronRpcUrl, 'tronRpcUrl');
    }

    // Extended Public Key Format Checks
    if (config.xpubLitecoin) {
      this.validateXpubFormat(config.xpubLitecoin, 'xpubLitecoin');
    }

    if (config.xpubDogecoin) {
      this.validateXpubFormat(config.xpubDogecoin, 'xpubDogecoin');
    }

    if (config.xpubTron) {
      this.validateXpubFormat(config.xpubTron, 'xpubTron');
    }

    // Numerical Parameter Constraints
    if (config.defaultConfirmations !== undefined) {
      if (!Number.isInteger(config.defaultConfirmations) || config.defaultConfirmations < 0) {
        throw new Error('Invalid configuration: "defaultConfirmations" must be a non-negative integer.');
      }
    }

    if (config.defaultExpirationMinutes !== undefined) {
      if (!Number.isInteger(config.defaultExpirationMinutes) || config.defaultExpirationMinutes <= 0) {
        throw new Error('Invalid configuration: "defaultExpirationMinutes" must be an integer greater than zero.');
      }
    }
  }

  /**
   * Applies deterministic defaults for missing optional properties.
   */
  private static applyDefaults(config: IZeroPayConfig): IZeroPayConfig {
    return {
      ...config,
      tronRpcUrl: config.tronRpcUrl || this.DEFAULT_TRON_RPC_URL,
      defaultExpirationMinutes: config.defaultExpirationMinutes ?? this.DEFAULT_EXPIRATION_MINUTES,
      defaultConfirmations: config.defaultConfirmations ?? this.DEFAULT_CONFIRMATIONS,
    };
  }

  /**
   * Validates structural URL integrity using the ECMAScript URL API.
   */
  private static validateUrl(urlString: string, fieldName: string): void {
    try {
      const parsed = new URL(urlString);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error(`Protocol must be HTTP or HTTPS.`);
      }
    } catch (error) {
      const errMessage = error instanceof Error ? error.message : 'Malformed URI';
      throw new Error(`Invalid configuration: "${fieldName}" must be a valid URL string (${errMessage}).`);
    }
  }

  /**
   * Validates structural format of serialized BIP32 Extended Public Keys.
   */
  private static validateXpubFormat(xpub: string, fieldName: string): void {
    const trimmed = xpub.trim();
    // Standard serialized BIP32 extended keys span between 100 and 120 characters depending on encoding
    if (trimmed.length < 100 || trimmed.length > 120) {
      throw new Error(`Invalid configuration: "${fieldName}" does not conform to the expected length for an Extended Public Key.`);
    }
  }
}