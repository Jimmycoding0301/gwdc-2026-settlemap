import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Batch } from '../shared/types.js';

export interface FixtureReceipt {
  traceId: string;
  requestId: string;
  paymentId: string;
  address: string;
  token: 'USDT';
  amountMicros: number;
  feeMicros: number;
  status: 'CONFIRMED';
}

export class Store {
  readonly batches = new Map<string, Batch>();
  readonly receipts = new Map<string, FixtureReceipt>();
  private writes: Promise<void> = Promise.resolve();
  constructor(private readonly filename: string) {}

  async initialize() {
    await mkdir(dirname(this.filename), { recursive: true, mode: 0o700 });
    try {
      const data = JSON.parse(await readFile(this.filename, 'utf8')) as { batches: Batch[]; receipts: FixtureReceipt[] };
      if (!Array.isArray(data.batches) || !Array.isArray(data.receipts)) throw new Error('Invalid SettleMap data file.');
      for (const batch of data.batches) {
        const validPrefix = batch.mode === 'fixture' ? batch.id?.startsWith('sim_batch_') : batch.mode === 'live' && batch.id?.startsWith('live_batch_');
        if (!validPrefix || !batch.plan || batch.plan.mode !== batch.mode || !Array.isArray(batch.payments)) throw new Error('Invalid stored batch.');
        if (batch.status === 'RUNNING') {
          batch.status = 'PAUSED';
          batch.error = '服务在执行中重启。请查询原 trace 状态；不会自动重新付款。';
          for (const payment of batch.payments) {
            const attempt = payment.attempts.at(-1);
            if (attempt?.status === 'SUBMITTING') { payment.status = 'UNKNOWN'; attempt.status = 'UNKNOWN'; }
          }
        }
        this.batches.set(batch.id, batch);
      }
      for (const receipt of data.receipts) {
        if (!receipt.traceId?.startsWith('sim_trace_')) throw new Error('Invalid stored fixture receipt.');
        this.receipts.set(receipt.traceId, receipt);
      }
      await this.persist();
    } catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error;
    }
  }

  persist(): Promise<void> {
    const snapshot = JSON.stringify({ batches: [...this.batches.values()], receipts: [...this.receipts.values()] }, null, 2);
    const next = this.writes.then(async () => {
      const temporary = `${this.filename}.tmp`;
      await writeFile(temporary, snapshot, { mode: 0o600 });
      await rename(temporary, this.filename);
    });
    this.writes = next.catch(() => undefined);
    return next;
  }

  async resetFixture() {
    // A future live store must never be cleared through this demo-only operation.
    if ([...this.batches.values()].some(batch => batch.mode !== 'fixture' || !batch.id.startsWith('sim_batch_'))
      || [...this.receipts.values()].some(receipt => !receipt.traceId.startsWith('sim_trace_'))) throw new Error('Non-fixture state cannot be reset.');
    await this.writes;
    const batches = [...this.batches.values()];
    const receipts = [...this.receipts.values()];
    const backupFile = `demo-reset-backup-${Date.now()}-${randomUUID()}.json`;
    await writeFile(join(dirname(this.filename), backupFile), JSON.stringify({ batches, receipts }, null, 2), { mode: 0o600 });
    this.batches.clear(); this.receipts.clear();
    try { await this.persist(); }
    catch (error) {
      for (const batch of batches) this.batches.set(batch.id, batch);
      for (const receipt of receipts) this.receipts.set(receipt.traceId, receipt);
      throw error;
    }
    return { removedBatches: batches.length, removedReceipts: receipts.length, backupFile, mode: 'fixture' as const };
  }
}
