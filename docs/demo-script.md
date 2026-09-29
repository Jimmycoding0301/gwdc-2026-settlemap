# Three-minute demo script

| Time | Action | Line to say |
|---|---|---|
| 0:00–0:25 | Load the full synthetic creator settlement | “Operations starts with spreadsheets and wallet screenshots, not a clean payment API.” |
| 0:25–0:55 | Show exception-only view | Point out the checksum error, duplicate content, prior payment, changed address and unusual amount. |
| 0:55–1:25 | Resolve or defer each exception | Copy the bilingual address-verification message and record the review decision. |
| 1:25–1:50 | Create the grouped manifest | “Nine payable rows become three payments without losing row lineage.” |
| 1:50–2:20 | Run the fixture queue and lose response two | “A provider trace exists, so UNKNOWN blocks a second payment.” |
| 2:20–2:40 | Resume the original trace | Show completion without a new attempt. |
| 2:40–3:00 | Export reconciliation files and show the separate public canary proof | “This three-payment walkthrough is fixture mode. Separately, one GasFree Nile canary for a single recipient is verified on-chain; it does not prove this fixture batch was broadcast.” |

Do not display live-mode success, a TRONSCAN link or an actual fee unless a real GasFree Nile transaction has been independently verified.

For the verified canary, use only the [public evidence index](evidence/README.md) and its linked [Nile transaction](https://nile.tronscan.org/#/transaction/1f3a3de905eeef90570bf297bb592d4ac16383a5a10c1187c4e09b41b5fdd586). State that its amount was `1000001` micro-USDT, its actual fee was `1300000` micro-USDT, and it is separate from the three-payment fixture walkthrough.
