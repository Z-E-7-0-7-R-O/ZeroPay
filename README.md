<h1 align="center">
  ZeroPay: Non-Custodial, Self-Hosted<br>
  Cryptocurrency Payment Processor for Node.js
</h1>

<div align="center">
<i>A TypeScript library for generating deterministic per-invoice receiving addresses from extended public keys (xPub) and monitoring incoming payments on TRON, Litecoin, and Dogecoin.</i>
<br><br>
<b>Developer:</b> Zero <br>
<b>Package:</b> zeropay-core 1.0.0 (MIT License)<br>
<b>Architecture:</b> TypeScript / Node.js / BIP32 Hierarchical Deterministic Address Derivation<br>
<b>Status:</b> Initial Version (functional core, known limitations documented below)
</div>

--------------------------------------------------------------------------------

## Overview

ZeroPay is a Node.js library that lets a merchant accept cryptocurrency payments on a self-hosted server without handing custody of funds to a third party. The library never receives or stores private keys. It is configured only with account-level extended public keys (xPub). From an xPub it derives a unique receiving address for every invoice, then periodically queries public blockchain APIs to determine whether that address has received the expected amount. When an invoice reaches the `CONFIRMED` status, the library can send an HMAC-SHA256 signed webhook to a merchant-defined URL.

The library is written in TypeScript (strict mode, ES2022 target, CommonJS output) and is distributed as a single package entry point (`dist/index.js`). It does not run as a standalone server or command-line tool; it is intended to be imported and driven by the merchant's own application.

The implemented functionality is organized into the following mechanisms:

1. **Deterministic Address Derivation (BIP32):** Decodes an account-level xPub and derives the child node at path `0/<index>` (external chain, then the invoice-specific index). Litecoin addresses are generated as Native SegWit (P2WPKH, `ltc1...`), Dogecoin addresses as Legacy P2PKH (`D...`), and TRON addresses by computing the EVM-style Keccak-256 address of the derived public key, prefixing the TRON network byte `0x41`, and applying Base58Check encoding (`T...`).
2. **Invoice Lifecycle Management:** `ZeroPayClient.createInvoice` obtains a per-network derivation index from the storage adapter, generates the receiving address, assigns a UUID (`crypto.randomUUID`), computes an expiration timestamp, and persists the invoice with status `PENDING`.
3. **Polling-Based Payment Detection:** `ZeroPayClient.startPolling` runs an interval timer (default 30,000 ms) that retrieves active invoices, marks overdue `PENDING` invoices as `EXPIRED`, and routes the remaining invoices to the network-specific scanner through `ScannerFactory`.
4. **Network Scanners:** `TronScanner` queries a TronGrid-compatible HTTP API for incoming TRC20 USDT transfers and native TRX transfers. `UtxoScanner` queries the BlockCypher API for confirmed and unconfirmed transactions on Litecoin and Dogecoin.
5. **Signed Webhook Delivery:** `WebhookManager` serializes the invoice to JSON, signs the exact payload string with HMAC-SHA256 using the configured `webhookSecret`, and sends an HTTP POST with the signature in the `X-ZeroPay-Signature` header. `CryptoUtils.verifyHmacSignature` provides a timing-safe verification routine for the receiving side.
6. **Five-Layer TRC20 Verification Module:** `AntiCounterfeitEngine` combines five sequential checks (contract whitelist, TVM execution receipt, ABI parameter decoding, on-chain `balanceOf` query, and solidified block finality) intended to reject counterfeit tokens and invalid transfers. This module is implemented and unit tested as a standalone component; it is not yet invoked by the polling pipeline (see Assumptions & Limitations).
7. **Pluggable Storage:** Persistence is abstracted behind the `IStorageAdapter` interface. `MemoryStorage` is the default in-memory implementation intended for testing and prototyping.
8. **Configuration Validation:** `ConfigManager` validates the supplied configuration with fail-fast errors and applies default values for optional fields.
9. **HTTP Client with Retry:** `HttpClient` wraps axios with a request timeout and an exponential backoff retry loop for network-level failures, HTTP 429, and HTTP 5xx responses. It is used by the verification module.

### Supported Networks and Currencies

| Network | Currencies | Address Format | Derivation Engine | Data Source |
|---|---|---|---|---|
| TRON | USDT (TRC20), TRX | Base58Check, begins with `T`, 34 characters | `TrvmEngine` | TronGrid-compatible API (`https://api.trongrid.io` by default) |
| Litecoin | LTC | Native SegWit Bech32, begins with `ltc1` | `UtxoEngine` | BlockCypher (`ltc/main`) |
| Dogecoin | DOGE | Legacy P2PKH, begins with `D`, 34 characters | `UtxoEngine` | BlockCypher (`doge/main`) |

### Default Parameters and Environment Specifications

| Parameter | Value | Defined In |
|---|---|---|
| Invoice expiration | 60 minutes (`defaultExpirationMinutes`) | `ConfigManager` |
| Required confirmations | 1 (`defaultConfirmations`) | `ConfigManager` |
| TRON RPC base URL | `https://api.trongrid.io` (`tronRpcUrl`) | `ConfigManager` |
| Polling interval | 30,000 ms (argument of `startPolling`) | `ZeroPayClient` |
| Webhook request timeout | 5,000 ms | `WebhookManager` |
| Scanner request timeout | 10,000 ms | `TronScanner`, `UtxoScanner` |
| `HttpClient` timeout / retries | 10,000 ms / 3 retries | `HttpClient` |
| `HttpClient` backoff | 1,000 ms initial delay, factor 2, capped at 10,000 ms | `HttpClient` |
| Base-unit conversion (USDT, TRX) | 1 unit = 1,000,000 base units | `TronScanner`, `AbiDecoder`, `StateQueryValidator` |
| Base-unit conversion (LTC, DOGE) | 1 unit = 100,000,000 base units | `UtxoScanner` |

The library performs no GPU or large-memory computation. Runtime cost consists of BIP32 public key derivation, outgoing HTTP requests to the configured blockchain APIs, and in-memory storage when `MemoryStorage` is used.

--------------------------------------------------------------------------------

## Technical Details / Architecture

All source code, tests, and configuration files are included in the repository for review.

### Non-Custodial Address Derivation

ZeroPay accepts only extended public keys. Because BIP32 public derivation (non-hardened) is used for the last two path levels, the server can compute every receiving address without access to any private key. Funds sent to a derived address can only be spent by the holder of the corresponding private keys, which are expected to remain in the merchant's wallet outside of this library.

Expected xPub levels and serialization (as used in the unit tests and engine parameters):

| Network | Account-Level Path Used in Tests | Serialization Version Bytes |
|---|---|---|
| Litecoin | `m/84'/2'/0'` | `0x019da462` (`Ltub`) |
| Dogecoin | `m/44'/3'/0'` | `0x02facafd` (`dgub`) |
| TRON | `m/44'/195'/0'` | `0x0488b21e` (standard `xpub`) |

The library derives `xpub/0/<index>` for the receiving address. An xPub serialized with different version bytes (for example `zpub`) is not converted by the library and would be rejected by the BIP32 decoder.

The derivation index is requested through `IStorageAdapter.getLatestDerivationIndex(network)`, which is specified to return the current index and increment it atomically per network so that concurrent invoice requests do not receive the same address.

### Invoice Status Model

| Status | Meaning in the Current Code |
|---|---|
| `PENDING` | Invoice created; no matching payment observed yet. |
| `DETECTED` | A matching transaction was observed (unconfirmed on UTXO networks; indexed by the API on TRON) but the confirmation requirement is not met. |
| `CONFIRMED` | The confirmation requirement is met according to the scanner logic. A webhook is dispatched if `webhookUrl` is configured. |
| `EXPIRED` | The invoice was still `PENDING` when the polling cycle found `Date.now() > expiresAt`. |
| `FAILED` | Defined in the enum. No code path in the current version assigns this status. |

Status progression: `PENDING -> DETECTED -> CONFIRMED`, or `PENDING -> EXPIRED`. A scanner can move an invoice from `PENDING` directly to `CONFIRMED`.

### Payment Detection Logic

* **TRON (USDT):** Requests `/v1/accounts/<address>/transactions/trc20` with `contract_address`, `only_to=true`, and `limit=5`. A transaction matches when its `value` string equals the invoice amount converted to 6-decimal base units. Confirmations are estimated as `floor((now - block_timestamp) / 3000)`, and the invoice is marked `CONFIRMED` when this estimate is greater than or equal to the required confirmations; otherwise it is marked `DETECTED`.
* **TRON (TRX):** Requests `/v1/accounts/<address>/transactions` with `only_to=true` and `limit=5`. A transaction matches when its first contract is of type `TransferContract` and its `amount` equals the invoice amount in sun. The same timestamp-based confirmation estimate is used.
* **Litecoin and Dogecoin:** Requests `/<coin>/main/addrs/<address>` from BlockCypher. Entries in `unconfirmed_txrefs` with `tx_input_n === -1` and a value equal to the invoice amount in base units set a `PENDING` invoice to `DETECTED`. Entries in `txrefs` with the same match conditions set the invoice to `CONFIRMED` when the reported `confirmations` value reaches the requirement, otherwise to `DETECTED`.
* **Failure handling:** All scanner errors (network errors, rate limits, malformed responses, unsupported currency) are caught and result in `null`, meaning no state change in that cycle. The next polling cycle retries.

### Five-Layer Verification Module

`AntiCounterfeitEngine.verify(txData, invoice)` runs the following checks in order and returns on the first failure with the failing layer number and a reason string.

1. **Layer 1, Contract Whitelist:** The contract address must equal the official Tether USDT TRC20 contract (`TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t`, hex `41a614f803b6fd780986a42c78ec9c7f77e6ded13c`), accepted in Base58 or hex form.
2. **Layer 2, TVM Execution Receipt:** `ret[0].contractRet` and `receipt.result`, when present, must equal `SUCCESS`. Payloads with neither field are rejected.
3. **Layer 3, ABI Parameter Decoding:** The call data must be exactly 136 hexadecimal characters, begin with selector `a9059cbb` (`transfer(address,uint256)`), and decode to a recipient and amount that equal the invoice receiving address and the invoice amount in base units.
4. **Layer 4, State Query:** A `triggerconstantcontract` call to `balanceOf(address)` on the official contract must return a balance greater than or equal to the invoice amount.
5. **Layer 5, Consensus Finality:** The transaction block number must be less than or equal to the latest block number returned by the solidified node endpoint (`/walletsolidity/getnowblock`).

### Source Code Modules & Engine Components

* **[index.ts](src/index.ts)**
  * **Role:** Package Entry Point.
  * **Implementation:** Re-exports `types`, `ZeroPayClient`, `ConfigManager`, `WebhookManager`, `MemoryStorage`, `HttpClient`, `CryptoUtils`, and all six modules of the security directory. The engines and scanners are not re-exported.

* **[types/index.ts](src/types/index.ts)**
  * **Role:** Core Data Models and Interfaces.
  * **Implementation:** Defines the enums `Currency` (`USDT`, `TRX`, `LTC`, `DOGE`), `Network` (`TRON`, `LITECOIN`, `DOGECOIN`), and `InvoiceStatus`; the interfaces `IZeroPayConfig`, `IInvoice` (amount stored as a string), `IStorageAdapter`, and `IAddressGenerationResult`.

* **[ZeroPayClient.ts](src/core/ZeroPayClient.ts)**
  * **Role:** Primary Execution Wrapper.
  * **Implementation:** The constructor processes the configuration through `ConfigManager`, selects `MemoryStorage` when no adapter is supplied, and creates a `ScannerFactory`. Provides `createInvoice(amount, currency, network)`, `startPolling(intervalMs = 30000)` (throws if polling is already running), and `stopPolling()`. The private polling cycle retrieves active invoices, expires overdue `PENDING` invoices, scans the remaining ones, persists status changes, and dispatches a webhook when an invoice becomes `CONFIRMED`. Errors inside a cycle are caught and discarded.

* **[ConfigManager.ts](src/core/ConfigManager.ts)**
  * **Role:** Configuration Validation and Defaults.
  * **Implementation:** Requires a non-empty `webhookSecret` string; requires `webhookUrl` and `tronRpcUrl` (when supplied) to be parseable URLs with `http:` or `https:` protocol; requires each supplied xPub to be 100 to 120 characters long; requires `defaultConfirmations` to be a non-negative integer and `defaultExpirationMinutes` to be a positive integer. Applies defaults for `tronRpcUrl`, `defaultExpirationMinutes`, and `defaultConfirmations`.

* **[WebhookManager.ts](src/core/WebhookManager.ts)**
  * **Role:** Signed Webhook Dispatcher.
  * **Implementation:** `WebhookManager.dispatch(invoice, webhookUrl, webhookSecret)` serializes the invoice with `JSON.stringify`, computes a hex HMAC-SHA256 digest of that string, and sends it as the request body with headers `Content-Type: application/json` and `X-ZeroPay-Signature`. Timeout is 5,000 ms. Returns `true` for an HTTP 2xx response and `false` on any error or non-2xx result.

* **[AddressGenerator.ts](src/engines/AddressGenerator.ts)**
  * **Role:** Address Generation Facade.
  * **Implementation:** Selects the configured xPub for the requested network (`xpubLitecoin`, `xpubDogecoin`, `xpubTron`), throws a descriptive error when it is missing, and delegates to `UtxoEngine` or `TrvmEngine`.

* **[UtxoEngine.ts](src/engines/UtxoEngine.ts)**
  * **Role:** Litecoin and Dogecoin Address Derivation.
  * **Implementation:** Defines custom `bitcoinjs-lib` network parameter objects for Litecoin (bech32 `ltc`, pubKeyHash `0x30`, scriptHash `0x32`, WIF `0xb0`) and Dogecoin (pubKeyHash `0x1e`, scriptHash `0x16`, WIF `0x9e`, no bech32). Initializes `bip32` with `tiny-secp256k1`, decodes the xPub with the network parameters, derives `0/<index>`, and builds a `p2wpkh` payment for Litecoin or a `p2pkh` payment for Dogecoin.

* **[TrvmEngine.ts](src/engines/TrvmEngine.ts)**
  * **Role:** TRON Address Derivation.
  * **Implementation:** Decodes the xPub with the default Bitcoin serialization, derives `0/<index>`, converts the compressed public key to an EVM address with `ethers` (`utils.computeAddress`), replaces the `0x` prefix with `41`, and converts to Base58Check using `TronWeb.address.fromHex`. Throws if the result does not begin with `T`.

* **[ScannerFactory.ts](src/scanners/ScannerFactory.ts)**
  * **Role:** Scanner Routing.
  * **Implementation:** Instantiates `TronScanner` and `UtxoScanner` and routes `scan(invoice, requiredConfirmations)` by `invoice.network`. Throws for networks that have no scanner.

* **[TronScanner.ts](src/scanners/TronScanner.ts)**
  * **Role:** TRON Payment Scanner.
  * **Implementation:** Creates an axios client with base URL `config.tronRpcUrl` (or the TronGrid default), a 10,000 ms timeout, and the `TRON-PRO-API-KEY` header when `tronApiKey` is configured. Implements the TRC20 USDT and native TRX detection logic described above and returns an updated invoice object only when the computed status differs from the current one.

* **[UtxoScanner.ts](src/scanners/UtxoScanner.ts)**
  * **Role:** Litecoin and Dogecoin Payment Scanner.
  * **Implementation:** Creates an axios client for `https://api.blockcypher.com/v1` with a 10,000 ms timeout and no authentication token. Implements the unconfirmed and confirmed transaction matching described above. The configuration argument is accepted but unused.

* **[ContractWhitelist.ts](src/security/ContractWhitelist.ts)**
  * **Role:** Verification Layer 1.
  * **Implementation:** Compares a candidate contract address with the official USDT contract in Base58 form, in hex form (case-insensitive, with or without a `0x` prefix variant), and through `TronWeb.address.toHex` normalization.

* **[TvmReceiptValidator.ts](src/security/TvmReceiptValidator.ts)**
  * **Role:** Verification Layer 2.
  * **Implementation:** Evaluates the `ret` array and `receipt` object of a TRON transaction payload and returns `true` only when no failure value is present and at least one of the two structures exists.

* **[AbiDecoder.ts](src/security/AbiDecoder.ts)**
  * **Role:** Verification Layer 3.
  * **Implementation:** Strips an optional `0x` prefix, enforces a 136-character length, verifies the `a9059cbb` selector, extracts the 20-byte recipient from the left-padded 32-byte word, prefixes `41`, converts it to Base58 with TronWeb, and parses the amount word as a `bigint`. `validateTransferParameters` additionally compares the decoded recipient and amount with the expected values.

* **[StateQueryValidator.ts](src/security/StateQueryValidator.ts)**
  * **Role:** Verification Layer 4.
  * **Implementation:** Sends a `POST /wallet/triggerconstantcontract` request for `balanceOf(address)` on the official USDT contract and parses the first `constant_result` entry as a `bigint`. `verifyBalanceSufficiency` returns `false` on any error.

* **[ConsensusFinalityValidator.ts](src/security/ConsensusFinalityValidator.ts)**
  * **Role:** Verification Layer 5.
  * **Implementation:** Sends `POST /walletsolidity/getnowblock`, reads `block_header.raw_data.number`, and returns whether the transaction block number is less than or equal to it. Returns `false` on any error.

* **[AntiCounterfeitEngine.ts](src/security/AntiCounterfeitEngine.ts)**
  * **Role:** Verification Pipeline Orchestrator.
  * **Implementation:** Constructs the Layer 4 and Layer 5 validators with the configured `tronRpcUrl` (or the TronGrid default) and an optional injected `HttpClient`. `verify` returns an `IValidationResult` containing `isValid`, and on failure `failureReason` and `layerFailed`. The caller must supply the transaction data (`IRawTronTransactionData`); no code in the library fetches it.

* **[MemoryStorage.ts](src/storage/MemoryStorage.ts)**
  * **Role:** Default In-Memory Storage Adapter.
  * **Implementation:** Stores invoices in a `Map` keyed by ID and derivation indices in a `Map` keyed by network. `getInvoiceByAddress` performs a linear scan. `getLatestDerivationIndex` returns the current value and increments it. `getActiveInvoices` (not part of `IStorageAdapter`) returns invoices with status `PENDING` or `DETECTED`. All data is lost when the process exits.

* **[http.ts](src/utils/http.ts)**
  * **Role:** HTTP Client with Retry.
  * **Implementation:** Wraps an axios instance (10,000 ms default timeout) and retries failed requests up to the configured count with exponential backoff. The default retry condition covers responses that never arrived, HTTP 429, and HTTP 500 to 599. Exposes `request`, `get`, and `post`.

* **[crypto.ts](src/utils/crypto.ts)**
  * **Role:** Cryptographic and Validation Utilities.
  * **Implementation:** `verifyHmacSignature` (HMAC-SHA256 with `crypto.timingSafeEqual` and a length check), `sha256`, `doubleSha256`, `isValidTronAddress` (prefix `T`, length 34, `TronWeb.isAddress`), `isValidLitecoinAddress` and `isValidDogecoinAddress` (prefix and length checks only).

* **Tests ([core.test.ts](tests/core.test.ts), [engines.test.ts](tests/engines.test.ts), [scanners.test.ts](tests/scanners.test.ts), [security.test.ts](tests/security.test.ts))**
  * **Role:** Jest Unit and Integration Tests.
  * **Implementation:** Cover configuration validation, in-memory storage behavior, webhook signature generation and verification, invoice creation and polling state, address derivation for all three networks (including uniqueness of 100 consecutive TRON addresses), scanner behavior with mocked axios responses, and each of the five verification layers and the orchestrator with mocked HTTP responses.

<table>
  <thead>
    <tr>
      <th align="left">Test Suite</th>
      <th align="left">Scope</th>
      <th align="right">Tests</th>
      <th align="right">Result</th>
      <th align="right">Suite Time</th>
    </tr>
  </thead>
  <tbody>
    <tr><td><code>tests/core.test.ts</code></td><td>ConfigManager, MemoryStorage, WebhookManager, ZeroPayClient</td><td align="right">11</td><td align="right">PASS</td><td align="right">6.873 s</td></tr>
    <tr><td><code>tests/engines.test.ts</code></td><td>UtxoEngine, TrvmEngine, AddressGenerator, collision resistance</td><td align="right">8</td><td align="right">PASS</td><td align="right">10.296 s</td></tr>
    <tr><td><code>tests/scanners.test.ts</code></td><td>TronScanner, UtxoScanner, ScannerFactory</td><td align="right">6</td><td align="right">PASS</td><td align="right">not reported</td></tr>
    <tr><td><code>tests/security.test.ts</code></td><td>Verification layers 1 to 5, AntiCounterfeitEngine</td><td align="right">18</td><td align="right">PASS</td><td align="right">5.115 s</td></tr>
    <tr><td><b>Total</b></td><td>4 suites</td><td align="right"><b>43</b></td><td align="right"><b>43 passed</b></td><td align="right"><b>11.669 s</b></td></tr>
  </tbody>
</table>

<details>
<summary><b>Raw test output (<code>npm test</code>): 4 suites passed, 43 tests passed. Click to expand or collapse.</b></summary>

```text
D:\Zero\Project\TypeScript.Nodsjs\ZeroPay> npm test

> zeropay-core@1.0.0 test
> jest

 PASS  tests/scanners.test.ts
  Blockchain Scanners and Factory
    TronScanner
      √ should detect incoming TRC20 USDT transfer when amount matches exactly (15 ms)
      √ should return null if no matching transactions are returned by TronGrid (1 ms)
      √ should fail silently and return null on network exception
    UtxoScanner
      √ should detect unconfirmed UTXO transaction in mempool and set status to DETECTED (1 ms)
      √ should confirm UTXO transaction when confirmations meet requirement (1 ms)
    ScannerFactory
      √ should correctly route TRON invoices to TronScanner and UTXO invoices to UtxoScanner (1 ms)

 PASS  tests/security.test.ts (5.115 s)
  Anti-Counterfeit & Anti-Flash Subsystem
    Layer 1: ContractWhitelist
      √ should approve official Tether contract in Base58 format (8 ms)
      √ should approve official Tether contract in Hex format
      √ should reject spoofed or fake contract addresses (1 ms)
      √ should safely reject empty or non-string inputs
    Layer 2: TvmReceiptValidator
      √ should validate successful execution receipt with contractRet SUCCESS (1 ms)
      √ should reject transactions that were reverted or ran out of energy
      √ should reject malformed or empty execution payloads
    Layer 3: AbiDecoder
      √ should decode genuine transfer(address,uint256) data and match parameters (3 ms)
      √ should reject transaction if method selector is not transfer (e.g. approve 095ea7b3) (1 ms)
      √ should reject transaction if transfer amount does not match invoice requirements
      √ should reject transaction if recipient address does not match invoice receiving address (1 ms)
    Layer 4: StateQueryValidator
      √ should query on-chain balance and confirm sufficiency using mocked HTTP client (2 ms)
    Layer 5: ConsensusFinalityValidator
      √ should verify transaction finality when block number is below or equal to solidified block (1 ms)
    AntiCounterfeitEngine Pipeline Orchestrator
      √ should completely approve transaction passing all 5 verification layers (1 ms)
      √ should halt and fail at Layer 1 if counterfeit contract is detected (1 ms)
      √ should halt and fail at Layer 2 if transaction execution failed in TVM (1 ms)
      √ should halt and fail at Layer 3 if ABI parameters mismatch invoice (1 ms)
      √ should halt and fail at Layer 5 if block is unsolidified (1 ms)

 PASS  tests/core.test.ts (6.873 s)
  Core Orchestration and Utilities
    ConfigManager
      √ should validate complete configuration and apply deterministic defaults (10 ms)
      √ should throw an error if webhookSecret is empty or missing (15 ms)
      √ should throw an error if webhookUrl has an invalid protocol (1 ms)
      √ should throw an error if xPub format fails length boundary check (1 ms)
    MemoryStorage
      √ should atomically retrieve and increment derivation indices per network
      √ should persist, retrieve, and update invoice records correctly (1 ms)
      √ should accurately filter active invoices (PENDING and DETECTED)
    WebhookManager
      √ should generate valid HMAC-SHA256 signature and dispatch POST payload (2 ms)
      √ should return false when destination server returns HTTP error status
    ZeroPayClient
      √ should construct an invoice atomically with valid cryptographic address and metadata (106 ms)
      √ should manage polling cycle interval state safely (2 ms)

 PASS  tests/engines.test.ts (10.296 s)
  Cryptographic Address Derivation Engines
    UtxoEngine
      √ should derive valid Native SegWit addresses for Litecoin (20 ms)
      √ should derive valid Legacy P2PKH addresses for Dogecoin (11 ms)
      √ should throw an error if an unsupported network is requested (12 ms)
    TrvmEngine
      √ should derive valid Base58Check addresses for TRON (143 ms)
      √ should throw an error if a non-TRON network is passed to TrvmEngine (3 ms)
    AddressGenerator Facade
      √ should route derivation requests correctly across all supported networks (46 ms)
      √ should throw explicit error when an xPub is missing from the configuration (2 ms)
    Checkpoint Alpha: Mathematical Collision Resistance
      √ should derive 100 consecutive TRON addresses with 100% uniqueness (3256 ms)

Test Suites: 4 passed, 4 total
Tests:       43 passed, 43 total
Snapshots:   0 total
Time:        11.669 s
Ran all test suites.
Force exiting Jest: Have you considered using `--detectOpenHandles` to detect async operations that kept running after all tests finished?
PS D:\Zero\Project\TypeScript.Nodsjs\ZeroPay>
```

</details>

* **[server.ts](demo-store/server.ts)**
  * **Role:** Local Merchant Simulation Server (Demo Store).
  * **Implementation:** An Express application in the separate `demo-store` package (`demo-store/package.json`, private, depends on `express ^4.18.2`, started with `ts-node server.ts`) that imports `ZeroPayClient`, `Currency`, `Network`, and `IZeroPayConfig` directly from `../src`. It builds a configuration with a hard-coded simulation xPub (assigned to both `xpubTron` and `xpubLitecoin`), a hard-coded `webhookSecret`, `webhookUrl` set to `http://localhost:3000/webhook`, `defaultExpirationMinutes` of 15, and `defaultConfirmations` of 1. It creates a `ZeroPayClient` with the default `MemoryStorage` and calls `startPolling(15000)` at startup. It exposes `POST /checkout`, which creates a fixed 50.00 USDT invoice on TRON and returns it as JSON (HTTP 200) or returns the error message (HTTP 500), and `POST /webhook`, which logs the `x-zeropay-signature` header and the body parsed by `express.json()` to the console and responds with HTTP 200 `OK` without verifying the signature. The server listens on port 3000 (hard-coded).

* **Project Configuration**
  * **Role:** Build, Lint, Format, and Test Settings.
  * **Implementation:** `tsconfig.json` (strict compiler options, `rootDir` `./src`, `outDir` `./dist`, declaration output, `noUnusedLocals`, `noUnusedParameters`), `jest.config.js` (`ts-jest` preset, Node test environment, tests matched by `**/tests/**/*.test.ts`), `.eslintrc.json` (`@typescript-eslint` recommended rules, `no-explicit-any` as error), `.prettierrc` (single quotes, trailing commas, print width 100), and `.gitignore`.

--------------------------------------------------------------------------------

## Current Status

This is the initial version of ZeroPay (1.0.0). It is not complete and it is not free of defects. The following components are implemented in the source code:

* **Address derivation** for TRON, Litecoin, and Dogecoin from xPubs, with unit tests for address format, per-index uniqueness, network routing, and error cases.
* **Invoice creation** with per-network derivation indices, UUID identifiers, and expiration timestamps.
* **Polling loop** with start and stop control, expiration of overdue `PENDING` invoices, scanner routing, status persistence, and webhook dispatch on `CONFIRMED`.
* **Scanners** for TRC20 USDT, native TRX, Litecoin, and Dogecoin. Scanner tests use mocked HTTP responses; this repository does not contain tests that run against live networks.
* **Signed webhooks** with HMAC-SHA256 and a timing-safe verification helper.
* **Five-layer verification module** with unit tests for each layer and the orchestrator. It is implemented as a standalone component and is not part of the polling pipeline.
* **Configuration validation** and **in-memory storage**.

The library has not been independently audited. Test suites are included but their results are not documented in this README.

--------------------------------------------------------------------------------

## Assumptions & Limitations

This is an initial version and it is not flawless. The following known limitations and assumptions apply. Anyone intending to process real funds should review the source code and test the behavior independently before use.

1. **Verification module is not integrated.** `AntiCounterfeitEngine` is not called by `TronScanner` or `ZeroPayClient`. TRON payments are currently detected from the transaction list returned by the TronGrid-compatible API (filtered by the USDT contract address in the request) without executing the five-layer pipeline. The module requires the caller to provide raw transaction data, which no part of the library retrieves.
2. **Verification Layer 4 checks the total balance.** `StateQueryValidator` compares the current `balanceOf` result for the receiving address with the invoice amount. It does not isolate the specific transaction, so a balance that existed before the transaction could satisfy the check.
3. **TRON confirmations are estimated.** Confirmation counts are derived from the transaction timestamp divided by 3 seconds, not from the actual block height difference. `TronScanner` does not use the solidified block check of `ConsensusFinalityValidator`.
4. **Exact amount matching.** Scanners match the invoice amount exactly. Underpayments, overpayments, split payments, and multiple payments to one address are not handled. The `FAILED` status is defined but never assigned.
5. **Floating-point amount conversion.** Amounts are stored as strings, but conversion to base units uses `parseFloat` multiplied by 1,000,000 or 100,000,000 and `Math.floor`. Floating-point representation can produce an off-by-one base-unit result for some decimal inputs. The amount string format is not validated by `createInvoice`, and `createInvoice` does not verify that the currency is valid for the selected network.
6. **Storage interface gap.** `IStorageAdapter` has no method for listing active invoices. The polling cycle uses `getActiveInvoices`, which exists only on `MemoryStorage`. With a custom adapter the cycle throws internally and the error is discarded, so no invoices are scanned. Custom adapters therefore cannot currently be used with polling.
7. **No persistence by default.** `MemoryStorage` loses all invoices and resets derivation indices to zero when the process restarts. After a restart, address indices are issued again from zero, which re-issues previously used addresses for new invoices.
8. **Single-process assumption.** The atomicity of the derivation index relies on `MemoryStorage` running in one Node.js process. Multi-process or multi-instance deployments require an adapter with a truly atomic counter.
9. **Silent error handling.** Scanner errors and polling-cycle errors are swallowed without logging, so failures (rate limits, timeouts, malformed responses, storage errors) are not visible to the application.
10. **Webhook delivery is single-attempt.** `WebhookManager` makes one request with a 5,000 ms timeout. The return value is ignored by `ZeroPayClient`, there is no retry queue, and once an invoice is `CONFIRMED` it is no longer returned by `getActiveInvoices`, so a failed webhook is not re-sent. The signed payload is the invoice JSON only; it contains no event identifier or delivery timestamp, so replay protection must be implemented by the receiver.
11. **Polling behavior.** The interval timer does not prevent a new cycle from starting while the previous one is still running. Invoices are scanned sequentially. Only `PENDING` invoices are expired; a `DETECTED` invoice never expires. Expired invoices are no longer scanned, so payments that arrive after expiration are not detected.
12. **Third-party API dependence.** Payment detection depends on the availability, response format, and rate limits of the configured TronGrid-compatible endpoint and of BlockCypher. `UtxoScanner` uses BlockCypher without an API token and ignores the configuration object. `AntiCounterfeitEngine` creates its `HttpClient` without the `tronApiKey` header. Scanners use axios directly and do not use the retry logic of `HttpClient`.
13. **TRX path verification.** The native TRX scanner relies on the `only_to` request filter for destination matching and checks only the contract type and amount; it does not independently verify the recipient address or execution result.
14. **xPub validation is shallow.** `ConfigManager` validates xPubs by string length only (100 to 120 characters). Correct version bytes are enforced only when a key is decoded during address derivation. Address validators for Litecoin and Dogecoin in `CryptoUtils` check prefix and length only and do not verify checksums. The library does not apply an address gap limit or any xPub privacy measure; anyone holding an xPub can derive every address generated from it.
15. **Fixed mainnet parameters.** Network parameters, USDT contract address, and decimal precision are hard-coded for mainnet. Testnets and other TRC20 or UTXO assets are not supported.
16. **Address types.** Litecoin supports Native SegWit (P2WPKH) only and Dogecoin supports Legacy P2PKH only, with the xPub serialization versions listed in the Technical Details section.
17. **Public API surface.** `AddressGenerator`, `UtxoEngine`, `TrvmEngine`, `ScannerFactory`, `TronScanner`, and `UtxoScanner` are not exported from `src/index.ts`. The `dev` and `start` scripts execute the entry point, which only exports modules and performs no action.
18. **Dependencies.** `bip39` is listed in `package.json` but is not imported by the current source code. `tronweb` is loaded with `require` and is not type-checked. `ethers` version 5 is used only for address computation.
19. **Test scope.** Tests rely on mocked network responses. Behavior against live blockchain APIs, real wallet-exported xPubs, and production load has not been verified in this repository.

--------------------------------------------------------------------------------

## Usage / Requirements

**Runtime Requirements:**
* **Runtime:** Node.js with support for ES2022 and `crypto.randomUUID`. `package.json` does not declare an `engines` field; the development type definitions target Node.js 20.
* **Package Manager:** npm.
* **Network Access:** Outbound HTTPS access to the configured TRON API endpoint and to `api.blockcypher.com` (for Litecoin and Dogecoin), plus access to the merchant's webhook URL.
* **Wallet:** A wallet that can export account-level extended public keys for the intended networks in the serialization formats listed above.

**Dependencies (from `package.json`):**
* **Runtime:** `axios ^1.6.0`, `bip32 ^4.0.0`, `bip39 ^3.1.0`, `bitcoinjs-lib ^6.1.5`, `ethers ^5.7.2`, `tiny-secp256k1 ^2.2.3`, `tronweb ^5.3.0`.
* **Development:** `typescript ^5.3.2`, `ts-node ^10.9.1`, `jest ^29.7.0`, `ts-jest ^29.1.1`, `@types/jest`, `@types/node`, `eslint ^8.54.0`, `@typescript-eslint/eslint-plugin` and `@typescript-eslint/parser ^6.13.1`, `prettier ^3.1.0`.

**Compilation & Build Instructions:**

1. **Obtain the source:** clone the repository and change into its directory.
   ```bash
   git clone <repository-url>
   cd <repository-directory>
   ```
2. **Install dependencies:**
   ```bash
   npm install
   ```
3. **Build:** compiles `src/` to `dist/` using `tsc`.
   ```bash
   npm run build
   ```
4. **Run tests:**
   ```bash
   npm test
   ```
5. **Lint and format (optional):**
   ```bash
   npm run lint
   npm run format
   ```

The package entry points are `dist/index.js` (`main`) and `dist/index.d.ts` (`types`). The package name is `zeropay-core`; how it is installed into a consuming project (local path, registry, or repository reference) is left to the integrator.

**Usage Example:**

```typescript
import { ZeroPayClient, Currency, Network } from 'zeropay-core';

const client = new ZeroPayClient({
  webhookSecret: process.env.ZEROPAY_WEBHOOK_SECRET as string,
  webhookUrl: 'https://merchant.example.com/zeropay/webhook',
  xpubTron: process.env.ZEROPAY_XPUB_TRON,
  tronApiKey: process.env.TRONGRID_API_KEY,
  defaultConfirmations: 1,
  defaultExpirationMinutes: 60,
});

// Create an invoice. The receiving address is derived from the TRON xPub.
const invoice = await client.createInvoice('50.00', Currency.USDT, Network.TRON);
console.log(invoice.id, invoice.receivingAddress, invoice.expiresAt);

// Start the polling cycle (interval in milliseconds).
client.startPolling(30000);

// Stop polling when shutting down.
client.stopPolling();
```

A TRON xPub is required to create TRON invoices; `xpubLitecoin` and `xpubDogecoin` are required for Litecoin and Dogecoin invoices. Only the xPubs for the networks in use need to be supplied.

**Webhook Verification (receiver side):**

The signature is computed over the exact request body string. Verify it before parsing, using the raw body as received.

```typescript
import { CryptoUtils } from 'zeropay-core';

function isAuthenticWebhook(rawBody: string, signatureHeader: string, secret: string): boolean {
  return CryptoUtils.verifyHmacSignature(rawBody, signatureHeader, secret);
}
```

The request body is the JSON serialization of the invoice object (`id`, `amount`, `currency`, `network`, `receivingAddress`, `derivationIndex`, `status`, `confirmations`, `txHash`, `createdAt`, `expiresAt`), and the signature is sent in the `X-ZeroPay-Signature` header as a hexadecimal string.

**Configuration Reference (`IZeroPayConfig`):**

| Field | Required | Description |
|---|---|---|
| `webhookSecret` | Yes | Non-empty secret used for HMAC-SHA256 webhook signatures. |
| `webhookUrl` | No | HTTP or HTTPS URL receiving webhooks on `CONFIRMED`. |
| `xpubTron` | No | Account-level xPub for TRON address derivation. |
| `xpubLitecoin` | No | Account-level xPub (Ltub serialization) for Litecoin. |
| `xpubDogecoin` | No | Account-level xPub (dgub serialization) for Dogecoin. |
| `tronRpcUrl` | No | TronGrid-compatible base URL. Default `https://api.trongrid.io`. |
| `tronApiKey` | No | Sent as `TRON-PRO-API-KEY` by `TronScanner`. |
| `defaultConfirmations` | No | Non-negative integer. Default 1. |
| `defaultExpirationMinutes` | No | Positive integer. Default 60. |

--------------------------------------------------------------------------------

## License

Released under the MIT License, as declared in `package.json`.

--------------------------------------------------------------------------------
