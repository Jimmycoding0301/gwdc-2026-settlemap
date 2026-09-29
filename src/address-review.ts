export interface AddressChange {
  index: number;
  before: string;
  after: string;
}

export function addressChanges(previous: string, current: string): AddressChange[] {
  const length = Math.max(previous.length, current.length);
  return Array.from({ length }, (_, index) => ({ index, before: previous[index] || '∅', after: current[index] || '∅' }))
    .filter(change => change.before !== change.after);
}

export function verificationMessage(input: { payeeName: string; invoiceId: string; previousAddress: string; currentAddress: string }): string {
  const changes = addressChanges(input.previousAddress, input.currentAddress)
    .map(change => `#${change.index + 1} ${change.before}→${change.after}`).join(', ') || '无';
  return `【SettleMap 收款地址核验】\n${input.payeeName}，我们处理 ${input.invoiceId} 时发现你的 TRON 收款地址发生变化。\n旧：${input.previousAddress}\n新：${input.currentAddress}\n差异：${changes}\n请在当前原有聊天渠道确认。确认前我们不会付款。\n\n[Wallet verification]\nWe noticed a TRON payout address change for ${input.invoiceId}.\nPrevious: ${input.previousAddress}\nNew: ${input.currentAddress}\nChanged: ${changes}\nPlease confirm in this existing chat. Payment stays paused until confirmed.`;
}
