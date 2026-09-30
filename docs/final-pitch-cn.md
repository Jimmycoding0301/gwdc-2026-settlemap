# SettleMap · 5 分钟决赛路演包

## 一句话定位

SettleMap 把活动账表和钱包截图变成可核对、可恢复、可回填的 TRON USDT 结算批次，尤其解决付款响应丢失后最危险的重复付款问题。

## 五分钟逐字稿

### 0:00–0:25 · Slide 1 · 开场

各位评委好，我是 Team 37。一个运营团队要给几十位创作者结算佣金，真正危险的往往不是怎么发出 USDT，而是三件事：地址有没有变、业务有没有付过，以及付款接口没响应时能不能安全重试。

SettleMap 从原始业务行开始，为每一笔付款保留一条可以恢复和核对的证据链。

### 0:25–0:50 · Slide 2 · 产品结果

这是一个可以运行的产品流程。演示数据中有 12 条原始业务，规则筛出 9 条可付款业务，再按收款人、地址和币种归并成 3 笔付款。

归并以后，每一条业务仍然知道自己属于哪一笔付款、当前是什么状态、对应哪个 trace 和回执。

### 0:50–1:25 · Slide 3 · 真实痛点

普通批量付款工具通常只关心付款请求。但运营人员面对的是另一张表：内容编号、达人昵称、历史付款和临时更换的钱包地址。

批量归并可能让原始业务失去身份。更危险的是，浏览器超时并不表示付款失败。如果服务商已经接收请求，操作员再次付款，就可能产生双付。

所以 SettleMap 的核心原则是：状态未知时暂停，查询原来的 trace，绝不直接创建第二笔付款。

### 1:25–1:55 · Slide 4 · 工作流程

流程分成四步。先校验地址、金额、重复内容和历史付款；再保留业务行关系进行归并；用户确认后才准备 TronLink 的 TIP-712 授权；出现不确定结果时，只恢复原请求，最后把状态和费用回填到原始业务行。

下面我用七十秒演示最关键的一段。

### 1:55–3:10 · 浏览器 Demo

**动作 1：点击“载入完整演示”。**

这里载入 12 条创作者佣金记录。系统直接标出重复内容、历史已付、地址变化、异常金额和地址校验错误。正常行可以略过，运营人员只处理异常。

**动作 2：点击“只看异常”，快速展示异常，再恢复“显示全部”。**

地址变化不会被自动接受。系统生成双语核验信息，必须留下人工决定；截图 OCR 也只生成草稿，不会直接获得付款权限。

**动作 3：滚动到付款计划，点击“生成结算清单”，再点击“确认金额与收款人”。**

现在 9 条有效业务被归并成 3 笔付款，但每笔仍保留原始内容编号和业务备注。清单摘要绑定了收款人、金额和行级决定，确认以后不能悄悄改参数。

**动作 4：点击“运行浏览器丢包测试”。**

第一笔确认成功。第二笔模拟浏览器丢失响应，但服务端已经保存 Provider trace，因此它进入 UNKNOWN，第三笔保持排队，整个队列暂停。

**动作 5：点击“查询原 trace 的结果”。**

恢复只查询原 trace，没有第二次 submit，付款尝试次数仍然是 1。完成后可以导出业务 CSV、付款 CSV 和一键对账包。

这段三笔流程是明确标记的本地 fixture，用来稳定展示故障恢复。下面这一页展示独立的真实链上证据。

### 3:10–3:50 · Slide 5 · 技术与真实证据

真实路径由四层组成：GasFree 预检、TronLink TIP-712 授权、服务端 HMAC 提交和独立 Nile Solidity RPC 核验。私钥始终留在钱包里。

我已经完成一笔独立的 GasFree Nile canary。Provider 返回 SUCCEED，链上达到 SOLIDITY，RPC 在区块 71,389,721 的日志 2 精确匹配代币、发送方、接收方和 1.000001 USDT。余额变化同时匹配转账金额加 1.3 USDT 实际费用，而且只广播了一次。

这证明单收款人的真实写入和核验链路已经跑通。刚才的三笔批量流程仍然是 fixture，我不会把两者混在一起。

### 3:50–4:20 · Slide 6 · 用户和商业入口

目标用户是做创作者佣金、活动款和供应商结算的运营团队。钱包逐笔付款很慢，普通批量脚本缺少恢复语义，托管付款 API 又容易让业务行变得不透明。

SettleMap 的切入点是一层非托管的对账和恢复工具。它不持有客户资金，未来可以按团队订阅、批次数量和 ERP 集成收费。

### 4:20–5:00 · Slide 7 · 收尾

目前已经验证的是完整的本地业务闭环，以及一笔真实的单收款人 GasFree Nile canary。下一步是完成多收款人的真实 Nile 批次、在界面保存真实回执，并用真实 trace 演练恢复。

SettleMap 想解决的不是“如何多发几笔交易”，而是让运营团队在地址变化、历史重复和网络不确定时，仍然知道该付谁、付了什么，以及为什么绝不能再付一次。

每一条业务有去向，每一次不确定都有原 trace。谢谢。

## 现场 Demo 操作卡

### 上台前状态

1. 打开 PPT，停在 Slide 1。
2. Chrome 打开 `http://127.0.0.1:5174/`，页面置顶。
3. 确认顶部显示 `FIXTURE · 本地模拟`，不要切到 Nile 实时模式。
4. 若页面已运行过，点击“重置完整演示”。
5. 关闭系统通知、聊天弹窗和无关浏览器标签。
6. 另开两个备用标签：公开证据 JSON 和 Nile TRONSCAN 交易。
7. QuickTime 或浏览器提前打开 `docs/submission/demo.mp4`，作为无网或页面异常时的备用演示。

### 七十秒点击顺序

1. `载入完整演示`
2. `只看异常 3`，停留两秒，再点 `显示全部`
3. 滚动至计划区，展示 `12 → 9 → 3`
4. `生成结算清单`
5. `确认金额与收款人`
6. `运行浏览器丢包测试`
7. 指出 `CONFIRMED / UNKNOWN / QUEUED` 和已经保存的 trace
8. `查询原 trace 的结果`
9. 指出三笔 attempt 都是 `1`
10. 指向 `一键对账包`，不要现场下载

### Demo 失败时的处理

- 页面没有响应：立即说“我切换到提交时录制的 67 秒完整流程”，播放 `demo.mp4`。
- 本地服务断开：不要现场修复，播放视频并回到 Slide 5。
- TRONSCAN 加载慢：留在 Slide 5，直接读出交易哈希结尾 `…dd586`、区块 `71389721`、日志 `2`。赛后让评委打开仓库证据。
- 任何真实接口失败：不要点击重复提交。说“这正是 SettleMap 把 UNKNOWN 与 FAILED 分开的原因”，然后使用公开证据页。
- 时间落后超过 20 秒：跳过 Slide 6 的竞品逐项解释，只说目标用户与非托管定位。

## 3 分钟评委问答

### 1. 这三笔付款真的上链了吗？

没有。标准三笔演示是明确标记的 fixture，用来稳定展示行级归并、丢包暂停和 trace 恢复。真实链上证据是一笔独立的单收款人 GasFree Nile canary，Provider、Nile RPC、Transfer 日志和余额变化都已核验。下一步才是完整多收款人真实批次。

### 2. 为什么不直接写一个批量转账脚本？

脚本解决提交效率，但没有解决业务行身份、历史重复、地址变化和不确定结果。SettleMap 把每条业务绑定到付款清单，并在 UNKNOWN 时恢复原 trace，因此运营人员能证明每一行最后去了哪里，也不会因为超时盲目重付。

### 3. 你怎么防止重复付款？

创建、确认和执行前都会检查历史业务状态。提交后保存 requestId 和 traceId。只要状态是 PROCESSING 或 UNKNOWN，队列暂停，只查询原 trace。只有明确失败并重新人工授权，才允许新的尝试。

### 4. 如果服务端连 traceId 都没有收到呢？

当前不能承诺自动找回。系统会保留待核查状态并阻止重付，等待 Provider 支持或人工核验。我们宁可暂停，也不会把未知状态当成失败。这是公开写在产品和文档里的边界。

### 5. 钱包和 API 密钥安全吗？

钱包私钥始终留在 TronLink。浏览器只发起 TIP-712 签名，服务端用 GasFree 凭据提交，并且锁定 Nile 网络、付款账户、nonce、费用和授权期限。公开证据不包含 API Secret、私钥、签名或原始授权数据。

### 6. 如何证明链上交易就是你的这笔付款？

我们没有只看 txHash。系统通过 Nile Solidity RPC 核验成功回执，并匹配 TRC-20 Transfer 的 token、from、to 和精确 amount。公开 canary 还核对了付款账户余额减少值等于 1.000001 USDT 加 1.3 USDT 费用。

### 7. AI 在哪里？

AI 只帮助处理非结构化输入，例如本机 Vision 从截图生成账表草稿。地址、金额、去重、历史状态和付款授权全部由确定性代码控制。OCR 结果必须人工确认，模型不能直接获得付款权限。

### 8. 为什么选择 TRON 和 GasFree？

跨境团队已经大量使用 TRON USDT，但收款人和运营人员不一定愿意准备 TRX。GasFree 降低了使用门槛，同时也引入 Provider 状态、费用和恢复语义。SettleMap 正好负责把这些链上状态重新连接到原始业务表。

### 9. 商业模式是什么？

产品保持非托管。可以按团队工作区、月度结算批次和 Sheets 或 ERP 连接器收费。大客户需要审批策略、审计导出和运行监控，这些会形成更高等级的订阅。

### 10. 你的主要竞争优势是什么？

重点不是交易入口，而是行级身份和失败恢复。钱包工具偏执行，批量脚本偏效率，托管 API 偏代办。SettleMap 保留原始业务行、人工决定、Provider trace、链上核验和导出之间的对应关系。

### 11. 现在最大的未完成项是什么？

完整多收款人的 Nile 批次，以及浏览器 TronLink 到 GasFree 再到逐行对账包的真实端到端验收还没有完成。当前真实证据覆盖一笔单收款人 canary。我把这个边界放在 README、PPT 和公开 JSON 中。

### 12. 如何扩展到大量付款？

当前队列按 Provider pending 限制串行执行。规模扩大后，可以按付款账户和批次窗口分片，但每一片仍保留 idempotency、trace 恢复和行级映射。扩展不能牺牲重复付款保护。

## 绝对不要说的内容

- 不要说“三笔演示批次已经真实上链”。
- 不要说“浏览器 TronLink 完整批次已经端到端验证”。
- 不要把 `sim_` requestId、trace 或 hash 当成真实链上数据。
- 不要说 GasFree 可以保证找回没有 traceId 的请求。
- 不要说 1.3 USDT 是所有付款的固定费用；它只是本次 canary 的实际费用。
- 不要说 OCR 可以自动确认地址；OCR 只生成待核对草稿。
- 不要承诺已经有真实客户、收入或生产资金规模。

## 30 秒备用版本

SettleMap 是面向创作者佣金和活动结算的 TRON USDT 对账工具。它从表格和截图整理业务，拦截重复付款与地址变化，把多条业务归并成付款，同时保留逐行关系。付款响应丢失时，系统把状态标记为 UNKNOWN，暂停后续队列并查询原 GasFree trace，避免重复付款。我们已经验证完整的本地恢复流程，并完成一笔真实的 GasFree Nile 单收款人 canary。下一步是多收款人真实批次。

## 英文开场与收尾

**Opening:** Good afternoon. SettleMap turns creator commission sheets and wallet screenshots into a validated TRON USDT settlement manifest. It preserves every business row and, when a payment response disappears, it recovers the original GasFree trace instead of paying twice.

**Closing:** One verified canary proves the live write path. The complete multi-recipient batch remains the next milestone. SettleMap gives every payout row a destination and every uncertain payment one recoverable trail. Thank you.

## 证据速记

- Nile transaction: `1f3a3de905eeef90570bf297bb592d4ac16383a5a10c1187c4e09b41b5fdd586`
- Provider / chain: `SUCCEED / SOLIDITY`
- Block / log: `71389721 / 2`
- Amount: `1.000001 USDT`
- Actual fee: `1.3 USDT`
- Broadcast count: `1`
- Fixture result: `12 raw rows → 9 payable rows → 3 grouped payments`

