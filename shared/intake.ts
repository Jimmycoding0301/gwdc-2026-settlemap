import type { Batch, InputRow, OpsInspection, SettlementPlan } from './types';

export type Column = 'id' | 'invoiceId' | 'payeeId' | 'payeeName' | 'address' | 'token' | 'amount' | 'note';
const aliases: Record<string, Column> = {
  id: 'id', row_id: 'id', invoice: 'invoiceId', invoice_id: 'invoiceId', invoiceid: 'invoiceId', content_id: 'invoiceId', post_id: 'invoiceId',
  payee_id: 'payeeId', payeeid: 'payeeId', creator_id: 'payeeId', payee: 'payeeName', payee_name: 'payeeName', payeename: 'payeeName', creator: 'payeeName', handle: 'payeeName', campaign: 'note',
  address: 'address', wallet: 'address', wallet_address: 'address', tron_address: 'address', token: 'token', currency: 'token', amount: 'amount', note: 'note', memo: 'note',
  业务单号: 'invoiceId', 订单号: 'invoiceId', 发票号: 'invoiceId', 内容编号: 'invoiceId', 活动编号: 'invoiceId', 收款人编号: 'payeeId', 达人编号: 'payeeId', 创作者编号: 'payeeId', 收款人: 'payeeName', 创作者: 'payeeName', 达人: 'payeeName', 姓名: 'payeeName',
  钱包地址: 'address', 地址: 'address', tron地址: 'address', 币种: 'token', 金额: 'amount', 备注: 'note',
};
export const columnFor = (header: string): Column | undefined => aliases[header.trim().toLowerCase().replace(/\s*[（(][^）)]*[）)]/g, '').replaceAll(' ', '_')];
export const localPayeeId = (name: string, index: number) => `imported_${name.trim().toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '_') || index + 1}`;

export function parseTabular(text: string): InputRow[] {
  if (text.length > 1_500_000) throw new Error('表格超过 1.5 MB，请缩小导入范围。');
  const clean = text.replace(/^\uFEFF/, '');
  const delimiter = clean.split(/\r?\n/, 1)[0].includes('\t') ? '\t' : ',';
  const matrix: string[][] = [];
  let row: string[] = [], field = '', quoted = false, closed = false;
  const cell = () => { row.push(field.trim()); field = ''; closed = false; };
  const line = () => { cell(); if (row.some(Boolean)) matrix.push(row); row = []; };
  for (let i = 0; i < clean.length; i++) {
    const char = clean[i];
    if (quoted) {
      if (char === '"' && clean[i + 1] === '"') { field += '"'; i++; }
      else if (char === '"') { quoted = false; closed = true; }
      else field += char;
    } else if (char === delimiter) cell();
    else if (char === '\n' || char === '\r') { if (char === '\r' && clean[i + 1] === '\n') i++; line(); }
    else if (char === '"' && !field && !closed) quoted = true;
    else if (closed || char === '"') throw new Error('表格引号格式不完整，请检查原文。');
    else field += char;
  }
  if (quoted) throw new Error('表格存在未闭合引号。');
  if (field || row.length) line();
  if (matrix.length < 2 || matrix.length > 501) throw new Error('表格需要表头及 1–500 行业务明细。');
  const headers = matrix[0].map(columnFor);
  const known = headers.filter(Boolean);
  if (new Set(known).size !== known.length) throw new Error('表格存在重复含义的列名。');
  if (['invoiceId', 'payeeName', 'address', 'amount'].some(key => !headers.includes(key as Column))) throw new Error('表格至少需要业务单号、收款人、钱包地址和金额列。');
  return matrix.slice(1).map((cells, index) => {
    if (cells.length !== headers.length) throw new Error(`第 ${index + 2} 行列数不一致。`);
    const item: InputRow = { id: `import_${index + 1}`, invoiceId: '', payeeId: '', payeeName: '', address: '', token: 'USDT', amount: '', note: '' };
    headers.forEach((key, position) => { if (key) item[key] = cells[position]; });
    item.id ||= `import_${index + 1}`;
    item.payeeId ||= localPayeeId(item.payeeName, index);
    // Import never grants manual review or starts a payment, even if columns request it.
    return item;
  });
}

export function resolveIntake(text: string, rows: InputRow[]): { kind: 'table'; rows: InputRow[] } | { kind: 'search'; rowIds: string[]; query: string } {
  const query = text.trim();
  if (!query) throw new Error('粘贴表格，或输入地址、业务单号。');
  if (query.includes('\n') && (query.includes('\t') || query.includes(','))) return { kind: 'table', rows: parseTabular(query) };
  const normalized = query.replace(/^#/, '').toLowerCase();
  const matches = rows.filter(row => row.invoiceId.toLowerCase().includes(normalized) || row.address.toLowerCase() === normalized);
  return { kind: 'search', rowIds: matches.map(row => row.id), query };
}

export function exceptionHandoff(rows: InputRow[], plan: SettlementPlan | null, ops: OpsInspection | null, batch: Batch | null): { text: string; count: number } {
  const validation = new Map(plan?.rows.map(row => [row.id, row]));
  const history = new Map(ops?.items.map(row => [row.rowId, row]));
  const items = rows.flatMap(row => {
    const result = validation.get(row.id), operation = history.get(row.id);
    const payment = batch?.payments.find(item => item.rowIds.includes(row.id));
    const reasons = [...(result?.issues.map(issue => issue.message) || [])];
    if (row.deferred && !reasons.length) reasons.push('已暂缓结算');
    if (operation?.historyStatus === 'SETTLED') reasons.push('历史已结算，本批禁止重复支付');
    if (operation?.historyStatus === 'UNRESOLVED') reasons.push('历史付款尚待核查');
    if (operation?.addressStatus === 'CHANGED') reasons.push('地址发生变化，需要人工核址');
    if (payment && ['UNKNOWN', 'PROCESSING', 'FAILED'].includes(payment.status)) reasons.push(`${payment.status}：${payment.failureReason || '需查询原授权状态'}`);
    if (!reasons.length) return [];
    return [`${row.invoiceId || '缺少业务单号'} · ${row.payeeName || '缺少收款人'} · ${row.amount} ${row.token || '币种待确认'}\n地址：${row.address || '待补充'}\n处理项：${[...new Set(reasons)].join('；')}${payment?.requestId ? `\nrequestId：${payment.requestId}` : ''}${payment?.traceId ? `\ntraceId：${payment.traceId}` : ''}${row.reviewNote ? `\n复核备注：${row.reviewNote}` : ''}`];
  });
  return { count: items.length, text: `SettleMap · 异常交接清单\n范围：${batch?.mode === 'live' ? 'GasFree Nile 测试网' : '本地 fixture / 未付款草稿'}\n仅含 ${items.length} 条异常或待核查业务；状态未知不等于付款失败。\n${items.join('\n\n')}${ops ? '' : '\n\n尚未执行本机历史检查。'}` };
}
