# Security policy

## Reporting

Use GitHub private vulnerability reporting or a private Security Advisory after publication. Never paste an API secret, wallet signature, seed phrase or exploit into a public issue.

## Credential boundary

- `GASFREE_API_KEY`, `GASFREE_API_SECRET` and `TRONGRID_API_KEY` are server-only secrets and must never use a `VITE_` prefix.
- Never commit `.env`, `.data`, reconciliation files containing real business data, wallet files, private keys or seed phrases.
- The backend does not request a wallet private key. TronLink provides a fresh TIP-712 signature only after explicit confirmation.

## Live-payment controls

- `ENABLE_GASFREE_LIVE=true` is required in addition to valid credentials and a Nile wallet.
- Confirm the GasFree account, token, receiver, amount, maximum fee, nonce and deadline before every signature.
- An unknown or timed-out result blocks repayment and resumes the original trace.
- Provider status links a trace to a transaction; independent Nile Solidity RPC must still verify finality, successful execution and the exact TRC-20 `Transfer` event.

Use only dedicated Nile test accounts and test tokens. This prototype has not received a production security audit.

## Dependency note

At packaging time, `npm audit --audit-level=moderate` reported no moderate or high vulnerabilities and four low-severity `elliptic` findings inherited through the official GasFree SDK's legacy Ethereum utility chain. The SDK was retained to preserve official API compatibility; this risk should be rechecked when the upstream SDK updates.
