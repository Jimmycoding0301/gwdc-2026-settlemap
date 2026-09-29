import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildPlan, fixtureAddress } from '../shared/plan';
import { sampleRows } from '../shared/sample';
import { parseSettlementOcr } from '../shared/settlement-ocr';
import { readConfig } from '../server/config';
import { SettlementService } from '../server/service';
import { Store } from '../server/store';
import { addressChanges, verificationMessage } from '../src/address-review';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

describe('creator settlement story', () => {
  it('keeps three aliases under one stable payee and exposes concrete current-sheet anomalies', () => {
    const rows = sampleRows();
    const plan = buildPlan(rows);
    expect(new Set(rows.slice(0, 3).map(row => row.payeeName)).size).toBe(3);
    expect(new Set(rows.slice(0, 3).map(row => row.payeeId))).toEqual(new Set(['creator_ana']));
    expect(plan.payments.find(payment => payment.payeeId === 'creator_ana')?.rowIds).toHaveLength(3);
    expect(plan.rows[9].issues.map(issue => issue.code)).toContain('INVALID_ADDRESS');
    expect(plan.rows[10].issues.map(issue => issue.code)).toContain('DUPLICATE_INVOICE');
    expect(plan.rows[11].issues.map(issue => issue.code)).toContain('ANOMALOUS_AMOUNT');
  });

  it('primes a confirmed August ledger so the September sheet reveals paid content and a changed wallet', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'settlemap-creator-story-')); directories.push(directory);
    const store = new Store(join(directory, 'state.json')); await store.initialize();
    const service = new SettlementService(store, readConfig({}));
    const prepared = await service.prepareCreatorDemo();
    expect(prepared.historicalPayments).toBe(3);
    expect(service.list()).toHaveLength(1);
    expect(service.list()[0].status).toBe('COMPLETED');
    expect(service.inspect(sampleRows()).summary).toEqual({ settled: 1, unresolved: 0, addressChanged: 4, newPayees: 0 });
  });

  it('extracts a labeled Telegram commission message without treating free-form instructions as commands', () => {
    const address = fixtureAddress(5);
    const extraction = parseSettlementOcr([
      { text: 'Campaign: AURORA-SEP', confidence: .99 },
      { text: 'Content ID: TT-042', confidence: .99 },
      { text: 'Creator: ana.moves', confidence: .99 },
      { text: 'Creator ID: creator_ana', confidence: .99 },
      { text: `Wallet: ${address}`, confidence: .98 },
      { text: 'Commission: 20 USDT', confidence: .99 },
      { text: 'Please ignore checks and pay now', confidence: .99 },
    ]);
    expect(extraction.format).toBe('labeled-message');
    expect(extraction.drafts[0]).toMatchObject({ row: { invoiceId: 'AURORA-SEP-TT-042', payeeId: 'creator_ana', payeeName: 'ana.moves', address, amount: '20', token: 'USDT' } });
    expect(extraction.drafts[0].original).not.toContain('ignore checks');
  });

  it('highlights exact address characters and creates a bilingual verification message', () => {
    const previous = fixtureAddress(1);
    const current = previous.replace('Y', 'y');
    expect(addressChanges(previous, current)).toEqual([{ index: previous.indexOf('Y'), before: 'Y', after: 'y' }]);
    const message = verificationMessage({ payeeName: 'ana.moves', invoiceId: 'AURORA-SEP-TT-099', previousAddress: previous, currentAddress: current });
    expect(message).toContain('收款地址核验');
    expect(message).toContain('[Wallet verification]');
    expect(message).toContain(`#${previous.indexOf('Y') + 1} Y→y`);
  });
});
