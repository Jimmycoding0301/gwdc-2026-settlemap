import { randomUUID } from 'node:crypto';
import { formatAmount } from './plan.js';
import type { Batch, InputRow } from './types.js';

const fields: (keyof InputRow)[] = ['id', 'invoiceId', 'payeeId', 'payeeName', 'address', 'token', 'amount', 'note', 'reviewedOverLimit', 'deferred', 'reviewedAddressChange', 'reviewNote'];
function cell(value: unknown): string {
  let text = value === undefined || value === null ? '' : String(value);
  // Prevent spreadsheet formula execution when users open exported business data.
  if (/^[\t\r\n ]*[=+\-@]/.test(text) || /^[\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}
const table = (rows: unknown[][]) => '\uFEFF' + rows.map(row => row.map(cell).join(',')).join('\r\n') + '\r\n';

export function inputCsv(rows: InputRow[]): string {
  return table([fields, ...rows.map(row => fields.map(field => row[field]))]);
}

export function importCsv(csv: string): InputRow[] {
  if (typeof csv !== 'string' || csv.length > 1_500_000) throw new Error('CSV input is missing or too large.');
  const text = csv.replace(/^\uFEFF/, '');
  const lines: string[][] = [];
  let line: string[] = [], current = '', quoted = false, closed = false;
  const finishCell = () => { line.push(current); current = ''; closed = false; };
  const finishLine = () => { finishCell(); if (line.some(item => item.trim())) lines.push(line); line = []; };
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') { current += '"'; index++; }
      else if (char === '"') { quoted = false; closed = true; }
      else current += char;
    } else if (char === ',') finishCell();
    else if (char === '\n' || char === '\r') { if (char === '\r' && text[index + 1] === '\n') index++; finishLine(); }
    else if (char === '"' && current.length === 0 && !closed) quoted = true;
    else if (closed || char === '"') throw new Error('Malformed CSV quoting.');
    else current += char;
  }
  if (quoted) throw new Error('CSV contains an unclosed quoted field.');
  if (current || line.length) finishLine();
  const headers = lines.shift()?.map(header => header.trim());
  if (!headers || new Set(headers).size !== headers.length) throw new Error('CSV header is missing or duplicated.');
  const required = fields.filter(field => !['id', 'note', 'reviewedOverLimit', 'deferred', 'reviewedAddressChange', 'reviewNote'].includes(field));
  if (required.some(field => !headers.includes(field))) throw new Error(`CSV requires: ${required.join(', ')}.`);
  if (headers.some(header => !fields.includes(header as keyof InputRow))) throw new Error('CSV contains an unknown column.');
  if (lines.length === 0 || lines.length > 500) throw new Error('Provide 1–500 CSV rows.');
  return lines.map((values, index) => {
    if (values.length !== headers.length) throw new Error(`CSV row ${index + 2} has the wrong number of columns.`);
    const source = Object.fromEntries(headers.map((header, position) => [header, values[position]]));
    const result = Object.fromEntries(fields.filter(field => !['reviewedOverLimit', 'deferred', 'reviewedAddressChange', 'reviewNote'].includes(field))
      .map(field => [field, source[field] ?? (field === 'id' ? `sim_row_${randomUUID()}` : '')])) as unknown as InputRow;
    for (const flag of ['reviewedOverLimit', 'deferred', 'reviewedAddressChange'] as const) {
      if (source[flag]?.trim()) {
        if (!['true', 'false'].includes(source[flag].trim().toLowerCase())) throw new Error(`CSV row ${index + 2} has an invalid ${flag} value; use true or false.`);
        result[flag] = source[flag].trim().toLowerCase() === 'true';
      }
    }
    if (source.reviewNote) result.reviewNote = source.reviewNote;
    return result;
  });
}

export function businessCsv(batch: Batch): string {
  const payments = new Map(batch.payments.map(payment => [payment.id, payment]));
  return table([['rowId', 'invoiceId', 'payeeId', 'payeeName', 'address', 'token', 'businessAmountUSDT', 'validationStatus', 'issues', 'paymentId', 'paymentStatus', 'traceId', 'note', 'reviewedOverLimit', 'deferred', 'reviewedAddressChange', 'reviewNote', 'requestId', 'txHash', 'failureCode', 'failureReason', 'mode', 'manifestHash', 'operationHash', 'chainVerification', 'blockNumber', 'explorerUrl'],
    ...batch.plan.rows.map(row => {
      const payment = row.paymentId ? payments.get(row.paymentId) : undefined;
      return [row.id, row.invoiceId, row.payeeId, row.payeeName, row.address, row.token,
        row.amountMicros === undefined ? row.amount : formatAmount(row.amountMicros), row.status,
        row.issues.map(issue => issue.code).join('|'), row.paymentId, payment?.status ?? (row.deferred ? 'DEFERRED' : 'EXCLUDED'), payment?.traceId, row.note,
        row.reviewedOverLimit ?? false, row.deferred ?? false, row.reviewedAddressChange ?? false, row.reviewNote,
        payment?.requestId ?? payment?.attempts.at(-1)?.requestId, payment?.txHash, payment?.failureCode, payment?.failureReason, batch.mode,
        payment?.manifestHash, payment?.operationHash, payment?.chainVerification?.status,
        payment?.chainVerification?.blockNumber, payment?.chainVerification?.explorerUrl];
    })]);
}

export function paymentsCsv(batch: Batch): string {
  return table([['paymentId', 'payeeId', 'payeeName', 'address', 'token', 'principalUSDT', 'estimatedFeeUSDT', 'actualFeeUSDT', 'status', 'traceId', 'attemptCount', 'invoiceIds', 'mode', 'requestId', 'txHash', 'failureCode', 'failureReason', 'providerState', 'chainState', 'manifestHash', 'operationHash', 'chainVerification', 'blockNumber', 'transferLogIndex', 'explorerUrl'],
    ...batch.payments.map(payment => [payment.id, payment.payeeId, payment.payeeName, payment.address, payment.token,
      formatAmount(payment.amountMicros), formatAmount(payment.feeMicros),
      payment.actualFeeMicros === undefined ? '' : formatAmount(payment.actualFeeMicros), payment.status,
      payment.traceId, payment.attempts.length, payment.invoiceIds.join('|'), batch.mode,
      payment.requestId ?? payment.attempts.at(-1)?.requestId, payment.txHash, payment.failureCode, payment.failureReason, payment.providerState, payment.chainState,
      payment.manifestHash, payment.operationHash, payment.chainVerification?.status, payment.chainVerification?.blockNumber,
      payment.chainVerification?.transferLogIndex, payment.chainVerification?.explorerUrl])]);
}
