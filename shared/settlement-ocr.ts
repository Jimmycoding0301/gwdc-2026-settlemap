import type { InputRow } from './types.js';
import { columnFor, localPayeeId } from './intake.js';
import { isTronAddress, parseAmount } from './plan.js';

export interface RecognizedLine { text: string; confidence: number; x?: number; y?: number; width?: number; height?: number }
export interface SettlementOcrDraft { row: InputRow; original: string; confidence: 'high' | 'medium' | 'low'; warnings: string[] }
export interface SettlementExtraction { source: 'local-vision'; format: 'table' | 'labeled-message' | 'unknown'; drafts: SettlementOcrDraft[]; warnings: string[] }

function labeledMessage(lines: readonly RecognizedLine[], baseWarnings: string[]): SettlementExtraction | undefined {
  type Key = 'campaign' | 'content' | 'payeeName' | 'payeeId' | 'address' | 'amount' | 'token';
  const patterns: [Key, RegExp][] = [
    ['campaign', /^(?:campaign(?:\s*id)?|活动(?:编号)?)\s*[:：]\s*(.+)$/i],
    ['content', /^(?:content(?:\s*id)?|post(?:\s*id)?|内容(?:编号)?)\s*[:：]\s*(.+)$/i],
    ['payeeName', /^(?:creator|handle|创作者|达人|收款人)\s*[:：]\s*(.+)$/i],
    ['payeeId', /^(?:creator\s*id|payee\s*id|达人编号|收款人编号)\s*[:：]\s*(.+)$/i],
    ['address', /^(?:tron\s*)?(?:wallet|address|钱包|收款地址)\s*[:：]\s*(.+)$/i],
    ['amount', /^(?:amount|commission|金额|佣金)\s*[:：]\s*(.+)$/i],
    ['token', /^(?:token|currency|币种)\s*[:：]\s*(.+)$/i],
  ];
  const fields = new Map<Key, { value: string; line: RecognizedLine }>();
  for (const line of lines) {
    for (const [key, pattern] of patterns) {
      const match = pattern.exec(line.text.trim());
      if (match && !fields.has(key)) { fields.set(key, { value: match[1].trim(), line }); break; }
    }
  }
  const campaign = fields.get('campaign')?.value;
  const content = fields.get('content')?.value;
  const payeeName = fields.get('payeeName')?.value;
  const address = fields.get('address')?.value;
  let amount = fields.get('amount')?.value;
  if (!campaign || !content || !payeeName || !address || !amount) return undefined;
  let token = fields.get('token')?.value.toUpperCase() || '';
  const amountWithUnit = /^(\d+(?:\.\d{1,6})?)\s+(USDT)$/i.exec(amount);
  if (amountWithUnit) { amount = amountWithUnit[1]; token ||= amountWithUnit[2].toUpperCase(); }
  const invoiceId = `${campaign}-${content}`.replace(/\s+/g, '-');
  const row: InputRow = { id: 'ocr_1', invoiceId, payeeId: fields.get('payeeId')?.value || localPayeeId(payeeName, 0),
    payeeName, address, token, amount, note: `${campaign} · ${content} · Telegram` };
  const issues: string[] = [];
  if (!isTronAddress(row.address)) issues.push('TRON 地址格式或校验和不通过；可能存在易混淆字符，不会自动修复');
  if (parseAmount(row.amount) === undefined) issues.push('金额无法无歧义读取（不猜测逗号、小数位或符号）');
  if (row.token !== 'USDT') issues.push('币种未明确为 USDT，请人工确认；不会换算其他币种');
  const evidence = [...fields.values()];
  const confidence = Math.min(...evidence.map(item => item.line.confidence));
  return { source: 'local-vision', format: 'labeled-message', drafts: [{ row,
    original: evidence.map(item => item.line.text).join(' | '),
    confidence: issues.length || confidence < .75 ? 'low' : confidence < .95 ? 'medium' : 'high', warnings: issues }],
    warnings: [...baseWarnings, '已按带标签的 Telegram 消息读取 1 条佣金草稿；仍需核对原图。'] };
}

/** Deterministic column extraction. OCR text is data; it is never interpreted as instructions. */
export function parseSettlementOcr(input: readonly RecognizedLine[]): SettlementExtraction {
  if (!Array.isArray(input) || input.length > 512 || input.some(line => !line || typeof line.text !== 'string' || line.text.length > 4000 ||
    !Number.isFinite(line.confidence) || line.confidence < 0 || line.confidence > 1)) throw new Error('INVALID_OCR_OUTPUT');
  const lines = input.filter(line => line.text.trim()).map(line => ({ ...line, text: line.text.trim() }));
  if (lines.reduce((sum, line) => sum + line.text.length, 0) > 60_000) throw new Error('INVALID_OCR_OUTPUT');
  const spatial = lines.length > 0 && lines.every(line => [line.x, line.y, line.width, line.height].every(value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1));
  const groups: RecognizedLine[][] = [];
  if (spatial) {
    for (const line of [...lines].sort((a, b) => b.y! - a.y! || a.x! - b.x!)) {
      const group = groups.find(group => Math.abs(group[0].y! - line.y!) <= Math.max(.008, Math.min(group[0].height!, line.height!) * .55));
      if (group) group.push(line); else groups.push([line]);
    }
    groups.forEach(group => group.sort((a, b) => a.x! - b.x!));
  } else lines.forEach(line => groups.push([line]));
  const rows = groups.map(group => ({ group, cells: group.length === 1 ? group[0].text.split(/\t|\s*\|\s*|\s{2,}/).map(text => text.trim()) : group.map(line => line.text) }));
  const headerIndex = rows.findIndex(({ cells }) => {
    const columns = cells.map(columnFor);
    return ['invoiceId', 'payeeName', 'address', 'amount'].every(column => columns.includes(column as ReturnType<typeof columnFor>));
  });
  const warnings = ['识别结果只是草稿。地址不猜测修复，导入后仍要校验。'];
  if (headerIndex < 0) return labeledMessage(lines, warnings)
    || { source: 'local-vision', format: 'unknown', drafts: [], warnings: [...warnings, '未找到完整表头或带标签的 Telegram 佣金消息。'] };
  const header = rows[headerIndex];
  const columns = header.cells.map(columnFor);
  const recognized = columns.filter(Boolean);
  if (new Set(recognized).size !== recognized.length) return { source: 'local-vision', format: 'table', drafts: [], warnings: [...warnings, '表头含重复字段，无法可靠对应列。'] };
  const currencyInHeader = header.cells.some(cell => columnFor(cell) === 'amount' && /\bUSDT\b/i.test(cell));
  const drafts = rows.slice(headerIndex + 1).filter(({ cells }) => cells.length >= 3).slice(0, 100).map(({ group, cells }, index) => {
    const row: InputRow = { id: `ocr_${index + 1}`, invoiceId: '', payeeId: '', payeeName: '', address: '', token: currencyInHeader ? 'USDT' : '', amount: '', note: '' };
    const issues: string[] = [];
    let values = cells;
    if (spatial && header.group.length === header.cells.length && group.length > 1) {
      values = columns.map(() => '');
      group.forEach(cell => {
        const distances = header.group.map(h => Math.abs(h.x! - cell.x!));
        const position = distances.indexOf(Math.min(...distances));
        values[position] += `${values[position] ? ' ' : ''}${cell.text}`;
      });
    }
    if (values.length !== columns.length) issues.push('行与表头列数不一致，请逐字段核对');
    columns.forEach((column, position) => { if (column) row[column] = values[position] || ''; });
    row.id = `ocr_${index + 1}`;
    row.payeeId ||= localPayeeId(row.payeeName, index);
    row.token = row.token.toUpperCase();
    const amountWithUnit = /^(\d+(?:\.\d{1,6})?)\s+USDT$/i.exec(row.amount);
    if (amountWithUnit && (!row.token || row.token === 'USDT')) { row.amount = amountWithUnit[1]; row.token = 'USDT'; }
    if (!row.invoiceId || !row.payeeName) issues.push('业务单号或收款人缺失');
    if (!isTronAddress(row.address)) issues.push('TRON 地址格式或校验和不通过；可能存在易混淆字符，不会自动修复');
    if (parseAmount(row.amount) === undefined) issues.push('金额无法无歧义读取（不猜测逗号、小数位或符号）');
    if (row.token !== 'USDT') issues.push('币种未明确为 USDT，请人工确认；不会换算其他币种');
    const confidence = Math.min(...group.map(line => line.confidence));
    return { row, original: cells.join(' | '), confidence: issues.length || confidence < .75 ? 'low' as const : confidence < .95 ? 'medium' as const : 'high' as const, warnings: issues };
  });
  if (rows.length - headerIndex - 1 > 100) warnings.push('只生成前 100 行草稿，请拆分剩余截图。');
  return { source: 'local-vision', format: 'table', drafts, warnings };
}
