# Hackathon scope disclosure

## English

This repository is the GWDC 2026 Korea TRON Challenge C submission snapshot assembled on **2026-09-29 KST**, with one public Nile canary evidence record added on **2026-09-30 KST**. The original workspace did not contain a usable baseline commit history, so this document states the known scope without manufacturing earlier commits or inferring provenance from file timestamps.

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

One standalone, one-recipient GasFree Nile canary was submitted and verified. GasFree reported `SUCCEED + SOLIDITY`; Nile Solidity RPC independently verified the exact TRC-20 transfer at block `71389721`, log index `2`. The [sanitized public record](docs/evidence/gasfree-nile-canary.json) and [Nile TRONSCAN transaction](https://nile.tronscan.org/#/transaction/1f3a3de905eeef90570bf297bb592d4ac16383a5a10c1187c4e09b41b5fdd586) contain no credentials or signing material.

This canary is separate from the synthetic three-payment fixture demo. It does not establish that the fixture batch or the browser/TronLink flow was broadcast end to end. Mocked or fixture identifiers are never presented as real chain evidence.

### AI assistance

OpenAI Codex assisted implementation, testing, review, documentation and packaging. The participant remains responsible for the submission.

## 中文

本仓库是 2026-09-29 KST 整理的 TRON C 提交快照，并于 2026-09-30 KST 补入一笔公开 Nile canary 证据。项目复用了开源框架、官方 GasFree SDK 和公开协议资料；GWDC 场景整合了 KOL 佣金、截图整理、错址和重复检查、trace 恢复与对账导出。该 canary 是一笔独立的单收款人转账，Provider 为 `SUCCEED`、链状态为 `SOLIDITY`，Nile Solidity RPC 已核验精确 Transfer；它不代表三笔 fixture 批次或浏览器 TronLink 全流程已上链。公开文件不包含 API 凭据、私钥、签名或恢复 journal。
