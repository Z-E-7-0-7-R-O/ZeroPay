/**
 * demo-store/server.ts
 * End-to-End simulation server representing a merchant's backend using ZeroPay.
 */

import express, { Request, Response } from 'express';
import { ZeroPayClient, Currency, Network, IZeroPayConfig } from '../src';

const app = express();
app.use(express.json());

// A mathematically valid Extended Public Key (xPub) for cryptographic simulation
const SIMULATION_XPUB = 'xpub661MyMwAqRbcFtXgS5sYJABqqG9YLmC4Q1Rdap9gSE8NqtwybGhePY2gZ29ESFjqJoCu1Rupje8YtGqsefD265TMg7usUDFdp6W1EGMcet8';

// Initialize the configuration for the merchant
const config: IZeroPayConfig = {
  xpubTron: SIMULATION_XPUB,
  xpubLitecoin: SIMULATION_XPUB,
  webhookSecret: 'secure-hmac-secret-2026',
  webhookUrl: 'http://localhost:3000/webhook',
  defaultExpirationMinutes: 15,
  defaultConfirmations: 1,
};

// Instantiate the core ZeroPay engine
const zeroPay = new ZeroPayClient(config);

// Start the blockchain polling loop (checking mempool every 15 seconds)
zeroPay.startPolling(15000);

/**
 * Route: POST /checkout
 * Simulates a customer purchasing an item and requesting a cryptocurrency invoice.
 */
app.post('/checkout', async (_req: Request, res: Response) => {
  try {
    // Generate a $50 USDT invoice on the TRON network
    const invoice = await zeroPay.createInvoice('50.00', Currency.USDT, Network.TRON);
    
    res.status(200).json({
      message: 'ZeroPay Invoice Generated Successfully',
      invoiceData: invoice,
    });
  } catch (error) {
    const errMessage = error instanceof Error ? error.message : 'Internal Server Error';
    res.status(500).json({ error: errMessage });
  }
});

/**
 * Route: POST /webhook
 * The endpoint designated to receive secure payment confirmations from the ZeroPay engine.
 */
app.post('/webhook', (req: Request, res: Response) => {
  const signature = req.headers['x-zeropay-signature'];
  const payload = req.body;

  console.log('\n--- [WEBHOOK RECEIVED] ---');
  console.log('Signature:', signature);
  console.log('Payload:', JSON.stringify(payload, null, 2));
  console.log('--------------------------\n');

  // Respond with 200 OK to acknowledge receipt and prevent webhook retries
  res.status(200).send('OK');
});

const PORT = 3000;
app.listen(PORT, () => {
  console.log(`[ZeroPay Demo Store] Initialization Complete.`);
  console.log(`[Server] Listening on http://localhost:${PORT}`);
  console.log(`[Instruction] To test, send a POST request to http://localhost:${PORT}/checkout`);
});