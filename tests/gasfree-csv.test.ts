import { describe, expect, it } from 'vitest';
import { businessCsv, paymentsCsv } from '../shared/csv.js';
import { buildPlan, fixtureAddress } from '../shared/plan.js';
import type { Batch, InputRow } from '../shared/types.js';

function batch(): Batch {
  const row: InputRow = { id: 'business_row_1', invoiceId: 'invoice_a', payeeId: 'vendor_a', payeeName: 'Vendor',
    address: fixtureAddress(1), token: 'USDT', amount: '2.5', note: '' };
  const plan = buildPlan([row, { ...row, id: 'business_row_2', invoiceId: 'invoice_b', amount: '1' }]);
  return { id: 'fixture_for_export_test', createdAt: plan.createdAt, updatedAt: plan.createdAt, mode: 'fixture', status: 'DRAFT',
    plan, planDigest: plan.digest, events: [], payments: plan.payments.map(payment => ({ ...payment, status: 'QUEUED', attempts: [] })) };
}

describe('GasFree reconciliation export identifiers and failure reasons', () => {
  it('keeps all original business rows mapped to one failed payment with real request and trace IDs', () => {
    const value = batch();
    value.mode = 'live';
    Object.assign(value.payments[0], { status: 'FAILED', requestId: '720c3647-4d89-4e30-8d80-071ca4d1c594',
      traceId: '6ab4c27c-f66b-4328-b40f-ffdc6cf1ca60', txHash: 'ab'.repeat(32), failureCode: 'ON_CHAIN_FAILED',
      failureReason: 'Provider reported chain failure', providerState: 'FAILED', chainState: 'ON_CHAIN_FAILED' });
    const businesses = businessCsv(value).split('\r\n');
    expect(businesses[0]).toContain('requestId,txHash,failureCode,failureReason,mode');
    expect(businesses.filter(row => row.includes('invoice_'))).toHaveLength(2);
    expect(businesses[1]).toContain(value.payments[0].id);
    expect(businesses[2]).toContain(value.payments[0].id);
    expect(businesses[1]).toContain('ON_CHAIN_FAILED,Provider reported chain failure,live');
    const exported = paymentsCsv(value);
    expect(exported).toContain('invoice_a|invoice_b');
    expect(exported).toContain('3.500000,1.000000,,FAILED');
    expect(exported).toContain(value.payments[0].txHash);
    expect(exported).toContain('providerState,chainState');
  });
  it('exports empty txHash and actual fee cells for unresolved/fixture records', () => {
    const value = batch();
    const requestId = 'sim_request_1';
    value.payments[0].status = 'UNKNOWN';
    value.payments[0].attempts = [{ id: 'sim_attempt_1', requestId, startedAt: value.createdAt, status: 'UNKNOWN', queries: 0 }];
    const exported = paymentsCsv(value);
    expect(exported).toContain('3.500000,1.000000,,UNKNOWN');
    expect(exported).toContain('fixture,sim_request_1,,,,,');
    expect(exported).not.toContain('undefined');
    expect(exported).not.toContain('CONFIRMED');
  });
  it('continues escaping spreadsheet formulas in failure explanations', () => {
    const value = batch();
    value.payments[0].failureReason = '=HYPERLINK("malicious")';
    expect(paymentsCsv(value)).toContain("'=HYPERLINK");
    expect(businessCsv(value)).toContain("'=HYPERLINK");
  });
});
