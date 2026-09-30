# SettleMap 决赛提词卡

## 5:00 时间轴

- `0:00` 风险：换址、历史重复、超时双付
- `0:25` 结果：12 行 → 9 行 → 3 笔，仍保留逐行映射
- `0:50` 痛点：批量后业务行失去身份；超时不等于失败
- `1:20` 流程：Review → Group → Authorize → Recover
- `1:40` 播放 67 秒 Demo，不重复讲解
- `2:47` 真实证据：SUCCEED / SOLIDITY / block 71389721 / log 2
- `3:35` 用户：创作者、活动、供应商结算团队；非托管 SaaS
- `4:05` 边界：真实 1-recipient canary；完整批量仍待验证
- `4:45` 收尾：每条业务有处置；有 trace 追原 trace，没有就锁单核查

完整的人话技术解释见 [`final-tech-explainer-cn.md`](final-tech-explainer-cn.md)。

## 主 Demo

Slide 4 → QuickTime 全屏播放 `demo-cn.mp4` → 67 秒结束 → 回到 Slide 5。

## 三句必须说

1. 状态未知不等于失败，UNKNOWN 永远不自动重付。
2. 三笔流程是 fixture；真实证据是一笔独立的 GasFree Nile canary。
3. 私钥留在 TronLink，成功必须同时通过 Provider 和 Nile RPC 核验。
4. GasFree 不等于零费用；它让用户无需另外持有 TRX。

## 三个高频答案

- **为什么不是批量脚本？** 脚本只负责提交；SettleMap 保留业务行身份并恢复原 trace。
- **真的上链了吗？** 一笔单收款人 canary 真实上链；三笔标准流程是 fixture。
- **AI 在哪里？** Vision 只把截图变成草稿；付款规则和授权由确定性代码控制。

## 证据数字

`1.000001 USDT` · fee `1.3 USDT` · block `71389721` · log `2` · tx `…dd586`

## 超时处理

- 落后 20 秒：跳过竞品逐项解释。
- App 故障：播放 67 秒 `demo-cn.mp4`。
- TRONSCAN 故障：读出区块、日志和 tx 结尾，继续收尾。
