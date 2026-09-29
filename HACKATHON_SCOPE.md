# Hackathon scope disclosure

## English

This repository is the GWDC 2026 Korea TRON Challenge C submission snapshot assembled on **2026-09-29 KST**. The original workspace did not contain a usable baseline commit history, so this document states the known scope without manufacturing earlier commits or inferring provenance from file timestamps.

### Existing work and reused foundations

- The project uses React, Vite, Express, TypeScript, Vitest, Zod and the official GasFree SDK.
- GasFree APIs, TIP-712 formats, TRON RPC semantics and ecosystem marks belong to their respective owners.
- CSV import, duplicate detection and reconciliation exports are established operational patterns.

### GWDC-specific implementation and verification

- The product was focused on a Seoul marketing operator paying Southeast Asian creator commissions.
- Spreadsheet paste, local screenshot OCR, TRON checksum checks, duplicate and historical-payment detection, changed-address review and payment grouping were integrated.
- Fixture recovery demonstrates a lost browser response while preserving and resuming the same provider trace.
- The live adapter implements GasFree preflight, TronLink signing, submission, recovery, independent Nile transaction/receipt/log verification and reconciliation export.
- Automated tests, responsive browser flows, security boundaries and the standalone submission package were completed.

No GasFree credentials or real Nile GasFree transfer were available in this snapshot. Mocked or fixture identifiers are never presented as real chain evidence.

### AI assistance

OpenAI Codex assisted implementation, testing, review, documentation and packaging. The participant remains responsible for the submission.

## 中文

本仓库是 2026-09-29 KST 整理的 TRON C 提交快照。项目复用了开源框架、官方 GasFree SDK 和公开协议资料；GWDC 场景整合了 KOL 佣金、截图整理、错址和重复检查、trace 恢复与对账导出。当前没有 GasFree 凭据或真实 Nile 付款，因此只如实展示 fixture 与适配代码。

