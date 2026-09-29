import type { Batch, InputRow, OpsInspection, OpsInspectionItem } from '../shared/types.js';

/** Read-only inspection. Partial batches count: a confirmed payment is already settled. */
export function inspectOperations(rows: InputRow[], history: Iterable<Batch>, excludeBatchId?: string): OpsInspection {
  type Prior = { batchId: string; address: string; traceId?: string; at: string; status: 'SETTLED' | 'UNRESOLVED' };
  const invoices = new Map<string, Prior>();
  const payees = new Map<string, Prior>();
  for (const batch of history) {
    if (batch.id === excludeBatchId) continue;
    for (const payment of batch.payments) {
      const settled = payment.status === 'CONFIRMED';
      const unresolved = payment.status === 'UNKNOWN' || payment.status === 'PROCESSING'
        || payment.attempts.some(attempt => attempt.status === 'SUBMITTING' || attempt.status === 'PROCESSING' || attempt.status === 'UNKNOWN');
      if (!settled && !unresolved) continue;
      const prior: Prior = { batchId: batch.id, address: payment.address, traceId: payment.traceId,
        at: payment.confirmedAt || payment.attempts.at(-1)?.startedAt || batch.updatedAt,
        status: settled ? 'SETTLED' : 'UNRESOLVED' };
      for (const invoiceId of payment.invoiceIds) {
        const old = invoices.get(invoiceId.trim());
        if (!old || (prior.status === 'SETTLED' && old.status !== 'SETTLED') || (prior.status === old.status && prior.at > old.at)) invoices.set(invoiceId.trim(), prior);
      }
      const oldPayee = payees.get(payment.payeeId.trim());
      if (settled && (!oldPayee || prior.at > oldPayee.at)) payees.set(payment.payeeId.trim(), prior);
    }
  }
  const newPayees = new Set<string>();
  const items: OpsInspectionItem[] = rows.map(row => {
    const invoice = invoices.get(row.invoiceId.trim());
    const payee = payees.get(row.payeeId.trim());
    if (!payee) newPayees.add(row.payeeId.trim());
    return {
      rowId: row.id, invoiceId: row.invoiceId,
      historyStatus: invoice?.status || 'NEW',
      addressStatus: !payee ? 'NEW' : payee.address === row.address.trim() ? 'MATCH' : 'CHANGED',
      ...(payee ? { previousAddress: payee.address } : {}),
      ...((invoice || payee) ? { previousBatchId: (invoice || payee)!.batchId, traceId: (invoice || payee)!.traceId } : {}),
    };
  });
  return { items, summary: {
    settled: items.filter(item => item.historyStatus === 'SETTLED').length,
    unresolved: items.filter(item => item.historyStatus === 'UNRESOLVED').length,
    addressChanged: items.filter(item => item.addressStatus === 'CHANGED').length,
    newPayees: newPayees.size,
  } };
}
