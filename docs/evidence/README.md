# Public evidence index

| Evidence | What it establishes | Scope |
| --- | --- | --- |
| [`gasfree-nile-canary.json`](gasfree-nile-canary.json) | GasFree reported `SUCCEED + SOLIDITY`; Nile Solidity RPC independently verified the successful exact TRC-20 `Transfer` at block `71389721`, log index `2` | One standalone recipient canary only; it does not cover the three-payment fixture batch |
| [Nile TRONSCAN transaction](https://nile.tronscan.org/#/transaction/1f3a3de905eeef90570bf297bb592d4ac16383a5a10c1187c4e09b41b5fdd586) | Public explorer view for transaction `1f3a3de905eeef90570bf297bb592d4ac16383a5a10c1187c4e09b41b5fdd586` | Explorer presentation; the JSON records the Provider trace association and exact-log verification result |

The transfer-result fields in the JSON are a whitelist-only export from the ignored local evidence record; the `postState` section records the separate independent balance query. The public record contains public addresses, integer amounts and fees, request/trace/transaction identifiers, and verification results. It excludes API credentials, wallet private material, the TIP-712 signature, authorization digest, and the private recovery journal.

GasFree Provider evidence establishes the `traceId -> txHash` association. Nile Solidity RPC independently establishes transaction finality, successful execution, and the exact token/from/to/amount log. Neither source proves that the synthetic three-payment fixture demo was broadcast.

An independent post-state token balance query returned `1997699999` raw micro-USDT at the GasFree address and `1000001` raw micro-USDT at the receiver. Against the initial GasFree balance of `2000000000`, the `2300001` decrease equals the `1000001` transfer plus the `1300000` actual fee. This is a consistency cross-check for the same canary, not evidence of another payment.
