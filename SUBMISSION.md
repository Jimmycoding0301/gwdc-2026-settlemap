# GWDC 2026 Korea submission

| Field | Value |
|---|---|
| Ecosystem / Challenge | TRON · Challenge C |
| Project | SettleMap |
| Repository name | `gwdc-2026-settlemap` |
| Team name | **TODO: team leader** |
| Team leader | **TODO: team leader** |
| Contact email | **TODO: personal submission email** |
| Telegram | **TODO: Telegram handle** |
| Repository URL | <https://github.com/Jimmycoding0301/gwdc-2026-settlemap> |
| Demo video, ≤3 minutes | <https://github.com/Jimmycoding0301/gwdc-2026-settlemap/raw/refs/heads/main/docs/submission/demo.mp4> |
| Pitch deck | <https://github.com/Jimmycoding0301/gwdc-2026-settlemap/raw/refs/heads/main/docs/submission/pitch-deck.pptx> |
| Local demo | `npm ci && npm run dev` → <http://127.0.0.1:5174> |

## Short description

**English:** SettleMap converts creator commission sheets and wallet screenshots into a validated TRON USDT settlement manifest, blocks duplicates and address changes, resumes the original GasFree trace after uncertain responses, and exports row-level reconciliation evidence.

**中文：** SettleMap 把 KOL 账表与钱包截图整理成可核对的 TRON USDT 清单，拦截重复和地址变化，付款响应丢失时恢复原 GasFree trace，并导出逐行业务对账证据。

## Challenge mapping

- Spreadsheet/CSV import and exception correction.
- GasFree payer/token/balance/fee preflight adapter.
- Explicit confirmation and TronLink TIP-712 signing path.
- Per-transaction states, request/trace/hash fields and safe recovery.
- Business-row and payment reconciliation exports.

## Evidence and validation

- Validation: `npm ci` previously passed; the 2026-09-30 run has 84 passing tests and a passing production build.
- Commands: `npm test`, `npm run build`
- Browser and OCR notes: [docs/verification.md](docs/verification.md)
- Real Nile canary: GasFree `SUCCEED`, chain `SOLIDITY`, exact TRC-20 `Transfer` independently verified at block `71389721`, log index `2`.
- Public proof: [sanitized evidence JSON](docs/evidence/gasfree-nile-canary.json), [evidence index](docs/evidence/README.md), and [Nile TRONSCAN transaction](https://nile.tronscan.org/#/transaction/1f3a3de905eeef90570bf297bb592d4ac16383a5a10c1187c4e09b41b5fdd586).

## Disclosure

The public chain evidence covers one standalone, one-recipient canary with amount `1000001` micro-USDT and actual fee `1300000` micro-USDT. It does not cover the standard three-payment fixture demo or establish that the browser/TronLink batch flow ran end to end. The standard demo remains explicitly fixture mode; controlled tests cover the wider adapter and recovery behavior. See [HACKATHON_SCOPE.md](HACKATHON_SCOPE.md).

No open-source license has been selected. The public repository is available to reviewers without sign-in.
