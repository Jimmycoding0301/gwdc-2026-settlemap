// Server-side planning. Frontends import types.ts, not node:crypto.
import { createHash, randomUUID } from 'node:crypto';
import type { GasFreePreflight, InputRow, SettlementPlan, ValidatedRow, PaymentPlan } from './types.js';

const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const hash = (value: Uint8Array | string) => createHash('sha256').update(value).digest();
export const SIMULATED_FEE_MICROS = 1_000_000;
export const REVIEW_LIMIT_MICROS = 500_000_000;

export function isTronAddress(address: string): boolean {
  if (typeof address !== 'string' || !/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(address)) return false;
  let value = 0n;
  for (const char of address) value = value * 58n + BigInt(alphabet.indexOf(char));
  const hex = value.toString(16).padStart(50, '0');
  if (hex.length !== 50) return false;
  const bytes = Buffer.from(hex, 'hex');
  return bytes[0] === 0x41 && hash(hash(bytes.subarray(0, 21))).subarray(0, 4).equals(bytes.subarray(21));
}

/** Deterministic valid-format addresses for fixtures only, never live recipients. */
export function fixtureAddress(byte: number): string {
  const payload = Buffer.concat([Buffer.from([0x41]), Buffer.alloc(20, byte)]);
  const bytes = Buffer.concat([payload, hash(hash(payload)).subarray(0, 4)]);
  let value = BigInt(`0x${bytes.toString('hex')}`);
  let result = '';
  while (value > 0n) { result = alphabet[Number(value % 58n)] + result; value /= 58n; }
  return result;
}

export function parseAmount(amount: string): number | undefined {
  if (typeof amount !== 'string' || amount.length > 32 || !/^\d+(?:\.\d{1,6})?$/.test(amount)) return undefined;
  const [whole, fraction = ''] = amount.split('.');
  const micros = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'));
  if (micros <= 0n || micros > BigInt(Number.MAX_SAFE_INTEGER)) return undefined;
  return Number(micros);
}

export function formatAmount(micros: number): string {
  if (!Number.isSafeInteger(micros) || micros < 0) throw new Error('Invalid integer amount.');
  const value = BigInt(micros);
  return `${value / 1_000_000n}.${String(value % 1_000_000n).padStart(6, '0')}`;
}

export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).filter(key => object[key] !== undefined).sort().map(key => `${JSON.stringify(key)}:${canonical(object[key])}`).join(',')}}`;
}

export function planDigest(plan: Omit<SettlementPlan, 'digest'> | SettlementPlan): string {
  const { digest: _digest, ...payload } = plan as SettlementPlan;
  return hash(canonical(payload)).toString('hex');
}

export function buildPlan(input: InputRow[], createdAt = new Date().toISOString(), mode: SettlementPlan['mode'] = 'fixture'): SettlementPlan {
  if (!Array.isArray(input) || input.length === 0 || input.length > 500) throw new Error('Provide 1–500 business rows.');
  const invoiceIds = new Set<string>();
  const rowIds = new Set<string>();
  const rows: ValidatedRow[] = input.map((source, index) => {
    const values = source && typeof source === 'object' ? source : {} as InputRow;
    const row = Object.fromEntries(['id', 'invoiceId', 'payeeId', 'payeeName', 'address', 'token', 'amount', 'note']
      .map(key => { const value = values[key as keyof InputRow]; return [key, typeof value === 'string' ? value.trim() : '']; })) as unknown as InputRow;
    if (values.reviewedOverLimit !== undefined) row.reviewedOverLimit = values.reviewedOverLimit === true;
    if (values.reviewedAddressChange !== undefined) row.reviewedAddressChange = values.reviewedAddressChange === true;
    if (values.deferred !== undefined) row.deferred = values.deferred === true;
    if (values.reviewNote !== undefined) row.reviewNote = typeof values.reviewNote === 'string' ? values.reviewNote.trim() : '';
    const issues: ValidatedRow['issues'] = [];
    if (row.deferred) issues.push({ code: 'DEFERRED', message: '用户已暂缓该业务；保留原始记录，本批次不付款。' });
    if (!row.id || !row.invoiceId || !row.payeeId || !row.payeeName) issues.push({ code: 'MISSING_FIELD', message: '行编号、业务单号、收款人编号及姓名不能为空。' });
    if (rowIds.has(row.id)) issues.push({ code: 'DUPLICATE_ROW', message: '行编号重复，请为每行保留独立编号。' });
    rowIds.add(row.id);
    if (!row.deferred && invoiceIds.has(row.invoiceId)) issues.push({ code: 'DUPLICATE_INVOICE', message: '业务单号重复；后出现的重复行不参与付款。' });
    if (!row.deferred) invoiceIds.add(row.invoiceId);
    if (!isTronAddress(row.address)) issues.push({ code: 'INVALID_ADDRESS', message: 'TRON 地址格式或校验和无效。' });
    if (row.token !== 'USDT') issues.push({ code: 'UNSUPPORTED_TOKEN', message: '本原型只处理 USDT。' });
    const amountMicros = parseAmount(row.amount);
    if (amountMicros === undefined) issues.push({ code: 'INVALID_AMOUNT', message: '金额须为正十进制数，最多 6 位小数。' });
    else if (amountMicros > REVIEW_LIMIT_MICROS && !row.reviewedOverLimit) issues.push({ code: 'ANOMALOUS_AMOUNT', message: '单条业务金额超过 500 USDT，需明确复核、修改或暂缓。' });
    return { ...row, line: index + 1, status: issues.length ? 'INVALID' : 'VALID', amountMicros, issues };
  });
  const groups = new Map<string, PaymentPlan>();
  for (const row of rows) {
    if (row.status !== 'VALID') continue;
    const key = canonical([row.payeeId, row.address, row.token]);
    let payment = groups.get(key);
    if (!payment) {
      payment = { id: `${mode === 'fixture' ? 'sim' : 'live'}_payment_${hash(key).toString('hex').slice(0, 16)}`, payeeId: row.payeeId,
        payeeName: row.payeeName, address: row.address, token: 'USDT', amountMicros: 0,
        feeMicros: mode === 'fixture' ? SIMULATED_FEE_MICROS : 0, rowIds: [], invoiceIds: [] };
      groups.set(key, payment);
    }
    payment.amountMicros += row.amountMicros!;
    if (!Number.isSafeInteger(payment.amountMicros)) throw new Error('Payment total exceeds integer precision.');
    payment.rowIds.push(row.id);
    payment.invoiceIds.push(row.invoiceId);
    row.paymentId = payment.id;
  }
  const payments = [...groups.values()];
  const validRows = rows.filter(row => row.status === 'VALID').length;
  const principalMicros = payments.reduce((sum, payment) => sum + payment.amountMicros, 0);
  const unmergedFeeMicros = mode === 'fixture' ? validRows * SIMULATED_FEE_MICROS : 0;
  const mergedFeeMicros = mode === 'fixture' ? payments.length * SIMULATED_FEE_MICROS : 0;
  if (!Number.isSafeInteger(principalMicros) || !Number.isSafeInteger(principalMicros + mergedFeeMicros)) throw new Error('Settlement total exceeds integer precision.');
  const plan: SettlementPlan = {
    id: `${mode === 'fixture' ? 'sim' : 'live'}_plan_${randomUUID()}`, digest: '', createdAt, mode, rows, payments,
    summary: { inputRows: rows.length, validRows, invalidRows: rows.length - validRows,
      paymentCount: payments.length, principalMicros, unmergedFeeMicros, mergedFeeMicros,
      feeSavingsMicros: unmergedFeeMicros - mergedFeeMicros, totalDebitMicros: principalMicros + mergedFeeMicros,
      reviewedOverLimitRows: rows.filter(row => row.status === 'VALID' && row.reviewedOverLimit && row.amountMicros! > REVIEW_LIMIT_MICROS).length,
      reviewedAddressChangeRows: rows.filter(row => row.status === 'VALID' && row.reviewedAddressChange).length,
      deferredRows: rows.filter(row => row.deferred).length },
    feeNote: mode === 'fixture' ? '演示费率固定为每笔 1 USDT；不含真实激活费用，不代表 GasFree 实时报价。无真实转账。' : '尚未用 GasFree 实时预检数据更新费用；不得确认此中间状态。',
  };
  plan.digest = planDigest(plan);
  return plan;
}

/** Binds a live provider snapshot to the plan before the user confirms it. */
export function applyLivePreflight(plan: SettlementPlan, preflight: GasFreePreflight): SettlementPlan {
  if (plan.mode !== 'live' || preflight.mode !== 'live') throw new Error('Live preflight cannot be applied to a fixture plan.');
  if (preflight.payments.length !== plan.payments.length
    || preflight.payments.some((payment, index) => payment.id !== plan.payments[index].id
      || payment.address !== plan.payments[index].address || payment.amountMicros !== plan.payments[index].amountMicros)) {
    throw new Error('GasFree preflight does not match the settlement plan.');
  }
  const transferFee = preflight.transferFeeMicros;
  const activationFee = preflight.active ? 0 : preflight.activationFeeMicros;
  if (![transferFee, activationFee, preflight.estimatedFeeMicros, preflight.totalDebitMicros].every(Number.isSafeInteger)) {
    throw new Error('GasFree preflight exceeds safe integer precision.');
  }
  plan.payments.forEach((payment, index) => { payment.feeMicros = transferFee + (index === 0 ? activationFee : 0); });
  const mergedFeeMicros = plan.payments.reduce((sum, payment) => sum + payment.feeMicros, 0);
  if (mergedFeeMicros !== preflight.estimatedFeeMicros) throw new Error('GasFree preflight fee total does not match payment fees.');
  const validRows = plan.summary.validRows;
  const unmergedFeeMicros = validRows * transferFee + activationFee;
  const totalDebitMicros = plan.summary.principalMicros + mergedFeeMicros;
  if (!Number.isSafeInteger(unmergedFeeMicros) || !Number.isSafeInteger(totalDebitMicros)
    || totalDebitMicros !== preflight.totalDebitMicros) throw new Error('GasFree preflight total does not match the settlement plan.');
  plan.summary.unmergedFeeMicros = unmergedFeeMicros;
  plan.summary.mergedFeeMicros = mergedFeeMicros;
  plan.summary.feeSavingsMicros = unmergedFeeMicros - mergedFeeMicros;
  plan.summary.totalDebitMicros = totalDebitMicros;
  plan.feeNote = `GasFree Nile ${preflight.selectedProvider.name} 于 ${preflight.checkedAt} 预检：每笔转账费 ${formatAmount(transferFee)} USDT${activationFee ? `，首次激活费 ${formatAmount(activationFee)} USDT` : ''}。费用会变动，每次签名前需重新预检。`;
  plan.digest = planDigest(plan);
  return plan;
}
