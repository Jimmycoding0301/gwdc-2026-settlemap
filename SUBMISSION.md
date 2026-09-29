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

- Clean-package validation: `npm ci` passed; 74 tests passed; production build passed.
- Commands: `npm test`, `npm run build`
- Browser and OCR notes: [docs/verification.md](docs/verification.md)

## Disclosure

No GasFree Nile API credentials or real GasFree transfer were available for this snapshot. Live adapter behavior is covered by controlled tests; the standard demo is explicitly fixture mode. See [HACKATHON_SCOPE.md](HACKATHON_SCOPE.md).

No open-source license has been selected. The public repository is available to reviewers without sign-in.
