# One-shot GasFree Nile transfer

This operator command is a narrow path for producing one honest SettleMap testnet evidence record. It reuses the application adapter for official GasFree HMAC authentication, `@gasfree/gasfree-sdk` TIP-712 assembly, a fresh nonce/balance/fee check immediately before submission, provider trace recovery, and an independent Nile Solidity RPC check of the exact TRC-20 `Transfer` token, sender, receiver, and amount.

It is read-only by default. A normal run performs only GasFree configuration/account reads and a Nile `balanceOf` call. It does not read a signer key, create a signature, or submit a transfer.

## External prerequisites

1. A GasFree developer **Nile** API key and HMAC secret in the ignored local `.env` as `GASFREE_API_KEY` and `GASFREE_API_SECRET`.
2. `GASFREE_BASE_URL=https://open-test.gasfree.io/nile` and `GASFREE_TRON_RPC_URL=https://nile.trongrid.io`. This build rejects other origins.
3. A dedicated Nile EOA and its 32-byte hexadecimal private key in an ignored regular file such as `.data/gasfree-nile-signer.key`. Set its permissions to `0600`. Do not put the key or seed phrase in `.env`, a command argument, logs, evidence, or Git.
4. Test USDT in the **derived GasFree account** reported by preflight. Funding only the EOA is insufficient. The available balance must cover the exact transfer plus the current activation and transfer fees, after frozen funds.
5. A test receiver address and a unique integer micro-USDT amount. Use a new `--intent` for the reviewed operation.
6. `ENABLE_GASFREE_LIVE=true` only for the final reviewed broadcast command. Leave it `false` for preflight.

## 1. Read-only preflight

```sh
npm run gasfree:nile -- \
  --payer <NILE_EOA> \
  --receiver <TEST_RECEIVER> \
  --amount-micros 1000001 \
  --intent demo-001
```

Review the derived GasFree address, selected USDT contract and provider, nonce, available/frozen balances, current fees, maximum debit, and blockers in the console and `.data/gasfree-one-shot/demo-001.evidence.json`. When discovery returns more than one provider or eligible token, rerun with the reviewed `--provider` and `--token` addresses.

## 2. Fund and rerun preflight

Send sufficient **Nile test USDT** to the derived GasFree address. Rerun the same read-only command until `preflight.ready` is `true`. Preflight expires after 30 seconds; the broadcast path always obtains a new snapshot and the adapter checks it again immediately before the only submit POST.

## 3. Broadcast once

Use a fresh intent ID for the actual operation and review every value again:

```sh
npm run gasfree:nile -- \
  --payer <NILE_EOA> \
  --receiver <TEST_RECEIVER> \
  --amount-micros 1000001 \
  --intent demo-001-live \
  --signer-key-file .data/gasfree-nile-signer.key \
  --broadcast \
  --confirm-broadcast BROADCAST_ONE_NILE_GASFREE_TRANSFER
```

Three gates must agree: `ENABLE_GASFREE_LIVE=true`, `--broadcast`, and the exact confirmation phrase. The key must derive the declared payer, and the SDK-generated domain must be Nile chain ID `3448148188` with controller `THQGuFzL87ZqhxkgqYEryRAd7gqFqL5rdc`.

Before the POST, the CLI writes `.data/gasfree-one-shot/<intent>.journal.json` with phase `BROADCASTING`. That intent then remains single-use even if the process or network fails. The tool never submits a second POST. If no trace ID is returned, preserve the journal and reconcile manually with the provider; do not rerun with a new intent until the first request is resolved.

When a trace ID exists, the command only queries that trace for up to 120 seconds by default. `--poll-seconds` accepts `0` through `300`. A timeout or incomplete result exits nonzero and does not claim success.

If the provider trace solidifies later, resume read-only verification from the durable journal:

```sh
npm run gasfree:nile -- --recover-intent demo-001-live --poll-seconds 120
```

Recovery requires the GasFree API credentials so it can query the saved trace, but it does not require `ENABLE_GASFREE_LIVE=true` or the signer key. It never signs and never calls the submit endpoint. An intent journal with no saved trace cannot be recovered automatically because the official interface does not document request-ID lookup; preserve it for manual provider reconciliation.

## Verified public canary

On 2026-09-30 KST this path produced one verified, one-recipient Nile canary. GasFree reported `SUCCEED + SOLIDITY`, and Nile Solidity RPC verified the exact transfer at block `71389721`, log index `2`. See the [public evidence index](evidence/README.md), [sanitized JSON](evidence/gasfree-nile-canary.json), and [Nile TRONSCAN transaction](https://nile.tronscan.org/#/transaction/1f3a3de905eeef90570bf297bb592d4ac16383a5a10c1187c4e09b41b5fdd586).

This is evidence for one standalone canary only. It does not establish that the synthetic three-payment fixture batch or the browser/TronLink flow was broadcast end to end.

## Evidence acceptance

The sanitized evidence file contains public addresses, integer amounts and fees, request/trace/transaction identifiers, result status, and chain verification. It never contains the API key, HMAC secret, wallet private key, seed phrase, or signature.

Only accept the run as a real testnet transfer when all of these are present:

- `result.status` is `CONFIRMED`;
- `result.verificationSource` is `gasfree-provider+nile-solidity-rpc`;
- `result.chainState` is `SOLIDITY`;
- `result.chainVerification.status` is `VERIFIED`;
- the verified token, GasFree sender, receiver, integer amount, transaction hash, block and Transfer log index match the reviewed preflight;
- `exactTransferVerified` is `true` and `broadcastPostCount` is `1`.

A preflight file, request ID, trace ID, provider success without Solidity verification, or transaction hash without the exact log match is not success evidence.

The protocol mapping and official source links remain documented in `server/integration/README.md`. Automated tests use injected transports and public synthetic keys; they do not contact GasFree or broadcast a transaction.
