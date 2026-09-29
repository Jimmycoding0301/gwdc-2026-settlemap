import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { buildPlan, fixtureAddress, isTronAddress, parseAmount, planDigest } from '../shared/plan.js';
import { sampleRows } from '../shared/sample.js';
import { businessCsv, importCsv, inputCsv, paymentsCsv } from '../shared/csv.js';
import { readConfig } from '../server/config.js';
import { Store } from '../server/store.js';
import { SettlementService } from '../server/service.js';
import { createApp } from '../server/app.js';
import { reconciliationArchive } from '../server/archive.js';

const directories: string[] = [];
const config = readConfig({});
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'settlemap-test-')); directories.push(directory);
  const filename = join(directory, 'state.json');
  const store = new Store(filename); await store.initialize();
  return { filename, store, service: new SettlementService(store, config) };
}
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

describe('business validation and payment planning', () => {
  it('validates twelve sample rows, excludes three issues and merges nine rows into three payments', () => {
    const plan = buildPlan(sampleRows());
    expect(plan.summary).toEqual({ inputRows: 12, validRows: 9, invalidRows: 3, paymentCount: 3,
      principalMicros: 235_000_000, unmergedFeeMicros: 9_000_000, mergedFeeMicros: 3_000_000,
      feeSavingsMicros: 6_000_000, totalDebitMicros: 238_000_000, reviewedOverLimitRows: 0, reviewedAddressChangeRows: 0, deferredRows: 0 });
    expect(plan.rows.filter(row => row.status === 'INVALID').map(row => row.issues[0].code))
      .toEqual(['INVALID_ADDRESS', 'DUPLICATE_INVOICE', 'ANOMALOUS_AMOUNT']);
    expect(plan.payments.map(payment => payment.rowIds.length)).toEqual([3, 3, 3]);
    expect(plan.rows.filter(row => row.status === 'INVALID').every(row => row.paymentId === undefined)).toBe(true);
  });

  it('checks address checksums and groups only matching payee, address and token', () => {
    expect(isTronAddress('T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb')).toBe(true);
    const address = fixtureAddress(9);
    expect(isTronAddress(address)).toBe(true);
    expect(isTronAddress(`${address.slice(0, -1)}${address.endsWith('1') ? '2' : '1'}`)).toBe(false);
    const rows = sampleRows().slice(0, 3);
    rows[1].payeeId = 'sim_another_payee';
    rows[2].address = fixtureAddress(4);
    expect(buildPlan(rows).payments).toHaveLength(3);
    rows[1].token = 'OTHER';
    expect(buildPlan(rows).summary.validRows).toBe(2);
  });

  it('preserves micro-unit precision and rejects ambiguous or unsafe amounts', () => {
    expect(parseAmount('0.000001')).toBe(1);
    expect(parseAmount('1.000001')).toBe(1_000_001);
    for (const invalid of ['0', '-1', '1e2', '.2', '1.0000001', '9007199254740992', 'NaN', 'Infinity']) expect(parseAmount(invalid)).toBeUndefined();
    const row = sampleRows()[0];
    expect(buildPlan([{ ...row, amount: '500' }]).summary.validRows).toBe(1);
    expect(buildPlan([{ ...row, amount: '500.000001' }]).summary.validRows).toBe(0);
  });

  it('round-trips quoted CSV fields and refuses malformed input', () => {
    const rows = sampleRows(); rows[0].note = '稿件, "内容"\n第二行';
    expect(importCsv(inputCsv(rows))).toEqual(rows);
    expect(() => importCsv('invoiceId,invoiceId\na,b')).toThrow();
    expect(() => importCsv(inputCsv(rows) + '"unterminated')).toThrow();
  });

  it('requires explicit over-limit review, preserves deferral, and binds both to the plan digest', () => {
    const row = { ...sampleRows()[0], amount: '650' };
    expect(buildPlan([row]).summary.validRows).toBe(0);
    const reviewed = buildPlan([{ ...row, reviewedOverLimit: true, reviewNote: 'Contract and amount checked by operator.' }]);
    expect(reviewed.summary).toMatchObject({ validRows: 1, reviewedOverLimitRows: 1, principalMicros: 650_000_000 });
    expect(reviewed.rows[0].reviewNote).toContain('checked');
    const original = reviewed.digest;
    reviewed.rows[0].reviewedOverLimit = false;
    expect(planDigest(reviewed)).not.toBe(original);
    const deferred = buildPlan([{ ...row, reviewedOverLimit: true, deferred: true, reviewNote: 'Pay next month.' }]);
    expect(deferred.summary).toMatchObject({ validRows: 0, deferredRows: 1, paymentCount: 0 });
    expect(deferred.rows[0].issues[0].code).toBe('DEFERRED');
    const data = [{ ...row, reviewedOverLimit: true, reviewedAddressChange: true, deferred: false, reviewNote: '650 verified' }];
    expect(importCsv(inputCsv(data))).toEqual(data);
    expect(() => importCsv(inputCsv(data).replace(',true,false,', ',perhaps,false,'))).toThrow(/reviewedOverLimit/);
    expect(() => buildPlan([{ ...row, amount: '9007199254.740991', reviewedOverLimit: true }])).toThrow(/integer precision/);
  });
});

describe('serialized fixture settlement', () => {
  it('binds confirmation to the exact plan and rejects both stale digests and changed payment parameters', async () => {
    const { service, store } = await setup();
    const batch = await service.create(sampleRows());
    await expect(service.run(batch.id)).rejects.toMatchObject({ code: 'INVALID_STATE' });
    await expect(service.confirm(batch.id, '0'.repeat(64))).rejects.toMatchObject({ code: 'DIGEST_MISMATCH' });
    await service.confirm(batch.id, batch.planDigest);
    store.batches.get(batch.id)!.payments[0].address = fixtureAddress(8);
    await expect(service.run(batch.id)).rejects.toMatchObject({ code: 'PAYMENT_PLAN_CHANGED' });
    expect(service.get(batch.id).payments.every(payment => payment.attempts.length === 0)).toBe(true);
  });

  it('pauses after response loss, rejects double execution and leaves the third payment queued', async () => {
    const { service } = await setup();
    const batch = await service.create(sampleRows()); await service.confirm(batch.id, batch.planDigest);
    const runs = await Promise.allSettled([service.run(batch.id), service.run(batch.id)]);
    expect(runs.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(runs.filter(result => result.status === 'rejected')).toHaveLength(1);
    const paused = service.get(batch.id);
    expect(paused.status).toBe('PAUSED');
    expect(paused.payments.map(payment => payment.status)).toEqual(['CONFIRMED', 'UNKNOWN', 'QUEUED']);
    expect(paused.payments.map(payment => payment.attempts.length)).toEqual([1, 1, 0]);
    expect(paused.payments.slice(0, 2).every(payment => payment.traceId!.startsWith('sim_trace_'))).toBe(true);
    expect(JSON.stringify(paused)).not.toContain('txHash');
    await expect(service.run(batch.id)).rejects.toMatchObject({ code: 'INVALID_STATE' });
    expect(service.get(batch.id).payments.map(payment => payment.attempts.length)).toEqual([1, 1, 0]);
  });

  it('recovers the original trace after restart without another attempt, then finishes the third payment', async () => {
    const { service, filename } = await setup();
    const batch = await service.create(sampleRows()); await service.confirm(batch.id, batch.planDigest);
    const paused = await service.run(batch.id);
    const original = paused.payments[1].attempts[0];
    const restartedStore = new Store(filename); await restartedStore.initialize();
    const restarted = new SettlementService(restartedStore, config);
    const completed = await restarted.recover(batch.id);
    expect(completed.status).toBe('COMPLETED');
    expect(completed.payments.map(payment => payment.status)).toEqual(['CONFIRMED', 'CONFIRMED', 'CONFIRMED']);
    expect(completed.payments.map(payment => payment.attempts.length)).toEqual([1, 1, 1]);
    expect(completed.payments[1].attempts[0]).toMatchObject({ id: original.id, traceId: original.traceId, requestId: original.requestId, queries: 1 });
    expect(await restarted.recover(batch.id)).toEqual(completed);
    expect(await restarted.run(batch.id)).toEqual(completed);
  });

  it('does not bypass an unknown account outcome by starting a different batch', async () => {
    const { service } = await setup();
    const first = await service.create(sampleRows()); await service.confirm(first.id, first.planDigest);
    await service.run(first.id);
    const second = await service.create(sampleRows().map(row => ({ ...row, invoiceId: `next-${row.invoiceId}` }))); await service.confirm(second.id, second.planDigest);
    await expect(service.run(second.id)).rejects.toMatchObject({ code: 'ACCOUNT_UNRESOLVED' });
    expect(service.get(second.id).payments.every(payment => payment.attempts.length === 0)).toBe(true);
    await service.recover(first.id);
    expect((await service.run(second.id)).status).toBe('PAUSED');
  });

  it('keeps UNKNOWN and does not advance when the queried receipt is missing or mismatched', async () => {
    const { service, store } = await setup();
    const batch = await service.create(sampleRows()); await service.confirm(batch.id, batch.planDigest);
    const paused = await service.run(batch.id);
    const traceId = paused.payments[1].traceId!;
    const receipt = store.receipts.get(traceId)!;
    receipt.amountMicros += 1;
    await expect(service.recover(batch.id)).rejects.toMatchObject({ code: 'RECEIPT_MISMATCH' });
    store.receipts.delete(traceId);
    await expect(service.recover(batch.id)).rejects.toMatchObject({ code: 'STILL_UNKNOWN' });
    expect(service.get(batch.id).payments.map(payment => payment.attempts.length)).toEqual([1, 1, 0]);
    expect(service.get(batch.id).payments[1].status).toBe('UNKNOWN');
  });

  it('exports all original business mappings while charging each confirmed payment fee once', async () => {
    const { service } = await setup();
    const rows = sampleRows(); rows[0].note = '=HYPERLINK("malicious")';
    const batch = await service.create(rows); await service.confirm(batch.id, batch.planDigest);
    await service.run(batch.id); const completed = await service.recover(batch.id);
    const business = businessCsv(completed), payments = paymentsCsv(completed);
    expect(business.trim().split('\r\n')).toHaveLength(13);
    expect(payments.trim().split('\r\n')).toHaveLength(4);
    expect(business.split('\r\n')[0]).not.toContain('Fee');
    expect(business).toContain("'=HYPERLINK");
    expect(completed.payments.reduce((sum, payment) => sum + payment.actualFeeMicros!, 0)).toBe(3_000_000);
    for (const row of completed.plan.rows.filter(row => row.status === 'VALID')) {
      expect(completed.payments.find(payment => payment.id === row.paymentId)?.rowIds).toContain(row.id);
    }
  });

  it('never falls back to fixture when live is requested', async () => {
    const { store, service } = await setup();
    await expect(service.create(sampleRows(), 'live')).rejects.toMatchObject({ code: 'LIVE_NOT_CONFIGURED', status: 409 });
    const configured = new SettlementService(store, readConfig({ GASFREE_API_KEY: 'fake-key', GASFREE_API_SECRET: 'fake-secret' }));
    await expect(configured.create(sampleRows(), 'live', fixtureAddress(7))).rejects.toMatchObject({ code: 'LIVE_NOT_CONFIGURED', status: 409 });
    expect(store.batches.size).toBe(0);
  });

  it('inspects partial history, flags changed addresses and blocks already-paid or unresolved invoices', async () => {
    const { service } = await setup();
    const rows = sampleRows().slice(0, 9);
    expect(service.inspect(rows).summary).toEqual({ settled: 0, unresolved: 0, addressChanged: 0, newPayees: 3 });
    const batch = await service.create(rows); await service.confirm(batch.id, batch.planDigest);
    await service.run(batch.id);
    const partial = service.inspect(rows);
    expect(partial.summary).toEqual({ settled: 3, unresolved: 3, addressChanged: 0, newPayees: 2 });
    expect(partial.items[0]).toMatchObject({ historyStatus: 'SETTLED', addressStatus: 'MATCH', previousBatchId: batch.id });
    expect(partial.items[3].historyStatus).toBe('UNRESOLVED');
    await expect(service.create(rows)).rejects.toMatchObject({ code: 'HISTORICAL_INVOICE_CONFLICT' });
    await service.recover(batch.id);
    const changed = service.inspect([{ ...rows[0], invoiceId: 'brand-new-invoice', address: fixtureAddress(8) }]);
    expect(changed.items[0]).toMatchObject({ historyStatus: 'NEW', addressStatus: 'CHANGED', previousAddress: rows[0].address, previousBatchId: batch.id });
    expect(service.inspect(rows, batch.id).summary.settled).toBe(0);
    const deferred = await service.create([...rows.map(row => ({ ...row, deferred: true, reviewNote: 'Already settled.' })), { ...rows[0], id: 'sim_new_row', invoiceId: 'brand-new-invoice' }]);
    expect(deferred.plan.summary).toMatchObject({ deferredRows: 9, validRows: 1, paymentCount: 1 });
  });

  it('rechecks historical conflicts at execution so a previously confirmed draft cannot double-pay later', async () => {
    const { service } = await setup();
    const rows = sampleRows().slice(0, 3);
    const first = await service.create(rows), second = await service.create(rows);
    await service.confirm(first.id, first.planDigest); await service.confirm(second.id, second.planDigest);
    expect((await service.run(first.id)).status).toBe('COMPLETED');
    await expect(service.run(second.id)).rejects.toMatchObject({ code: 'HISTORICAL_INVOICE_CONFLICT' });
    expect(service.get(second.id).payments[0].attempts).toHaveLength(0);
  });

  it('blocks unreviewed changed addresses at create, confirm and run while retaining the warning after review', async () => {
    const { service } = await setup();
    const original = sampleRows()[0];
    const changed = { ...original, address: fixtureAddress(8), invoiceId: 'sim_invoice_changed' };
    // These drafts precede address history, so initially both addresses are NEW.
    const waiting = await service.create([changed]);
    const confirmed = await service.create([{ ...changed, invoiceId: 'sim_invoice_changed_confirmed' }]);
    await service.confirm(confirmed.id, confirmed.planDigest);
    const history = await service.create([original]); await service.confirm(history.id, history.planDigest); await service.run(history.id);
    await expect(service.create([changed])).rejects.toMatchObject({ status: 409, code: 'ADDRESS_CHANGE_UNREVIEWED' });
    await expect(service.confirm(waiting.id, waiting.planDigest)).rejects.toMatchObject({ code: 'ADDRESS_CHANGE_UNREVIEWED' });
    await expect(service.confirm(confirmed.id, confirmed.planDigest)).rejects.toMatchObject({ code: 'ADDRESS_CHANGE_UNREVIEWED' });
    await expect(service.run(confirmed.id)).rejects.toMatchObject({ code: 'ADDRESS_CHANGE_UNREVIEWED' });
    expect(service.get(confirmed.id).payments[0].attempts).toHaveLength(0);
    const reviewedRow = { ...changed, reviewedAddressChange: true, reviewNote: 'Recipient change reviewed; ownership not independently proven.' };
    expect(service.inspect([reviewedRow]).items[0].addressStatus).toBe('CHANGED');
    const reviewed = await service.create([reviewedRow]);
    expect(reviewed.plan.summary.reviewedAddressChangeRows).toBe(1);
    const before = reviewed.plan.digest;
    const edited = structuredClone(reviewed.plan); edited.rows[0].reviewedAddressChange = false;
    expect(planDigest(edited)).not.toBe(before);
    expect(businessCsv(reviewed)).toContain('reviewedAddressChange');
    expect(businessCsv(reviewed)).toContain(reviewedRow.reviewNote);
    await service.confirm(reviewed.id, reviewed.planDigest);
    expect((await service.run(reviewed.id)).status).toBe('COMPLETED');
    // A changed address can also be explicitly deferred; it is retained but never paid.
    const deferred = await service.create([{ ...original, invoiceId: 'sim_deferred_address', deferred: true }]);
    expect(deferred.payments).toHaveLength(0);
    expect(deferred.plan.rows[0].issues.some(issue => issue.code === 'DEFERRED')).toBe(true);
  });

  it('resets only fixture history with a recoverable backup and refuses any future live state', async () => {
    const { service, store, filename } = await setup();
    const batch = await service.create(sampleRows()); await service.confirm(batch.id, batch.planDigest);
    const running = service.run(batch.id);
    await expect(service.resetDemo()).rejects.toMatchObject({ code: 'EXECUTION_BUSY' });
    await running;
    const reset = await service.resetDemo();
    expect(reset).toMatchObject({ mode: 'fixture', removedBatches: 1, removedReceipts: 2 });
    expect(service.list()).toHaveLength(0);
    const backup = JSON.parse(await readFile(join(filename, '..', reset.backupFile), 'utf8'));
    expect(backup.batches[0].status).toBe('PAUSED');
    expect(backup.batches[0].payments[1].attempts).toHaveLength(1);
    const reopened = new Store(filename); await reopened.initialize(); expect(reopened.batches.size).toBe(0);
    const future = structuredClone(batch) as unknown as Record<string, unknown>; future.mode = 'live';
    store.batches.set(batch.id, future as unknown as typeof batch);
    await expect(service.resetDemo()).rejects.toMatchObject({ code: 'RESET_NOT_FIXTURE' });
    expect(store.batches.size).toBe(1);
  });

  it('exports a ZIP containing both CSVs, the reviewed batch and verifiable manifest checksums', async () => {
    const { service } = await setup();
    const rows = sampleRows(); rows[11].reviewedOverLimit = true; rows[11].reviewNote = 'Contract checked.'; rows[9].deferred = true; rows[0].reviewedAddressChange = true;
    const batch = await service.create(rows); await service.confirm(batch.id, batch.planDigest); await service.run(batch.id);
    const completed = await service.recover(batch.id);
    const archive = reconciliationArchive(completed);
    const entries = new Map<string, Buffer>();
    let cursor = 0;
    while (archive.readUInt32LE(cursor) === 0x04034b50) {
      const size = archive.readUInt32LE(cursor + 18), nameLength = archive.readUInt16LE(cursor + 26), extraLength = archive.readUInt16LE(cursor + 28);
      const name = archive.subarray(cursor + 30, cursor + 30 + nameLength).toString('utf8');
      const start = cursor + 30 + nameLength + extraLength;
      entries.set(name, archive.subarray(start, start + size)); cursor = start + size;
    }
    expect(archive.readUInt32LE(cursor)).toBe(0x02014b50);
    expect(archive.readUInt32LE(archive.length - 22)).toBe(0x06054b50);
    expect([...entries.keys()]).toEqual(['business.csv', 'payments.csv', 'batch.json', 'manifest.json']);
    const manifest = JSON.parse(entries.get('manifest.json')!.toString('utf8'));
    expect(manifest.summary).toMatchObject({ reviewedOverLimitRows: 1, reviewedAddressChangeRows: 1, deferredRows: 1 });
    expect(manifest.notes.join(' ')).toContain('does not prove ownership');
    for (const file of manifest.files) {
      expect(entries.get(file.name)!.length).toBe(file.bytes);
      expect(createHash('sha256').update(entries.get(file.name)!).digest('hex')).toBe(file.sha256);
    }
    expect(entries.get('business.csv')!.toString('utf8')).toContain('Contract checked.');
    expect(entries.get('business.csv')!.toString('utf8')).toContain('DEFERRED');
    expect(JSON.parse(entries.get('batch.json')!.toString('utf8')).planDigest).toBe(completed.planDigest);
  });

  it('serves the complete API flow and excludes secret values from health', async () => {
    const { service } = await setup();
    const app = createApp(service, readConfig({ GASFREE_API_KEY: 'never-expose-this-key', GASFREE_API_SECRET: 'never-expose-this-secret' }));
    const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('No test address.');
    const request = async (path: string, body?: unknown, raw = false) => {
      return new Promise<any>((resolve, reject) => {
        const outgoing = httpRequest(`http://127.0.0.1:${address.port}/api${path}`, {
          method: body === undefined ? 'GET' : 'POST', headers: { Host: '127.0.0.1:8788', 'Content-Type': 'application/json' },
        }, response => {
          const chunks: Buffer[] = [];
          response.on('data', chunk => { chunks.push(Buffer.from(chunk)); });
          response.on('end', () => {
            try {
              const content = Buffer.concat(chunks);
              if (raw) { resolve({ status: response.statusCode, headers: response.headers, content }); return; }
              expect(response.statusCode).toBeGreaterThanOrEqual(200); expect(response.statusCode).toBeLessThan(300); resolve(JSON.parse(content.toString('utf8')));
            }
            catch (error) { reject(error); }
          });
        });
        outgoing.on('error', reject); outgoing.end(body === undefined ? undefined : JSON.stringify(body));
      });
    };
    try {
      const status = await request('/health'); expect(status.liveConfigured).toBe(true); expect(JSON.stringify(status)).not.toContain('never-expose');
      const sample = await request('/sample');
      const badReview = await request('/preview', { rows: [{ ...sample.rows[0], reviewedAddressChange: 'true' }] }, true);
      expect(badReview.status).toBe(400);
      const addressReviewed = await request('/preview', { rows: [{ ...sample.rows[0], reviewedAddressChange: true }] });
      expect(addressReviewed.summary.reviewedAddressChangeRows).toBe(1);
      const preview = await request('/preview', { rows: sample.rows }); expect(preview.summary.paymentCount).toBe(3);
      const batch = await request('/batches', { rows: sample.rows });
      await request(`/batches/${batch.id}/confirm`, { planDigest: batch.planDigest });
      expect((await request(`/batches/${batch.id}/run`, {})).status).toBe('PAUSED');
      expect((await request(`/batches/${batch.id}/recover`, {})).status).toBe('COMPLETED');
      const inspection = await request('/ops/inspect', { rows: sample.rows.slice(0, 9) });
      expect(inspection.summary.settled).toBe(9);
      const duplicate = await request('/batches', { rows: sample.rows }, true);
      expect(duplicate.status).toBe(409); expect(JSON.parse(duplicate.content.toString()).code).toBe('HISTORICAL_INVOICE_CONFLICT');
      const archive = await request(`/batches/${batch.id}/export/package.zip`, undefined, true);
      expect(archive.status).toBe(200); expect(archive.headers['content-type']).toContain('application/zip');
      expect(archive.content.readUInt32LE(0)).toBe(0x04034b50);
      expect((await request('/demo/reset', {}, true)).status).toBe(400);
      expect((await request('/batches')).length).toBe(1);
      const reset = await request('/demo/reset', { confirm: 'RESET_FIXTURE_HISTORY' }); expect(reset.removedBatches).toBe(1);
      expect(await request('/batches')).toEqual([]);
      const invalidHost = await fetch(`http://127.0.0.1:${address.port}/api/health`); expect(invalidHost.status).toBe(403);
    } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  });
});
