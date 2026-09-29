# SettleMap 本地验证记录

验证日期：2026-09-28（KST）；链上证据代码复验：2026-09-29（KST）。浏览器结果覆盖本地 fixture；自动测试同时覆盖 fixture 与注入传输层的 GasFree Nile 适配/编排。两者都不是外部 GasFree 鉴权或真实链上付款证明。受限浏览器中的剪贴板拒绝与手动复制回退已经验证；允许权限后的实际写入仍未单独验证。

2026-09-30 本地复验：`npm test` 通过 9 个测试文件、84 项测试，`npm run build` 通过。新增覆盖当前 `window.tron` / `eth_requestAccounts`、旧接口回退、Nile 网络锁、官方 Nile typed-data 域、确定性 settlement manifest、逐笔 operation hash，以及 GasFree 成功后通过 Nile Solidity RPC 对交易正文、成功回执和 TRC-20 `Transfer` 的 token/from/to/amount 做独立核验。还覆盖授权时间窗口（前后 30 秒时钟容差）和全本机 store 的 `(txHash, transferLogIndex)` 防复用。RPC 缺失、不匹配、超出授权窗口或证据已占用都不会标记成功。manifest/operation hash 是本地对账元数据，没有上链，也没有签入 TIP-712。这一段只记录自动化回归；真实 canary 的外部证据单独列在下方。

## 真实 GasFree Nile canary（2026-09-30 KST）

通过 one-shot 工具完成一笔独立、单收款人的 GasFree Nile 转账。该证据只证明这一笔 canary，不是标准演示中的三笔 fixture 批次，也不证明浏览器 TronLink 流程已端到端运行。

| 字段 | 已验证结果 |
| --- | --- |
| Provider / chain | `SUCCEED` / `SOLIDITY` |
| Verification | `gasfree-provider+nile-solidity-rpc`; `exactTransferVerified: true` |
| Transaction | [`1f3a3de905eeef90570bf297bb592d4ac16383a5a10c1187c4e09b41b5fdd586`](https://nile.tronscan.org/#/transaction/1f3a3de905eeef90570bf297bb592d4ac16383a5a10c1187c4e09b41b5fdd586) |
| Block / log | `71389721` / `2` |
| Token | `TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf` |
| GasFree sender | `TH3V9cnUct542ss5ZgAzNHWnFH9ycB1Tw1` |
| Receiver | `TQcxtc1CmGRL8NwuDs3LewTBFycgXb28AR` |
| Amount / actual fee | `1000001` / `1300000` micro-USDT |
| Independent post-state query | GasFree balance `1997699999`; receiver balance `1000001` raw micro-USDT. The GasFree decrease from `2000000000` is `2300001`, matching amount + fee |
| Request / trace | `4198b7d4-da5d-4d16-b30a-7439f26530b2` / `6abc5473-0f57-4f0c-92a6-18f7efc3adc3` |

[脱敏公开 JSON](evidence/gasfree-nile-canary.json)的交易结果字段由忽略的本地证据记录按白名单导出，`postState` 部分来自独立余额查询。[证据索引](evidence/README.md)说明 Provider 与 Nile RPC 各自证明的范围。公开文件不包含 API Key/Secret、钱包私钥、签名、授权摘要或私有 journal。

## B.AI 风格与本机截图导入（最新）

- 暖白留白、黑色顶栏提示与胶囊操作、大号衬线标题、虹彩提示和细灰边已替换原深绿布局；安全状态色及 fixture / Nile 边界保留。预检区补充完整付款人、代币合约、服务商地址、pending 限制和授权期限。
- 新增 `POST /api/intake/screenshot`：PNG/JPEG 的 MIME/魔数/尺寸/1 MiB 上限；仅本机 Apple Vision，30 秒超时，私有临时图片与精简子进程环境，完成或失败后清理。无完整表头返回空草稿与固定提示。接口不创建批次、不调用 GasFree、不返回完整 OCR 原文。
- 截图可选择、拖入或粘贴。图片只在当前弹窗预览；点击本机识别后逐行显示可编辑字段、置信提示及该行原文，勾选核对后才可替换当前账表。导入后可以撤销，仍然需要规则校验、生成清单、确认与签名。
- 顶部万能输入识别 TSV/CSV 后先打开待确认文本区；地址或业务单搜索只定位已有行。⌘/Ctrl K 面板包含粘贴、截图、异常筛选、历史检查、继续未结算；Tab 聚焦、Esc 关闭并恢复原焦点。
- 只含异常的交接文本排除正常业务，包含历史已付/待查、地址变化、失败与处理中项；剪贴板失败时明确报错并打开手动复制区，不误报成功。

实际本机 Vision 烟测：使用 `tests/fixtures/create-table.swift` 生成的合成 PNG（2 行、无真实业务）。成功识别 `INV-OCR-001` / `INV-OCR-002`、两位收款人、金额 `12.500001` / `7.25` 与备注。首行地址小写 `y` 被识别成大写 `Y`；系统通过 Base58Check 将该行降为低置信并提示地址校验和错误，原值不自动修复。第二行地址通过，保留为待人工核对草稿。这一真实误识别说明 OCR 置信度不等于付款安全。

新增测试覆盖万能输入意图分类、保守表格提取、地址大小写/校验和、未知币种和金额不猜测、识别不授予人工复核标记、异常清单范围、图片安全验证、敏感哨兵脱敏、固定错误、临时文件清理、非 macOS 明确失败、超时与并发拒绝，以及真实 HTTP OCR 路由无 batch 副作用。

B.AI / OCR 阶段当轮检查为 7 个测试文件、64 项测试；2026-09-30 全量结果为 9 个文件、84 项，TypeScript 与 Vite production build 通过。测试使用合成凭据/注入 OCR；本机 Vision 另行实测。

最终统一浏览器复核：桌面 `1280 px` 与手机 `390 px` 下页面宽度分别等于视口宽度，无横向溢出，浏览器错误列表为空。⌘/Ctrl K 打开 5 项快捷面板，Esc 关闭并恢复页面滚动；业务单搜索找到并标出 2 条同号业务；一行 TSV 只打开待确认粘贴区，原 12 行账表保持不变。

截图导入使用合成文件 `tests/fixtures/settlement-table.png` 走完整页面流程：默认 0 行获确认，按钮禁用；识别出 2 行后，首行因地址校验和失败显示“重点核对”，第二行显示“较清晰，仍需核对”。明确勾选后才替换并重新校验，页面出现撤销入口与“尚未创建付款批次”提示，服务端批次数在前后均为 0。受限剪贴板触发手动复制区，交接文本明确只含 3 条异常或待核查业务。

本轮截图：[390 px 页面](bai-root-mobile.png)；[截图识别待确认状态](bai-root-ocr-review.png)。

## 自动检查

从工作区根目录执行：

```bash
npm run test:tron
npm run build:tron
```

付款与 GasFree 基线：SettleMap 原有 47 项测试通过；本轮新增结果见上方。TypeScript（tsc）检查和 Vite 生产构建通过。

测试覆盖：

- TRON Base58Check 地址校验、金额 micro-USDT 精度和异常金额。
- CSV 引号、逗号、换行及表格公式注入防护。
- 12 行样例中的无效地址、重复业务单和异常金额隔离。
- 9 条有效业务按收款人、地址及币种合并为 3 笔付款。
- 清单摘要绑定，变更付款参数后拒绝执行。
- 并发执行、重复运行和跨批次 UNKNOWN 绕过保护。
- 服务端保存 trace 后浏览器响应丢失；重启服务仍以原 requestId/traceId 恢复且不增加 attempt。
- 回执缺失或参数不匹配时保持 UNKNOWN，不继续第三笔。
- 两层 CSV 导出；业务表保持逐行映射，实际手续费只在支付表计算一次。
- live 请求缺少凭据时失败且不回退 fixture；预检绑定 GasFree 账户、支持币种、Provider、余额、冻结金额、nonce 和动态费用。
- 官方 SDK 生成 TIP-712，服务端保存精确授权后才交给 TronLink；提交接口只接收匹配的 paymentId、requestId 与签名，不接受浏览器重构授权。
- 提交前重新检查 nonce、余额、pending、费用和期限；PROCESSING/UNKNOWN 只查询原 trace，明确失败后暂停剩余队列等待复核。
- live 在生成钱包授权前和收到签名准备提交前都重新检查跨批次历史；即使重复业务的两个草稿先后确认，也不能用旧授权绕过已结算/待核查拦截。
- TronLink 调用保持 `trx` 方法上下文，优先使用当前 provider，并在连接与签名前强制切换及确认 Nile；当前账户仍须等于授权中的付款账户，typed-data 必须使用官方 Nile chainId 和 controller。私钥不离开钱包，TIP-712 签名会提交给本机后端并由其转发 GasFree。余额不足或签名前费用变化时，最新预检优先展示完整派生账户、余额、冻结、费用和阻断原因；换钱包会清除旧账户的当前批次与预检视图。
- requestId、traceId、txHash 分列；仅 GasFree `SUCCEED` + `SOLIDITY` + 有效 txHash 映射为确认，实际费用只采信成功结果中的 `txnTotalFee`。
- 实际 HTTP 路由完成 sample → preview → create → confirm → run → recover 流程，并且健康接口不泄露凭据。
- 超额复核、暂缓及其原因进入确认清单和导出，相关标记受摘要绑定。
- 部分完成的历史批次按逐笔状态查重，历史已付及待核查业务阻止重复付款；执行前重新检查其他批次完成后的冲突。
- 地址变化未人工复核时，创建、确认和运行三个阶段均拦截；复核后保留变化提示，核址标记进入摘要与导出。
- fixture 重置先保存可恢复备份，拒绝非 fixture 状态。
- ZIP 包含两份 CSV、批次快照和 manifest；文件摘要可重新计算核对。

## 原有流程浏览器检查基线

上一轮浏览器在桌面和 390 × 844 手机视口完成检查：页面有内容、没有 Vite 错误层、没有横向页面溢出，关键控件可通过无障碍名称定位。本轮新增交互的手机复核结果单独记录在下表。

实际走通的演示结果：

1. 首屏解释对账断层、重复付款、可用余额错觉和串行队列四个现实痛点，并明确“服务端未收到 trace 时不能保证自动恢复”的边界。
2. 页面显示 12 条原始业务、9 条可结算、3 条暂缓、3 个计划付款和 6 USDT 演示费率差额。
3. 生成批次后展开 Mina 的付款，逐条显示 `20 + 35 + 25 = 80 USDT` 及三条原始业务备注。
4. 确认清单摘要后运行浏览器丢包测试：Mina 已确认；Joon 变为 UNKNOWN；Sora 保持 QUEUED。
5. 查询 Joon 的原 trace 后完成恢复；三笔付款各只有一个 attempt。
6. 页面出现业务明细和支付汇总两个 CSV 下载入口。
7. 导出的业务 CSV 有 12 条原始记录及付款映射；支付 CSV 有 3 个分组，合计只记录 3 USDT 模拟实际费用。

## 新增运营交互复核

以下结果来自实际桌面和手机浏览器检查及上述自动测试。历史检查使用独立用例；其中“12 条已付”不是把原始标准样例的 3 条异常算作付款。

| 检查项 | 实际观察或验证范围 | 状态 |
| --- | --- | --- |
| 中文列 TSV 粘贴 | 实际粘贴并读取带中文表头的区域；CSV 引号等解析另由自动测试覆盖。本轮未据此宣称所有列名组合均已浏览器测试 | 已通过 |
| 默认只看需处理 | 实际检查默认异常过滤，集中显示需处理业务 | 已通过 |
| 行级快捷处理 | 实际完成超额复核、独立业务生成新单号、地址修改后重校验和批量暂缓；金额复核后再次修改金额，旧复核标记自动清除。地址编辑也由实现清除相应核址标记，避免旧确认用于新参数 | 已通过（金额标记清除已实测） |
| 历史逐笔查重 | 浏览器独立用例显示 12 条已付和 1 条地址变化；自动测试覆盖部分批次逐笔识别及 UNKNOWN | 已通过 |
| 后端重复拦截 | 浏览器创建批次时被历史重复拦截；自动测试覆盖历史冲突与执行前重新检查 | 已通过 |
| 地址变化 | 实际验证未核址时返回 409，记录人工核址后可以建立 DRAFT；自动测试覆盖 create/confirm/run 三阶段拦截。`reviewedAddressChange` 或 `deferred` 是必要处理决定，不证明地址归属 | 已通过 |
| 继续未结算 | 暂停后刷新找回原批次；以含 `RESUME-101`、`RESUME-102` 的自定义批次实际验证，点击继续后左侧业务行与付款队列一并恢复。recover 查询原 trace，待核查付款的 attempt 未增加 | 已通过 |
| 自动回填 | 实际查看逐行业务回填及异常保留；“每行已有去向”未表述为全部付款 | 已通过 |
| 复制回执 | 自动化浏览器拒绝剪贴板权限；界面明确报错并提示手动复制，未误报复制成功。未验证允许权限后的真实剪贴板写入 | 权限受限路径已验证 |
| 一键对账包 | 实际下载并解压四个文件：两份 CSV、`batch.json` 和 `manifest.json`；自动测试验证文件摘要 | 已通过 |
| 重置演示 | 自动测试验证 fixture 备份与非 fixture 拒绝；本轮未单独记录浏览器重置验证 | 自动测试通过 |
| 桌面 | 本轮交互完成，未观察到浏览器运行错误 | 已通过 |
| 手机 | 390 × 844 视口下，document/body 的 scrollWidth 均为 390；默认仅显示 3 条异常，3 个快捷按钮可见，无控制台错误。最终清理后的页面无残留 banner、无横向溢出 | 已通过 |

剪贴板仍仅完成浏览器权限受限路径验证；允许权限后的实际写入未验证，不能写成复制成功。

## GasFree 接线后的浏览器回归

- 重新走通安全演示：生成 3 笔清单、确认、故障注入后得到 1 笔确认 / 1 笔待核查 / 1 笔排队，再查询原 trace 完成 3 笔；页面出现两层 CSV 与一键对账包入口。
- 最终页面控制台没有 error；开发期间的 Vite 热更新 debug 记录不属于运行错误。
- 390 × 844 下 `innerWidth`、`document.body.scrollWidth` 与 `document.documentElement.scrollWidth` 均为 390，无横向页面溢出。
- 这组 2026-09-29 截图中，切到 GasFree Nile 模式后，页面明确显示 TronLink 未连接与服务端缺少 API Key/Secret；“读取真实预检并生成清单”保持禁用，没有静默回退 fixture。这是 canary 之前的历史 UI 回归记录。
- 截图保存在 `verification-live-ui.png`、`verification-paused.png`、`verification-completed.png`、`verification-mobile-live-ui.png` 和 `verification-mobile-live-disabled.png`。

## 已验证与剩余范围

- 真实 GasFree 鉴权、单笔授权提交、Provider 状态查询、traceId / txHash 关联、固化成功回执、精确 Transfer 日志与实际费用已由上述单笔 canary 验证。
- 浏览器 TronLink TIP-712 签名、完整三笔批次的真实串行提交/恢复、以及该真实批次的逐行对账包仍未做外部端到端验收。
- 公开 canary JSON 只附带初始/事后原始余额的一致性复核，不展开 nonce、`frozen` 或预检时报价；这些未展开字段不作为独立的公开验收结论。

本文件中的 `sim_` 标识仍只属于 fixture，不得用来扩大上述单笔 canary 的证据范围。
