# Official GasFree adapter (Nile testnet)

This module implements real, authenticated GasFree HTTP requests and read-only TRON balance queries. It never manufactures acceptance, a transaction hash, or confirmation. Unit tests use an injected fake transport; passing tests is not proof of live provider access or a real transfer. Fixture settlement remains a separate service path.

## Configuration

| Variable | Purpose |
| --- | --- |
| `GASFREE_API_KEY` | Server-only key issued after GasFree developer verification |
| `GASFREE_API_SECRET` | Server-only HMAC secret |
| `GASFREE_BASE_URL` | `https://open-test.gasfree.io/nile` (the only permitted provider endpoint in this build) |
| `GASFREE_TRON_RPC_URL` | `https://nile.trongrid.io` (the only permitted RPC endpoint in this build) |
| `TRONGRID_API_KEY` | Optional server-only RPC key, never sent to GasFree |
| `ENABLE_GASFREE_LIVE` | Must be exactly `true` to submit; defaults to disabled |

The adapter does not read `.env`, wallet keys, or files. `gasFreeConfigFromEnv()` reads the supplied environment. No wallet private key belongs on the server. Provider HMAC credentials are never returned in preflight, authorizations, transfer results, or CSV. Redirects are forbidden to prevent forwarding credentials to another host. HTTP requests have a bounded timeout and response size, no automatic transport retries, and safe fixed errors without upstream response messages.

Use approved Nile credentials, a wallet connected to Nile, and test USDT funded into the **derived GasFree account**, not just the wallet EOA. Real developer access, wallet approval, and sufficient test funds are required for an end-to-end demonstration. Mainnet is intentionally not supported by this adapter.

## Service integration contract

```ts
import { createGasFreeAdapter, gasFreeConfigFromEnv } from './integration/index.js';

const adapter = createGasFreeAdapter(gasFreeConfigFromEnv());
const check = await adapter.preflight({
  payerAddress: walletEoa,
  payments: remainingPayments.map(p => ({ id: p.id, address: p.address, amountMicros: p.amountMicros })),
  // tokenAddress / providerAddress are required when discovery is ambiguous.
});
const authorization = adapter.prepareAuthorization(check, check.payments[0]);
// API response for the wallet: { authorization, typedData: authorization.typedData }
// Browser signs typedData.domain / types / message through TronLink.
// BEFORE submit: durably save the authorization, requestId, and SUBMITTING attempt.
const result = await adapter.submitSigned(authorization, walletSignature);
// Persist result fields in the SAME attempt; only an explicit new authorization starts another attempt.
const refreshed = await adapter.recover(authorization, result);
```

The service must retain the server-issued authorization and retrieve it by ID. Never accept a replacement authorization object from the browser merely because its SHA-256 `digest` matches: the digest detects mutation, it is not an authentication mechanism. The submitted signature authorizes an exact token, provider, payer EOA, recipient, amount, maximum fee, deadline, version, and nonce.

The application service owns durable persistence, account-wide execution locking, history guards, and human confirmation. Persist `SUBMITTING` before any network submission. After a crash, treat it as unresolved; `recover()` never sends a POST. An in-memory requestId guard prevents concurrent duplicate POSTs in one adapter instance, but does not replace the service's durable attempt ledger. For restored attempts, pass the previous result as the third argument to `submitSigned`, or call `recover` directly. Do not call a fresh submit with an existing attempt after restart.

One preflight covers the remaining batch's estimated cost, while one signature authorizes one payment. Only `payments[0]` can be prepared; wait for its definitive outcome before reading a fresh recommended nonce for the next payment. Preflight expires after 30 seconds. Submit rechecks current nonce, balance, pending eligibility, fees, and deadline before contacting the submit endpoint. A precheck failure is `FAILED` with no POST. The fee cap is never silently increased or re-signed.

`GasFreeTransferResult` always records `mode: live`, `network: nile`, the request ID, status, and recovery action. `traceId`, `txHash`, and actual fees exist only when supplied and validated:

| Status | Meaning | Recovery |
| --- | --- | --- |
| `PROCESSING` | Provider accepted or reports unsolidified transfer | GET original trace |
| `CONFIRMED` | Matching provider record reports `SUCCEED` + `SOLIDITY`, then Nile Solidity RPC confirms the successful receipt and exact USDT `Transfer` log | No automatic retry |
| `FAILED` | Definite pre-submit refusal, provider validation rejection, or reported transfer failure | Preserve reason; fresh review and new authorization required |
| `UNKNOWN` | Timeout, malformed/mismatched response, or failed query | Query original trace; missing trace requires manual reconciliation |

Confirmation is explicitly `verificationSource: gasfree-provider+nile-solidity-rpc`. A provider success without an independently matching solidified receipt remains `PROCESSING` or `UNKNOWN`; it cannot become a completed payment. `txnTotalFee` maps to actual fees only after both checks succeed. Estimated fees never become actual fees. Missing optional actual-fee fields remain empty in exports.

**requestId is a UUID v4 diagnostic correlation ID, not a documented idempotency key.** Official APIs provide lookup by `traceId`, not requestId. A submission timeout with no trace cannot be safely retried automatically. Preserve the original request ID and authorization, contact/check the provider, and do not invent a trace or mark the payment failed just to unlock a new payment.

## Official protocol mapping

- `GET /api/v1/config/token/all`: token contracts, support flags, decimals, current activation/transfer fees.
- `GET /api/v1/config/provider/all`: provider addresses, pending limit, min/max/default deadline durations.
- `GET /api/v1/address/{EOA}`: derived account, activation state, recommended nonce, submission eligibility, token-specific frozen amounts and fees. Both documented `allowSubmit` and example `allow_submit` are accepted; conflicting values fail closed.
- `POST /wallet/triggerconstantcontract` on Nile RPC: `balanceOf(GasFreeAccount)`; available balance is on-chain balance minus frozen amounts, never the frozen field alone.
- `POST /api/v1/gasfree/submit`: exact TIP-712 message, wallet signature, UUID requestId. Response `id` is a trace ID, not a transaction hash.
- `GET /api/v1/gasfree/{traceId}`: validated authorization identity, provider/chain states, actual `txnHash`, and optional actual `txnTotalFee` / `txnAmount`.
- HMAC-SHA256 base64 signs uppercase method + full path including `/nile` + epoch seconds. Both HTTP status and envelope business code are checked.

`@gasfree/gasfree-sdk` is pinned to published **1.1.2**; the upstream main branch's package version is not used. Its CommonJS default export is required under Node ESM. The SDK assembles TIP-712 and independently derives the expected GasFree address. This prototype selects a supported 6-decimal USDT contract; it discovers other supported tokens for display but does not pretend that other decimals are micro-USDT.

Sources checked 2026-09-28: [GasFree developer API and signing documentation](https://docs.gasfree.io/), [official SDK repository](https://github.com/gasfreeio/gasfree-sdk-js), [TRON constant-contract RPC](https://developers.tron.network/reference/triggerconstantcontract), [GasFree developer access](https://developer.gasfree.io/).

## Validation

```sh
npm test -- tests/gasfree.test.ts tests/gasfree-csv.test.ts
```

Tests use synthetic credentials and an injected fetch transport. They cover SDK runtime compatibility, exact HMAC paths, account derivation, frozen/balance arithmetic, dynamic fees, fresh nonce/deadline checks, missing credentials, disabled live mode, partial/failed states, distinct real identifiers, duplicate-click protection, status-first recovery, safe errors, and CSV mapping. They do not perform external chain transactions.
