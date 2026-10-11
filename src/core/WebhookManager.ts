/**
 * src/core/WebhookManager.ts
 * Handles secure HTTP dispatching of invoice status updates to the merchant's server.
 */

import axios from 'axios';
import * as crypto from 'crypto';
import { IInvoice } from '../types';

export class WebhookManager {
  /**
   * Dispatches a webhook with an HMAC-SHA256 signature for payload verification.
   * 
   * @param invoice The updated invoice object to send
   * @param webhookUrl The destination URL provided by the merchant
   * @param webhookSecret The secret key used to generate the cryptographic signature
   * @returns A boolean indicating the success of the HTTP request
   */
  public static async dispatch(invoice: IInvoice, webhookUrl: string, webhookSecret: string): Promise<boolean> {
    try {
      // Serialize the invoice object to a JSON string
      const payload = JSON.stringify(invoice);
      
      // Generate the HMAC-SHA256 signature based on the serialized payload and the merchant's secret
      const signature = crypto
        .createHmac('sha256', webhookSecret)
        .update(payload)
        .digest('hex');

      // Dispatch the POST request with strict timeouts to prevent memory leaks in the polling cycle
      const response = await axios.post(webhookUrl, payload, {
        headers: {
          'Content-Type': 'application/json',
          'X-ZeroPay-Signature': signature,
        },
        timeout: 5000,
      });

      // HTTP status codes between 200 and 299 indicate successful reception by the merchant's server
      return response.status >= 200 && response.status < 300;
    } catch (error) {
      // In a comprehensive enterprise system, failed webhooks should be added to a persistent queue
      // (e.g., Redis or RabbitMQ) for exponential backoff retries. 
      // For the core library, we return false to allow the main engine to handle the failure state.
      return false;
    }
  }
}