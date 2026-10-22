<h1 align="center">
  ZeroPay: Non-Custodial, Self-Hosted<br>
  Cryptocurrency Payment Processor for Node.js
</h1>

<div align="center">
<i>A TypeScript library for generating deterministic per-invoice receiving addresses from extended public keys (xPub) and Ed25519 view/spend key pairs, and monitoring incoming payments on TRON, Litecoin, Dogecoin, and Monero.</i>
<br><br>
<b>Developer:</b> Zero-AI-Native (Age 15, assisted by Google Gemini 4 Argon) <br>
<b>Package:</b> zeropay-core 1.0.0 (MIT License)<br>
<b>Architecture:</b> TypeScript / Node.js / BIP32 HD & CryptoNote Ed25519 Subaddress Derivation<br>
<b>Status:</b> Initial Version (functional core, known limitations documented below)
</div>

--------------------------------------------------------------------------------

## Overview

ZeroPay is a Node.js library that lets a merchant accept cryptocurrency payments on a self-hosted server without handing custody of funds to a third party. The library never receives or stores private spending keys. It is configured with account-level extended public keys (xPub) for TRON, Litecoin, and Dogecoin, and with a 32-byte public spend key (`moneroPublicSpendKey`) and 32-byte private view key (`moneroPrivateViewKey`) for Monero. From these keys it derives a unique receiving address or Monero subaddress for every invoice, then periodically queries blockchain APIs or RPC nodes to determine whether that address has received the expected amount. When an invoice reaches the `CONFIRMED` status, the library can send an HMAC-SHA256 signed webhook to a merchant-defined URL.

The library is written in TypeScript (strict mode, ES2022 target, CommonJS output) and is distributed as a single package entry point (`dist/index.js`). It does not run as a standalone server or command-line tool; it is intended to be imported and driven by the merchant's own application.

The implemented functionality is organized into the following mechanisms:

1. **Deterministic Address Derivation (BIP32 & CryptoNote Ed25519):** For BIP32 networks, decodes an account-level xPub and derives the child node at path `0/<index>` (external chain, then the invoice-specific index). Litecoin addresses are generated as Native SegWit (P2WPKH, `ltc1...`), Dogecoin addresses as Legacy P2PKH (`D...`), and TRON addresses by computing the EVM-style Keccak-256 address of the derived public key, prefixing the TRON network byte `0x41`, and applying Base58Check encoding (`T...`). For Monero, `CryptonoteEngine` derives a unique 95-character Mainnet subaddress (`8...`, prefix `0x2a`) at major account index `0` and minor index `index + 1` from the merchant's public spend key and private view key using Ed25519 scalar and point operations and Monero block-based Base58 encoding.
2. **Invoice Lifecycle Management:** `ZeroPayClient.createInvoice` validates the decimal amount format and verifies that the requested currency is valid for the selected network, obtains a per-network derivation index from the storage adapter, generates the receiving address, assigns a UUID (`crypto.randomUUID`), computes an expiration timestamp, and persists the invoice with status `PENDING`.
3. **Polling-Based Payment Detection:** `ZeroPayClient.startPolling` runs an interval timer (default 30,000 ms) guarded by a boolean re-entrancy lock (`isPollingCycleRunning`) that retrieves active invoices via `IStorageAdapter.getActiveInvoices`, marks overdue `PENDING` invoices as `EXPIRED`, routes the remaining invoices to the network-specific scanner through `ScannerFactory`, and persists updated statuses, transaction hashes, and confirmation counts.
4. **Network Scanners:** `TronScanner` queries a TronGrid-compatible HTTP API for incoming TRC20 USDT transfers and native TRX transfers. `UtxoScanner` queries the BlockCypher API for confirmed and unconfirmed transactions on Litecoin and Dogecoin. `MoneroScanner` supports two modes: querying a watch-only `monero-wallet-rpc` (`POST /json_rpc`, method `get_transfers`) when `moneroWalletRpcUrl` is configured, or querying a Monero daemon endpoint (`POST /get_transactions`) and verifying candidate RingCT outputs through `MoneroAntiSpoofEngine`.
5. **Signed Webhook Delivery:** `WebhookManager` serializes the invoice to JSON, signs the exact payload string with HMAC-SHA256 using the configured `webhookSecret`, and sends an HTTP POST with the signature in the `X-ZeroPay-Signature` header. `CryptoUtils.verifyHmacSignature` provides a timing-safe verification routine for the receiving side.
6. **Five-Layer Verification Modules (TRC20 & Monero RingCT):** `AntiCounterfeitEngine` combines five sequential checks for TRON TRC20 transfers (contract whitelist, TVM execution receipt, ABI parameter decoding, on-chain `balanceOf` query, and solidified block finality) as a standalone module. `MoneroAntiSpoofEngine` combines five sequential checks for Monero transactions (Ed25519 curve and torsion subgroup validation, execution flag and `unlock_time` timelock validation, ECDH stealth output ownership proof, RingCT amount decryption and Pedersen Commitment verification, and block confirmation finality). Layers 1 to 4 of `MoneroAntiSpoofEngine` are invoked by `MoneroScanner` during daemon-mode scanning.
7. **Pluggable Storage:** Persistence is abstracted behind the `IStorageAdapter` interface (`saveInvoice`, `getInvoiceById`, `getInvoiceByAddress`, `updateInvoiceStatus`, `getLatestDerivationIndex`, and `getActiveInvoices`). `MemoryStorage` is the default in-memory implementation intended for testing and prototyping.
8. **Configuration Validation:** `ConfigManager` validates the supplied configuration with fail-fast errors and applies default values for optional fields.
9. **HTTP Client with Retry:** `HttpClient` wraps axios with a request timeout and an exponential backoff retry loop for network-level failures, HTTP 429, and HTTP 5xx responses. It is used by the verification module.

### Supported Networks and Currencies

| Network | Currencies | Address Format | Derivation Engine | Data Source |
|---|---|---|---|---|
| TRON | USDT (TRC20), TRX | Base58Check, begins with `T`, 34 characters | `TrvmEngine` | TronGrid-compatible API (`https://api.trongrid.io` by default) |
| Litecoin | LTC | Native SegWit Bech32, begins with `ltc1` | `UtxoEngine` | BlockCypher (`ltc/main`) |
| Dogecoin | DOGE | Legacy P2PKH, begins with `D`, 34 characters | `UtxoEngine` | BlockCypher (`doge/main`) |
| Monero | XMR | Monero Block-Based Base58 Subaddress, begins with `8`, 95 characters | `CryptonoteEngine` | Monero Daemon RPC (`https://xmr-node.cakewallet.com:18081` by default) or Watch-Only Wallet RPC (`moneroWalletRpcUrl`) |

### Default Parameters and Environment Specifications

| Parameter | Value | Defined In |
|---|---|---|
| Invoice expiration | 60 minutes (`defaultExpirationMinutes`) | `ConfigManager` |
| Required confirmations | 1 (`defaultConfirmations`) | `ConfigManager` |
| TRON RPC base URL | `https://api.trongrid.io` (`tronRpcUrl`) | `ConfigManager` |
| Monero RPC base URL | `https://xmr-node.cakewallet.com:18081` (`moneroRpcUrl`) | `ConfigManager`, `MoneroScanner`, `MoneroFinalityValidator` |
| Polling interval | 30,000 ms (argument of `startPolling`) | `ZeroPayClient` |
| Webhook request timeout | 5,000 ms | `WebhookManager` |
| Scanner request timeout | 10,000 ms | `TronScanner`, `UtxoScanner`, `MoneroScanner` |
| `HttpClient` timeout / retries | 10,000 ms / 3 retries | `HttpClient` |
| `HttpClient` backoff | 1,000 ms initial delay, factor 2, capped at 10,000 ms | `HttpClient` |
| Base-unit conversion (USDT, TRX) | 1 unit = 1,000,000 base units (6 decimals) | `TronScanner` (`CryptoUtils.amountToBaseUnits`), `AbiDecoder`, `StateQueryValidator` |
| Base-unit conversion (LTC, DOGE) | 1 unit = 100,000,000 base units (8 decimals) | `UtxoScanner` (`CryptoUtils.amountToBaseUnits`) |
| Base-unit conversion (XMR) | 1 unit = 1,000,000,000,000 base units (piconero, 12 decimals) | `MoneroCryptoUtils`, `CryptoUtils.amountToBaseUnits`, `RingCtVerifier`, `MoneroScanner` |

The library performs no GPU or large-memory computation. Runtime cost consists of BIP32 public key derivation, Ed25519 curve and Keccak-256 operations for Monero, outgoing HTTP requests to the configured blockchain APIs, and in-memory storage when `MemoryStorage` is used.

--------------------------------------------------------------------------------

## Technical Details / Architecture

All source code, tests, and configuration files are included in the repository for review.

### Non-Custodial Address Derivation

ZeroPay never accepts private spending keys. On BIP32 networks, because non-hardened public derivation is used for the last two path levels, the server computes receiving addresses from extended public keys (xPub) alone. On Monero, the server computes subaddresses and verifies incoming outputs using only the public spend key and private view key, which cannot sign transactions or compute key images to spend funds. Funds sent to a derived address can only be spent by the holder of the corresponding private spend keys outside of this library.

Expected xPub levels and serialization (as used in the unit tests and engine parameters):

| Network | Account-Level Path Used in Tests | Serialization Version Bytes |
|---|---|---|
| Litecoin | `m/84'/2'/0'` | `0x019da462` (`Ltub`) |
| Dogecoin | `m/44'/3'/0'` | `0x02facafd` (`dgub`) |
| TRON | `m/44'/195'/0'` | `0x0488b21e` (standard `xpub`) |

The library derives `xpub/0/<index>` for the receiving address on BIP32 networks. An xPub serialized with different version bytes (for example `zpub`) is not converted by the library and would be rejected by the BIP32 decoder.

For Monero, the library uses `moneroPublicSpendKey` ($B$, 32-byte compressed Ed25519 point in 64-character hex) and `moneroPrivateViewKey` ($a$, 32-byte scalar in 64-character hex). In `CryptonoteEngine.deriveSubaddressKeys`, the zero-based invoice `index` is mapped to `majorIndex = 0` and `minorIndex = index + 1` (since `(0, 0)` corresponds to the primary `4...` address). It constructs the 48-byte buffer `"SubAddr\0" || a || uint32_le(majorIndex) || uint32_le(minorIndex)`, hashes it with Keccak-256 reduced modulo the Ed25519 curve order $l$ to obtain scalar $m$, computes the subaddress public spend key $D = B + mG$ and subaddress public view key $C = a \cdot D$, prepends network byte `0x2a` (42), appends a 4-byte Keccak-256 checksum, and encodes the 69-byte buffer into a 95-character string starting with `8` using Monero's block-based Base58 encoding (8 blocks of 8 bytes encoded into 11 characters each, followed by a 5-byte block encoded into 7 characters).

The derivation index is requested through `IStorageAdapter.getLatestDerivationIndex(network)`, which is specified to return the current index and increment it atomically per network so that concurrent invoice requests do not receive the same address.

### Invoice Status Model

| Status | Meaning in the Current Code |
|---|---|
| `PENDING` | Invoice created; no matching payment observed yet. |
| `DETECTED` | A matching transaction was observed (unconfirmed in the mempool on UTXO and Monero networks; indexed by the API on TRON) but the confirmation requirement is not met. |
| `CONFIRMED` | The confirmation requirement is met according to the scanner logic. A webhook is dispatched if `webhookUrl` is configured. |
| `EXPIRED` | The invoice was still `PENDING` when the polling cycle found `Date.now() > expiresAt`. |
| `FAILED` | Defined in the enum. No code path in the current version assigns this status. |

Status progression: `PENDING -> DETECTED -> CONFIRMED`, or `PENDING -> EXPIRED`. A scanner can move an invoice from `PENDING` directly to `CONFIRMED`.

### Payment Detection Logic

* **TRON (USDT):** Requests `/v1/accounts/<address>/transactions/trc20` with `contract_address`, `only_to=true`, and `limit=5`. A transaction matches when its `value` string equals the invoice amount converted to 6-decimal base units. Confirmations are estimated as `floor((now - block_timestamp) / 3000)`, and the invoice is marked `CONFIRMED` when this estimate is greater than or equal to the required confirmations; otherwise it is marked `DETECTED`.
* **TRON (TRX):** Requests `/v1/accounts/<address>/transactions` with `only_to=true` and `limit=5`. A transaction matches when its first contract is of type `TransferContract` and its `amount` equals the invoice amount in sun. The same timestamp-based confirmation estimate is used.
* **Litecoin and Dogecoin:** Requests `/<coin>/main/addrs/<address>` from BlockCypher. Entries in `unconfirmed_txrefs` with `tx_input_n === -1` and a value equal to the invoice amount in base units set a `PENDING` invoice to `DETECTED`. Entries in `txrefs` with the same match conditions set the invoice to `CONFIRMED` when the reported `confirmations` value reaches the requirement, otherwise to `DETECTED`.
* **Monero (XMR) — Watch-Only Wallet RPC Mode (`moneroWalletRpcUrl`):** Sends `POST /json_rpc` with `method: "get_transfers"`, `in: true`, `pool: true`, `account_index: 0`, and `subaddr_indices: [invoice.derivationIndex + 1]`. Entries in `result.pool` or `result.in` are checked for target subaddress match, validated via `MoneroTimelockValidator.isExecutionAndTimelockSafe`, and compared against the expected piconero amount (`BigInt(tx.amount) >= expectedPiconero`). Unconfirmed pool entries set the invoice to `DETECTED` (or `CONFIRMED` if `requiredConfirmations === 0`); confirmed entries set the invoice to `CONFIRMED` when `confirmations >= requiredConfirmations`.
* **Monero (XMR) — Direct Cryptographic Daemon Mode (`moneroRpcUrl`):** Sends `POST /get_transactions` with `{ address: invoice.receivingAddress, include_pool: true, decode_as_json: true }`. For each candidate transaction and each output in `vout`, extracts the transaction public key (`tx_pub_key` or tag `0x01` from `extra`), the stealth output key (`target.tagged_key.key` or `target.key`), the encrypted amount (`rct_signatures.ecdhInfo[k].amount`), and the commitment (`rct_signatures.outPk[k]`), then executes Layers 1 to 4 of `MoneroAntiSpoofEngine.verify(rawTxData, invoice, 0)`. Confirmations are taken from `tx.confirmations` or computed as `chain_height - tx.block_height + 1`.
* **Failure handling:** All scanner errors (network errors, rate limits, malformed responses, unsupported currency) are caught and result in `null`, meaning no state change in that cycle. The next polling cycle retries.

### Five-Layer Verification Modules

#### 1. TRON TRC20 Verification (`AntiCounterfeitEngine`)

`AntiCounterfeitEngine.verify(txData, invoice)` runs the following checks in order and returns on the first failure with the failing layer number and a reason string.

1. **Layer 1, Contract Whitelist:** The contract address must equal the official Tether USDT TRC20 contract (`TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t`, hex `41a614f803b6fd780986a42c78ec9c7f77e6ded13c`), accepted in Base58 or hex form.
2. **Layer 2, TVM Execution Receipt:** `ret[0].contractRet` and `receipt.result`, when present, must equal `SUCCESS`. Payloads with neither field are rejected.
3. **Layer 3, ABI Parameter Decoding:** The call data must be exactly 136 hexadecimal characters, begin with selector `a9059cbb` (`transfer(address,uint256)`), and decode to a recipient and amount that equal the invoice receiving address and the invoice amount in base units.
4. **Layer 4, State Query:** A `triggerconstantcontract` call to `balanceOf(address)` on the official contract must return a balance greater than or equal to the invoice amount.
5. **Layer 5, Consensus Finality:** The transaction block number must be less than or equal to the latest block number returned by the solidified node endpoint (`/walletsolidity/getnowblock`).

#### 2. Monero Cryptographic Verification (`MoneroAntiSpoofEngine`)

`MoneroAntiSpoofEngine.verify(txData, invoice, requiredConfirmations)` runs the following five checks sequentially:

1. **Layer 1, Ed25519 Curve & Torsion Subgroup Validation (`MoneroKeyValidator`):** Verifies that `txPublicKeyHex` ($R$) and `outputStealthKeyHex` ($P_k$) are valid 32-byte compressed Ed25519 points that are neither the identity element nor small-order torsion points (`!point.isSmallOrder()`), and that `commitmentHex` ($C_k$), when provided, is a valid curve point.
2. **Layer 2, Execution Flags & Timelock Validation (`MoneroTimelockValidator`):** Rejects transactions where `doubleSpendSeen`, `failed`, `invalidInput`, `invalidOutput`, or `overspend` is `true`. Validates `unlockTime`: `0` is accepted immediately; values below `500,000,000` (block height locks) require `currentChainHeight` and `unlockTime <= currentChainHeight + maxAllowedBlockLockDelta`; values `>= 500,000,000` (Unix timestamp locks) require `unlockTime <= Math.floor(Date.now() / 1000)`.
3. **Layer 3, ECDH Stealth Output Ownership Proof (`StealthOutputVerifier`):** Computes the key derivation point $D_{\text{ecdh}} = 8 \cdot a \cdot R$ using `moneroPrivateViewKey`, derives the output scalar $s_k = H_s(D_{\text{ecdh}} \parallel \text{varint}(outputIndex))$, computes $D_{\text{recovered}} = P_k - s_k G$, and verifies that $D_{\text{recovered}}$ equals the public spend key decoded from `invoice.receivingAddress`.
4. **Layer 4, RingCT Amount Decryption & Pedersen Commitment Verification (`RingCtVerifier`):** Decrypts the 8-byte (or 32-byte) `encryptedAmountHex` by XORing the first 8 bytes with $\text{Keccak-256}(\text{"amount"} \parallel s_k)$, verifies that the decrypted piconero amount is greater than or equal to the invoice amount in piconero, computes the Pedersen commitment $C_k = y_k G + bH$ (where $y_k = H_s(\text{"commitment\_mask"} \parallel s_k)$ and $H$ is the constant point `8b655970153799af2aeadc9ff1add0ea6c7251d54154cfa92c173a0dd39c1f94`), and compares it against `commitmentHex` when supplied.
5. **Layer 5, Block Maturity & Confirmation Finality (`MoneroFinalityValidator`):** When `requiredConfirmations > 0`, queries `GET /get_height` on the Monero daemon, computes `confirmations = currentHeight - blockHeight + 1`, and verifies `confirmations >= requiredConfirmations`.

### Source Code Modules & Engine Components

* **[index.ts](src/index.ts)**
  * **Role:** Package Entry Point.
  * **Implementation:** Re-exports `types`, `ZeroPayClient`, `ConfigManager`, `WebhookManager`, `MemoryStorage`, `HttpClient`, `CryptoUtils`, `MoneroCryptoUtils`, all engines (`AddressGenerator`, `UtxoEngine`, `TrvmEngine`, `CryptonoteEngine`), all scanners (`ScannerFactory`, `TronScanner`, `UtxoScanner`, `MoneroScanner`), and all twelve modules of the `security` directory (both TRON and Monero verification layers).

* **[types/index.ts](src/types/index.ts)**
  * **Role:** Core Data Models and Interfaces.
  * **Implementation:** Defines the enums `Currency` (`USDT`, `TRX`, `LTC`, `DOGE`, `XMR`), `Network` (`TRON`, `LITECOIN`, `DOGECOIN`, `MONERO`), and `InvoiceStatus`; the interfaces `IZeroPayConfig`, `IInvoice` (amount stored as a string), `IStorageAdapter` (including `getActiveInvoices` and `confirmations` in `updateInvoiceStatus`), and `IAddressGenerationResult`.

* **[ZeroPayClient.ts](src/core/ZeroPayClient.ts)**
  * **Role:** Primary Execution Wrapper.
  * **Implementation:** The constructor processes the configuration through `ConfigManager`, selects `MemoryStorage` when no adapter is supplied, and creates a `ScannerFactory`. Provides `createInvoice(amount, currency, network)` (with `validateAmountFormat` and `validateCurrencyNetworkPair` checks), `startPolling(intervalMs = 30000)` (throws if polling is already running), and `stopPolling()`. The private polling cycle is guarded by `isPollingCycleRunning`, retrieves active invoices via `this.storage.getActiveInvoices()`, expires overdue `PENDING` invoices, scans the remaining ones, persists status, transaction hash, and confirmation changes, and dispatches a webhook when an invoice becomes `CONFIRMED`. Errors inside a cycle are caught and discarded.

* **[ConfigManager.ts](src/core/ConfigManager.ts)**
  * **Role:** Configuration Validation and Defaults.
  * **Implementation:** Requires a non-empty `webhookSecret` string; requires `webhookUrl`, `tronRpcUrl`, `moneroRpcUrl`, and `moneroWalletRpcUrl` (when supplied) to be parseable URLs with `http:` or `https:` protocol; requires each supplied xPub to be 100 to 120 characters long; enforces that `moneroPublicSpendKey` and `moneroPrivateViewKey` are provided together as 64-character hexadecimal strings when either is present; requires `defaultConfirmations` to be a non-negative integer and `defaultExpirationMinutes` to be a positive integer. Applies defaults for `tronRpcUrl`, `moneroRpcUrl` (`https://xmr-node.cakewallet.com:18081`), `defaultExpirationMinutes`, and `defaultConfirmations`.

* **[WebhookManager.ts](src/core/WebhookManager.ts)**
  * **Role:** Signed Webhook Dispatcher.
  * **Implementation:** `WebhookManager.dispatch(invoice, webhookUrl, webhookSecret)` serializes the invoice with `JSON.stringify`, computes a hex HMAC-SHA256 digest of that string, and sends it as the request body with headers `Content-Type: application/json` and `X-ZeroPay-Signature`. Timeout is 5,000 ms. Returns `true` for an HTTP 2xx response and `false` on any error or non-2xx result.

* **[AddressGenerator.ts](src/engines/AddressGenerator.ts)**
  * **Role:** Address Generation Facade.
  * **Implementation:** Selects the configured keys for the requested network (`xpubLitecoin`, `xpubDogecoin`, `xpubTron`, or `moneroPublicSpendKey` + `moneroPrivateViewKey`), throws a descriptive error when missing, and delegates to `UtxoEngine`, `TrvmEngine`, or `CryptonoteEngine`.

* **[UtxoEngine.ts](src/engines/UtxoEngine.ts)**
  * **Role:** Litecoin and Dogecoin Address Derivation.
  * **Implementation:** Defines custom `bitcoinjs-lib` network parameter objects for Litecoin (bech32 `ltc`, pubKeyHash `0x30`, scriptHash `0x32`, WIF `0xb0`) and Dogecoin (pubKeyHash `0x1e`, scriptHash `0x16`, WIF `0x9e`, no bech32). Initializes `bip32` with `tiny-secp256k1`, decodes the xPub with the network parameters, derives `0/<index>`, and builds a `p2wpkh` payment for Litecoin or a `p2pkh` payment for Dogecoin.

* **[TrvmEngine.ts](src/engines/TrvmEngine.ts)**
  * **Role:** TRON Address Derivation.
  * **Implementation:** Decodes the xPub with the default Bitcoin serialization, derives `0/<index>`, converts the compressed public key to an EVM address with `ethers` (`utils.computeAddress`), replaces the `0x` prefix with `41`, and converts to Base58Check using `TronWeb.address.fromHex`. Throws if the result does not begin with `T`.

* **[CryptonoteEngine.ts](src/engines/CryptonoteEngine.ts)**
  * **Role:** Monero Subaddress and Primary Address Derivation.
  * **Implementation:** Validates the 32-byte public spend key and private view key on Ed25519, maps the zero-based invoice `index` to `(majorIndex = 0, minorIndex = index + 1)`, computes the subaddress scalar tweak $m = H_s(\text{"SubAddr\0"} \parallel a \parallel \text{major} \parallel \text{minor})$, derives subaddress public keys $D = B + mG$ and $C = a \cdot D$, and encodes a 95-character Mainnet subaddress starting with `8` (or a primary address starting with `4` via `generatePrimaryAddress`).

* **[ScannerFactory.ts](src/scanners/ScannerFactory.ts)**
  * **Role:** Scanner Routing.
  * **Implementation:** Instantiates `TronScanner`, `UtxoScanner`, and `MoneroScanner` and routes `scan(invoice, requiredConfirmations)` by `invoice.network`. Throws for networks that have no scanner.

* **[TronScanner.ts](src/scanners/TronScanner.ts)**
  * **Role:** TRON Payment Scanner.
  * **Implementation:** Creates an axios client with base URL `config.tronRpcUrl` (or the TronGrid default), a 10,000 ms timeout, and the `TRON-PRO-API-KEY` header when `tronApiKey` is configured. Converts invoice amounts to 6-decimal base units with `CryptoUtils.amountToBaseUnits` and implements the TRC20 USDT and native TRX detection logic.

* **[UtxoScanner.ts](src/scanners/UtxoScanner.ts)**
  * **Role:** Litecoin and Dogecoin Payment Scanner.
  * **Implementation:** Creates an axios client for `https://api.blockcypher.com/v1` with a 10,000 ms timeout and no authentication token. Converts invoice amounts to 8-decimal base units with `CryptoUtils.amountToBaseUnits` and implements the unconfirmed and confirmed transaction matching.

* **[MoneroScanner.ts](src/scanners/MoneroScanner.ts)**
  * **Role:** Monero Payment Scanner.
  * **Implementation:** Creates an axios client with a 10,000 ms timeout targeting `moneroWalletRpcUrl` or `moneroRpcUrl`. In Watch-Only Wallet RPC mode, sends `POST /json_rpc` (`get_transfers`) and validates `pool` and `in` transfers with `MoneroTimelockValidator` and piconero amount comparison. In Daemon RPC mode, sends `POST /get_transactions`, parses tag `0x01` from `extra` when `tx_pub_key` is absent, and verifies each output through Layers 1 to 4 of `MoneroAntiSpoofEngine`.

* **[ContractWhitelist.ts](src/security/ContractWhitelist.ts)**
  * **Role:** TRON Verification Layer 1.
  * **Implementation:** Compares a candidate contract address with the official USDT contract in Base58 form, in hex form (case-insensitive, with or without a `0x` prefix variant), and through `TronWeb.address.toHex` normalization.

* **[TvmReceiptValidator.ts](src/security/TvmReceiptValidator.ts)**
  * **Role:** TRON Verification Layer 2.
  * **Implementation:** Evaluates the `ret` array and `receipt` object of a TRON transaction payload and returns `true` only when no failure value is present and at least one of the two structures exists.

* **[AbiDecoder.ts](src/security/AbiDecoder.ts)**
  * **Role:** TRON Verification Layer 3.
  * **Implementation:** Strips an optional `0x` prefix, enforces a 136-character length, verifies the `a9059cbb` selector, extracts the 20-byte recipient from the left-padded 32-byte word, prefixes `41`, converts it to Base58 with TronWeb, and parses the amount word as a `bigint`. `validateTransferParameters` additionally compares the decoded recipient and amount with the expected values.

* **[StateQueryValidator.ts](src/security/StateQueryValidator.ts)**
  * **Role:** TRON Verification Layer 4.
  * **Implementation:** Sends a `POST /wallet/triggerconstantcontract` request for `balanceOf(address)` on the official USDT contract and parses the first `constant_result` entry as a `bigint`. `verifyBalanceSufficiency` returns `false` on any error.

* **[ConsensusFinalityValidator.ts](src/security/ConsensusFinalityValidator.ts)**
  * **Role:** TRON Verification Layer 5.
  * **Implementation:** Sends `POST /walletsolidity/getnowblock`, reads `block_header.raw_data.number`, and returns whether the transaction block number is less than or equal to it. Returns `false` on any error.

* **[AntiCounterfeitEngine.ts](src/security/AntiCounterfeitEngine.ts)**
  * **Role:** TRON Verification Pipeline Orchestrator.
  * **Implementation:** Constructs the Layer 4 and Layer 5 validators with the configured `tronRpcUrl` (or the TronGrid default) and an optional injected `HttpClient`. `verify` returns an `IValidationResult` containing `isValid`, and on failure `failureReason` and `layerFailed`.

* **[MoneroKeyValidator.ts](src/security/MoneroKeyValidator.ts)**
  * **Role:** Monero Verification Layer 1.
  * **Implementation:** Validates 32-byte compressed Ed25519 points (`txPublicKeyHex`, `outputStealthKeyHex`, and optional `commitmentHex`) and rejects the identity point and small-order torsion points.

* **[MoneroTimelockValidator.ts](src/security/MoneroTimelockValidator.ts)**
  * **Role:** Monero Verification Layer 2.
  * **Implementation:** Rejects transactions with `doubleSpendSeen`, `failed`, `invalidInput`, `invalidOutput`, or `overspend` flags, and validates `unlockTime` against block height (`< 500,000,000`) or Unix timestamp (`>= 500,000,000`) thresholds.

* **[StealthOutputVerifier.ts](src/security/StealthOutputVerifier.ts)**
  * **Role:** Monero Verification Layer 3.
  * **Implementation:** Computes ECDH shared secret $8aR$, derives the per-output scalar $s_k = H_s(8aR \parallel \text{varint}(k))$, and verifies that $P_k - s_k G$ equals the expected subaddress public spend key.

* **[RingCtVerifier.ts](src/security/RingCtVerifier.ts)**
  * **Role:** Monero Verification Layer 4.
  * **Implementation:** Decrypts and encrypts 8-byte RingCT amounts via $\text{Keccak-256}(\text{"amount"} \parallel s_k)$, verifies piconero sufficiency against the invoice amount, and computes/validates the Pedersen Commitment $C_k = y_k G + bH$.

* **[MoneroFinalityValidator.ts](src/security/MoneroFinalityValidator.ts)**
  * **Role:** Monero Verification Layer 5.
  * **Implementation:** Queries `GET /get_height` via `HttpClient`, computes confirmation depth `currentHeight - transactionBlockHeight + 1`, and evaluates whether `confirmations >= requiredConfirmations`.

* **[MoneroAntiSpoofEngine.ts](src/security/MoneroAntiSpoofEngine.ts)**
  * **Role:** Monero Verification Pipeline Orchestrator.
  * **Implementation:** Executes Monero Layers 1 to 5 sequentially and returns an `IMoneroValidationResult` containing `isValid`, `decryptedAmountPiconero`, `confirmations`, and on failure `failureReason` and `layerFailed`.

* **[MemoryStorage.ts](src/storage/MemoryStorage.ts)**
  * **Role:** Default In-Memory Storage Adapter.
  * **Implementation:** Implements `IStorageAdapter` using a `Map` keyed by ID for invoices and a `Map` keyed by network for derivation indices. `updateInvoiceStatus` updates `status`, optional `txHash`, and optional `confirmations`. `getActiveInvoices` returns invoices with status `PENDING` or `DETECTED`. All data is lost when the process exits.

* **[http.ts](src/utils/http.ts)**
  * **Role:** HTTP Client with Retry.
  * **Implementation:** Wraps an axios instance (10,000 ms default timeout) and retries failed requests up to the configured count with exponential backoff. The default retry condition covers responses that never arrived, HTTP 429, and HTTP 500 to 599. Exposes `request`, `get`, and `post`.

* **[moneroCrypto.ts](src/utils/moneroCrypto.ts)**
  * **Role:** Monero Low-Level Cryptographic and Base58 Primitives.
  * **Implementation:** Implements Monero block-based Base58 encoding/decoding, address encoding/decoding with 4-byte Keccak-256 checksums, Ed25519 scalar reduction (`scReduce32`, `hashToScalar`), point arithmetic (`@noble/curves/ed25519`), `VarInt` encoding, ECDH key derivation (`generateKeyDerivation`), and string-based decimal-to-atomic-unit conversion (`parseDecimalToUnits`).

* **[crypto.ts](src/utils/crypto.ts)**
  * **Role:** Cryptographic and Validation Utilities.
  * **Implementation:** `verifyHmacSignature` (HMAC-SHA256 with `crypto.timingSafeEqual` and a length check), `sha256`, `doubleSha256`, `isValidTronAddress` (prefix `T`, length 34, `TronWeb.isAddress`), `isValidLitecoinAddress` and `isValidDogecoinAddress` (prefix and length checks), `isValidMoneroAddress` (full Monero Base58 decode, prefix byte check, Ed25519 curve point validation, and 4-byte Keccak-256 checksum check), and `amountToBaseUnits`.

* **Tests ([core.test.ts](tests/core.test.ts), [engines.test.ts](tests/engines.test.ts), [scanners.test.ts](tests/scanners.test.ts), [security.test.ts](tests/security.test.ts))**
  * **Role:** Jest Unit and Integration Tests.
  * **Implementation:** Cover configuration validation (including Monero key pairs), in-memory storage behavior, webhook signature generation and verification, invoice creation and currency-network pair enforcement, address derivation for all four networks (including uniqueness of 100 consecutive TRON addresses and 100 consecutive Monero subaddresses), scanner behavior for TRON, UTXO, and Monero (both Watch-Only Wallet RPC and Daemon RingCT modes), and both five-layer verification pipelines (`AntiCounterfeitEngine` and `MoneroAntiSpoofEngine`).

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
    <tr><td><code>tests/core.test.ts</code></td><td>ConfigManager, MemoryStorage, WebhookManager, ZeroPayClient</td><td align="right">14</td><td align="right">PASS</td><td align="right">11.852 s</td></tr>
    <tr><td><code>tests/engines.test.ts</code></td><td>UtxoEngine, TrvmEngine, CryptonoteEngine, AddressGenerator, collision resistance</td><td align="right">12</td><td align="right">PASS</td><td align="right">15.652 s</td></tr>
    <tr><td><code>tests/scanners.test.ts</code></td><td>TronScanner, UtxoScanner, MoneroScanner, ScannerFactory</td><td align="right">8</td><td align="right">PASS</td><td align="right">8.021 s</td></tr>
    <tr><td><code>tests/security.test.ts</code></td><td>TRON layers 1 to 5 (AntiCounterfeitEngine) & Monero layers 1 to 5 (MoneroAntiSpoofEngine)</td><td align="right">30</td><td align="right">PASS</td><td align="right">8.149 s</td></tr>
    <tr><td><b>Total</b></td><td>4 suites</td><td align="right"><b>64</b></td><td align="right"><b>64 passed</b></td><td align="right"><b>17.167 s</b></td></tr>
  </tbody>
</table>

<details>
<summary><b>Raw test output (<code>npm test</code>): 4 suites passed, 64 tests passed. Click to expand or collapse.</b></summary>

```text
PS D:\Zero\Project\TypeScript.Nodsjs\ZeroPay> npm test

> zeropay-core@1.0.0 test
> jest

 PASS  tests/scanners.test.ts (8.021 s)
  Blockchain Scanners and Factory
    TronScanner
      √ should detect incoming TRC20 USDT transfer when amount matches exactly (112 ms)
      √ should return null if no matching transactions are returned by TronGrid
      √ should fail silently and return null on network exception (1 ms)
    UtxoScanner
      √ should detect unconfirmed UTXO transaction in mempool and set status to DETECTED (1 ms)
      √ should confirm UTXO transaction when confirmations meet requirement
    MoneroScanner
      √ should detect unconfirmed Monero transfer in mempool via Watch-Only Wallet RPC (1 ms)
      √ should cryptographically verify and confirm Monero RingCT output via Daemon RPC (29 ms)
    ScannerFactory
      √ should correctly route TRON, UTXO, and MONERO invoices to their respective scanners (1 ms)

 PASS  tests/security.test.ts (8.149 s)
  Anti-Counterfeit & Anti-Flash Subsystem
    Layer 1: ContractWhitelist
      √ should approve official Tether contract in Base58 format (180 ms)
      √ should approve official Tether contract in Hex format
      √ should reject spoofed or fake contract addresses
      √ should safely reject empty or non-string inputs (1 ms)
    Layer 2: TvmReceiptValidator
      √ should validate successful execution receipt with contractRet SUCCESS
      √ should reject transactions that were reverted or ran out of energy (1 ms)
      √ should reject malformed or empty execution payloads
    Layer 3: AbiDecoder
      √ should decode genuine transfer(address,uint256) data and match parameters (1 ms)
      √ should reject transaction if method selector is not transfer (e.g. approve 095ea7b3) (1 ms)
      √ should reject transaction if transfer amount does not match invoice requirements
      √ should reject transaction if recipient address does not match invoice receiving address
    Layer 4: StateQueryValidator
      √ should query on-chain balance and confirm sufficiency using mocked HTTP client (2 ms)
    Layer 5: ConsensusFinalityValidator
      √ should verify transaction finality when block number is below or equal to solidified block (1 ms)
    AntiCounterfeitEngine Pipeline Orchestrator
      √ should completely approve transaction passing all 5 verification layers (1 ms)
      √ should halt and fail at Layer 1 if counterfeit contract is detected (1 ms)
      √ should halt and fail at Layer 2 if transaction execution failed in TVM
      √ should halt and fail at Layer 3 if ABI parameters mismatch invoice (1 ms)
      √ should halt and fail at Layer 5 if block is unsolidified (1 ms)
    Monero 5-Layer Anti-Spoofing & RingCT Verification Subsystem
      Monero Layer 1: MoneroKeyValidator
        √ should approve valid torsion-free Ed25519 public keys (1 ms)
        √ should reject identity or small-order torsion curve points
      Monero Layer 2: MoneroTimelockValidator
        √ should approve standard unlocked transactions with no failure flags (1 ms)
        √ should reject transactions flagged with double_spend_seen or failed
        √ should reject malicious future block or timestamp unlock_time values
      Monero Layer 3: StealthOutputVerifier
        √ should cryptographically prove stealth output ownership for the target subaddress (8 ms)
        √ should reject stealth output when checked against a different subaddress (12 ms)
      Monero Layer 4: RingCtVerifier
        √ should decrypt RingCT amount and validate Pedersen Commitment C = yG + bH (6 ms)
        √ should reject RingCT payment if decrypted amount is less than invoice requirement (1 ms)
        √ should reject RingCT payment if Pedersen Commitment is forged (6 ms)
      Monero Layer 5 & MoneroAntiSpoofEngine Orchestrator
        √ should approve a valid Monero transaction passing all 5 cryptographic layers (14 ms)
        √ should fail at Layer 5 if transaction confirmation depth is below requirement (14 ms)

 PASS  tests/core.test.ts (11.852 s)
  Core Orchestration and Utilities
    ConfigManager
      √ should validate complete configuration and apply deterministic defaults (9 ms)
      √ should throw an error if webhookSecret is empty or missing (246 ms)
      √ should throw an error if webhookUrl has an invalid protocol (1 ms)
      √ should throw an error if xPub format fails length boundary check (1 ms)
      √ should validate Monero key pairs and reject incomplete or malformed keys (1 ms)
    MemoryStorage
      √ should atomically retrieve and increment derivation indices per network (1 ms)
      √ should persist, retrieve, and update invoice records correctly (1 ms)
      √ should accurately filter active invoices (PENDING and DETECTED)
    WebhookManager
      √ should generate valid HMAC-SHA256 signature and dispatch POST payload (24 ms)
      √ should return false when destination server returns HTTP error status
    ZeroPayClient
      √ should construct an invoice atomically with valid cryptographic address and metadata (123 ms)
      √ should construct a Monero (XMR) invoice with a valid 95-character subaddress (78 ms)
      √ should reject incompatible currency and network combinations (3 ms)
      √ should manage polling cycle interval state safely

 PASS  tests/engines.test.ts (15.652 s)
  Cryptographic Address Derivation Engines
    UtxoEngine
      √ should derive valid Native SegWit addresses for Litecoin (20 ms)
      √ should derive valid Legacy P2PKH addresses for Dogecoin (11 ms)
      √ should throw an error if an unsupported network is requested (98 ms)
    TrvmEngine
      √ should derive valid Base58Check addresses for TRON (142 ms)
      √ should throw an error if a non-TRON network is passed to TrvmEngine (11 ms)
    CryptonoteEngine (Monero)
      √ should derive valid 95-character Monero Subaddresses starting with 8 (18 ms)
      √ should generate a valid 95-character Monero Primary Address starting with 4 (4 ms)
      √ should throw an error if a non-MONERO network is passed to CryptonoteEngine (2 ms)
    AddressGenerator Facade
      √ should route derivation requests correctly across all supported networks (52 ms)
      √ should throw explicit error when an xPub or Monero key pair is missing from the configuration (2 ms)
    Checkpoint Alpha: Mathematical Collision Resistance
      √ should derive 100 consecutive TRON addresses with 100% uniqueness (3241 ms)
      √ should derive 100 consecutive Monero subaddresses with 100% uniqueness (562 ms)

Test Suites: 4 passed, 4 total
Tests:       64 passed, 64 total
Snapshots:   0 total
Time:        17.167 s, estimated 20 s
Ran all test suites.
Force exiting Jest: Have you considered using `--detectOpenHandles` to detect async operations that kept running after all tests finished?
PS D:\Zero\Project\TypeScript.Nodsjs\ZeroPay>
```

</details>

* **[server.ts](demo-store/server.ts)**
  * **Role:** Local Merchant Simulation Server (Demo Store).
  * **Implementation:** An Express application in the separate `demo-store` package (`demo-store/package.json`, private, depends on `express ^4.18.2`, started with `ts-node server.ts`) that imports `ZeroPayClient`, `Currency`, `Network`, and `IZeroPayConfig` directly from `../src`. It builds a configuration with a hard-coded simulation xPub (assigned to both `xpubTron` and `xpubLitecoin`), hard-coded Monero simulation keys (`moneroPublicSpendKey` and `moneroPrivateViewKey`), a hard-coded `webhookSecret`, `webhookUrl` set to `http://localhost:3000/webhook`, `defaultExpirationMinutes` of 15, and `defaultConfirmations` of 1. It creates a `ZeroPayClient` with the default `MemoryStorage` and calls `startPolling(15000)` at startup. It exposes `POST /checkout` (creates a fixed 50.00 USDT invoice on TRON), `POST /checkout/monero` (creates a fixed 1.25 XMR invoice on Monero), and `POST /webhook`, which logs the `x-zeropay-signature` header and the body parsed by `express.json()` to the console and responds with HTTP 200 `OK` without verifying the signature. The server listens on port 3000 (hard-coded).

* **Project Configuration**
  * **Role:** Build, Lint, Format, and Test Settings.
  * **Implementation:** `tsconfig.json` (strict compiler options, `rootDir` `./src`, `outDir` `./dist`, declaration output, `noUnusedLocals`, `noUnusedParameters`), `jest.config.js` (`ts-jest` preset, Node test environment, tests matched by `**/tests/**/*.test.ts`), `.eslintrc.json` (`@typescript-eslint` recommended rules, `no-explicit-any` as error), `.prettierrc` (single quotes, trailing commas, print width 100), and `.gitignore`.

--------------------------------------------------------------------------------

## Current Status

This is version 1.0.0 of ZeroPay. It is not complete and it is not free of defects. The following components are implemented in the source code:

* **Address derivation** for TRON, Litecoin, and Dogecoin from xPubs, and for Monero (XMR) subaddresses (`8...`) and primary addresses (`4...`) from Ed25519 view/spend key pairs, with unit tests for address format, per-index uniqueness (100 consecutive TRON addresses and 100 consecutive Monero subaddresses), network routing, and error cases.
* **Invoice creation** with amount format validation, currency-to-network compatibility enforcement, per-network derivation indices, UUID identifiers, and expiration timestamps.
* **Polling loop** with start and stop control, a re-entrancy lock (`isPollingCycleRunning`), expiration of overdue `PENDING` invoices, scanner routing, status and confirmation count persistence, and webhook dispatch on `CONFIRMED`.
* **Scanners** for TRC20 USDT, native TRX, Litecoin, Dogecoin, and Monero (supporting both Watch-Only Wallet JSON-RPC and Direct Cryptographic Daemon RingCT modes). Scanner tests use mocked HTTP responses; this repository does not contain tests that run against live networks.
* **Signed webhooks** with HMAC-SHA256 and a timing-safe verification helper.
* **Two five-layer verification modules:** `AntiCounterfeitEngine` for TRON TRC20 (implemented as a standalone module) and `MoneroAntiSpoofEngine` for Monero RingCT (Layers 1 to 4 invoked by `MoneroScanner` in daemon mode, and all 5 layers unit tested).
* **Configuration validation** and **in-memory storage**.

The library has not been independently audited. The results of `npm test` (4 suites, 64 tests, all passing) are listed under the Tests entry of the Source Code Modules section; these tests rely on mocked network responses.

--------------------------------------------------------------------------------

## Assumptions & Limitations

This is an initial version and it is not flawless. The following known limitations and assumptions apply. Anyone intending to process real funds should review the source code and test the behavior independently before use.

1. **TRON verification module is not integrated into `TronScanner`.** While `MoneroScanner` invokes `MoneroAntiSpoofEngine` (Layers 1 to 4) in daemon mode, `AntiCounterfeitEngine` is not called by `TronScanner` or `ZeroPayClient`. TRON payments are detected from the transaction list returned by the TronGrid-compatible API (filtered by the USDT contract address in the request) without executing the five-layer TRON pipeline.
2. **TRON Verification Layer 4 checks the total balance.** `StateQueryValidator` compares the current `balanceOf` result for the receiving address with the invoice amount. It does not isolate the specific transaction, so a balance that existed before the transaction could satisfy the check.
3. **TRON confirmations are estimated.** Confirmation counts in `TronScanner` are derived from the transaction timestamp divided by 3 seconds, not from the actual block height difference. `TronScanner` does not use the solidified block check of `ConsensusFinalityValidator`.
4. **Amount matching rules.** `TronScanner` and `UtxoScanner` require an exact single-transaction amount match (`===`). `MoneroScanner` and `RingCtVerifier` accept single-output transfers where the amount is greater than or equal to the invoice amount (`>=`). Underpayments, split payments across multiple transactions, and partial payment aggregation are not handled. The `FAILED` status is defined in `InvoiceStatus` but never assigned.
5. **Base-unit conversion in standalone TRON security classes.** `TronScanner`, `UtxoScanner`, `MoneroScanner`, and `RingCtVerifier` convert decimal strings to base units using deterministic string parsing (`CryptoUtils.amountToBaseUnits` / `MoneroCryptoUtils.parseDecimalToUnits`). However, `AbiDecoder.validateTransferParameters` and `StateQueryValidator.verifyBalanceSufficiency` still use `Math.floor(parseFloat(expectedAmountString) * 1_000_000)`.
6. **Monero daemon RPC endpoint assumptions.** In daemon mode (when `moneroWalletRpcUrl` is not set), `MoneroScanner` sends `POST /get_transactions` with `{ address: invoice.receivingAddress, include_pool: true, decode_as_json: true }` and expects a JSON response containing `transactions` or `txs` pre-filtered or returned by an indexer/proxy. Standard `monerod` `/get_transactions` requires a `txs_hashes` array and does not index transactions by subaddress (since subaddresses do not exist on-chain in Monero); therefore, production deployments against a standard Monero node require either configuring `moneroWalletRpcUrl` (pointing to a watch-only `monero-wallet-rpc` instance) or placing a block/mempool scanner proxy in front of `moneroRpcUrl`. Additionally, `StealthOutputVerifier` evaluates a single `txPublicKeyHex` per transaction and does not iterate over multi-output additional public keys (tag `0x04` in `extra`).
7. **No persistence by default.** `MemoryStorage` loses all invoices and resets derivation indices to zero when the process restarts. After a restart, address indices are issued again from zero, which re-issues previously used addresses for new invoices.
8. **Single-process assumption.** The atomicity of the derivation index relies on `MemoryStorage` running in one Node.js process. Multi-process or multi-instance deployments require an adapter with a truly atomic counter.
9. **Silent error handling.** Scanner errors and polling-cycle errors are swallowed without logging, so failures (rate limits, timeouts, malformed responses, storage errors) are not visible to the application.
10. **Webhook delivery is single-attempt.** `WebhookManager` makes one request with a 5,000 ms timeout. The return value is ignored by `ZeroPayClient`, there is no retry queue, and once an invoice is `CONFIRMED` it is no longer returned by `getActiveInvoices`, so a failed webhook is not re-sent. The signed payload is the invoice JSON only; it contains no event identifier or delivery timestamp, so replay protection must be implemented by the receiver.
11. **Polling behavior.** While `isPollingCycleRunning` prevents overlapping cycles within a single `ZeroPayClient` instance, invoices inside a cycle are scanned sequentially. Only `PENDING` invoices are expired; a `DETECTED` invoice never expires. Expired invoices are no longer scanned, so payments that arrive after expiration are not detected.
12. **Third-party API dependence.** Payment detection depends on the availability, response format, and rate limits of the configured TRON, BlockCypher, and Monero endpoints. `UtxoScanner` uses BlockCypher without an API token and ignores the configuration object. `AntiCounterfeitEngine` creates its `HttpClient` without the `tronApiKey` header. Scanners use axios directly and do not use the retry logic of `HttpClient`.
13. **TRX path verification.** The native TRX scanner relies on the `only_to` request filter for destination matching and checks only the contract type and amount; it does not independently verify the recipient address or execution result.
14. **Key and address validation scope.** `ConfigManager` validates xPubs by string length only (100 to 120 characters) and Monero keys by 64-character hex regex only; curve validity for xPubs and Monero keys is enforced during address derivation. Address validators for Litecoin and Dogecoin in `CryptoUtils` check prefix and length only and do not verify checksums (whereas `isValidTronAddress` and `isValidMoneroAddress` verify full checksums). The library does not apply an address gap limit.
15. **Fixed mainnet parameters.** Network parameters, prefix bytes (`0x12`, `0x13`, `0x2a` for Monero), USDT contract address, and decimal precision are hard-coded for mainnet. Testnets and other TRC20 or UTXO assets are not supported.
16. **Address types.** Litecoin supports Native SegWit (P2WPKH) only, Dogecoin supports Legacy P2PKH only, and Monero invoices generate Subaddresses (`8...`) only.
17. **Entry point scripts.** All modules (including engines, scanners, and security layers) are exported from `src/index.ts`. The `dev` and `start` scripts execute `src/index.ts` / `dist/index.js`, which only exports modules and performs no standalone action.
18. **Dependencies.** `bip39` is listed in `package.json` but is not imported by the current source code. `tronweb` is loaded with `require` and is not type-checked. `ethers` version 5 is used only for address computation.
19. **Test scope.** Tests rely on mocked network responses. Behavior against live blockchain APIs, real wallet-exported xPubs, and production load has not been verified in this repository.
20. **Demo store is a local simulation.** `demo-store/server.ts` is not a production reference. The webhook secret, simulation xPub, simulation Monero keys, port (3000), invoice amounts, and currencies are hard-coded, the library is imported from `../src` rather than from a built package, and the `/checkout` and `/checkout/monero` endpoints have no authentication and do not associate invoices with orders or customers. The simulation keys are the same values used in `tests/core.test.ts`; funds must not be sent to addresses derived from them.
21. **Demo webhook handler does not verify signatures.** It logs the `x-zeropay-signature` header and the parsed body and returns HTTP 200. Because the body is parsed by `express.json()` before the handler runs, the raw request string required for signature verification is not retained. The inline comment about preventing webhook retries does not correspond to library behavior, since the library does not retry webhooks (see item 10).
22. **Demo Litecoin configuration is not functional.** The same xPub, which uses the standard `xpub` serialization, is assigned to `xpubLitecoin`. The demo routes only create TRON (`POST /checkout`) and Monero (`POST /checkout/monero`) invoices. A Litecoin invoice created with this key would fail at address derivation, because Litecoin derivation requires the `Ltub` serialization.
23. **Demo inherits the library limitations.** The demo uses `MemoryStorage`, so the limitations above apply to it, including loss of invoices and derivation indices on restart and silent error handling. This README does not document an end-to-end run of the demo against a live network.
24. **Scan window and matching scope.** `TronScanner` requests with `limit=5` and evaluates only the transactions returned by the API. None of the scanners compare a transaction timestamp with the invoice creation time, so any transaction to the receiving address with a matching amount is accepted. A payment can be missed if it is not among the returned transactions, and an earlier payment of the same amount to a re-issued address (see item 7) could be matched.
25. **Receipt validation edge case.** `TvmReceiptValidator` rejects a payload only when `ret` and `receipt` are both absent. A payload with an empty `ret` array and no `receipt` is accepted.
26. **Test runner configuration.** `jest.config.js` sets `forceExit: true`, which explains the "Force exiting Jest" message in the test output. Open handles are not investigated.

--------------------------------------------------------------------------------

## Usage / Requirements

**Runtime Requirements:**
* **Runtime:** Node.js with support for ES2022 and `crypto.randomUUID`. `package.json` does not declare an `engines` field; the development type definitions target Node.js 20.
* **Package Manager:** npm.
* **Network Access:** Outbound HTTP/HTTPS access to the configured TRON API endpoint, `api.blockcypher.com` (for Litecoin and Dogecoin), and the configured Monero RPC / Wallet RPC endpoint, plus access to the merchant's webhook URL.
* **Wallet:** A wallet that can export account-level extended public keys for BIP32 networks in the serialization formats listed above, or a Monero wallet that can export the 32-byte Public Spend Key and 32-byte Private View Key.

**Dependencies (from `package.json`):**
* **Runtime:** `@noble/curves ^1.0.0`, `@noble/hashes ^1.2.0`, `axios ^1.6.0`, `bip32 ^4.0.0`, `bip39 ^3.1.0`, `bitcoinjs-lib ^6.1.5`, `ethers ^5.7.2`, `tiny-secp256k1 ^2.2.3`, `tronweb ^5.3.0`.
* **Development:** `typescript ^5.3.2`, `ts-node ^10.9.1`, `jest ^29.7.0`, `ts-jest ^29.1.1`, `@types/jest`, `@types/node`, `eslint ^8.54.0`, `@typescript-eslint/eslint-plugin` and `@typescript-eslint/parser ^6.13.1`, `prettier ^3.1.0`.
* **Demo store (`demo-store/package.json`, optional):** runtime `express ^4.18.2`; development `@types/express ^4.17.21`, `ts-node ^10.9.1`, `typescript ^5.3.2`.

**Compilation & Build Instructions:**

1. **Obtain the source:** clone the repository and change into its directory.
```bash
   git clone https://github.com/Z-E-7-0-7-R-O/ZeroPay
   cd ZeroPay
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
6. **Run the demo store (optional):** the demo imports the library from `../src`, so the dependencies of the repository root (step 2) must be installed first.
```bash
   cd demo-store
   npm install
   npm start
```

The package entry points are `dist/index.js` (`main`) and `dist/index.d.ts` (`types`). The package name is `zeropay-core`; how it is installed into a consuming project (local path, registry, or repository reference) is left to the integrator.

**Demo Store (Optional Local Simulation):**

The `demo-store` directory contains a small Express server that simulates a merchant backend using ZeroPay. It starts the polling loop with a 15,000 ms interval and listens on `http://localhost:3000`. After `npm start`, an invoice can be requested by sending a POST request, for example:

```bash
curl -X POST http://localhost:3000/checkout
curl -X POST http://localhost:3000/checkout/monero
```

The response is a JSON object with a `message` field and an `invoiceData` field containing the generated invoice (`POST /checkout` creates a 50.00 USDT invoice on TRON; `POST /checkout/monero` creates a 1.25 XMR invoice with a 95-character Monero subaddress on `MONERO`). `POST /webhook` is the endpoint registered as `webhookUrl`; it prints the received signature header and payload to the console and returns HTTP 200. The demo uses hard-coded simulation values (see Assumptions & Limitations, items 20 to 23) and must not be used with real funds.

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

A TRON xPub is required to create TRON invoices; `xpubLitecoin` and `xpubDogecoin` are required for Litecoin and Dogecoin invoices; `moneroPublicSpendKey` and `moneroPrivateViewKey` are required together for Monero invoices. Only the keys for the networks in use need to be supplied.

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
| `moneroPublicSpendKey` | No | 32-byte Ed25519 public spend key (64 hex chars). Must be paired with `moneroPrivateViewKey`. |
| `moneroPrivateViewKey` | No | 32-byte Ed25519 private view key (64 hex chars). Must be paired with `moneroPublicSpendKey`. |
| `tronRpcUrl` | No | TronGrid-compatible base URL. Default `https://api.trongrid.io`. |
| `tronApiKey` | No | Sent as `TRON-PRO-API-KEY` by `TronScanner`. |
| `moneroRpcUrl` | No | Monero daemon RPC base URL. Default `https://xmr-node.cakewallet.com:18081`. |
| `moneroWalletRpcUrl` | No | Optional watch-only `monero-wallet-rpc` base URL for `get_transfers` scanning. |
| `defaultConfirmations` | No | Non-negative integer. Default 1. |
| `defaultExpirationMinutes` | No | Positive integer. Default 60. |

--------------------------------------------------------------------------------

## License

Released under the MIT License. See the [LICENSE](LICENSE) file and the `license` field in [`package.json`](package.json).

--------------------------------------------------------------------------------
