import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fixtureAddress } from '../shared/plan.js';
import { sampleRows } from '../shared/sample.js';
import type { GasFreeAuthorization, GasFreePreflight, GasFreeTransferResult } from '../shared/types.js';
import { paymentsCsv } from '../shared/csv.js';
import { readConfig } from '../server/config.js';
import type { GasFreeAdapter } from '../server/integration/index.js';
import { SettlementService } from '../server/service.js';
import { Store } from '../server/store.js';
import { operationHash } from '../server/evidence.js';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

function adapterFixture() {
  const payer = fixtureAddress(7), gasFreeAddress = fixtureAddress(8), token = fixtureAddress(9), provider = fixtureAddress(10);
  let lastPreflight: GasFreePreflight | undefined;
  const preflight = vi.fn(async (input: { payerAddress: string; payments: { id: string; address: string; amountMicros: number }[] }) => {
    const principalMicros = input.payments.reduce((sum, payment) => sum + payment.amountMicros, 0);
    const result: GasFreePreflight = { mode: 'live', network: 'nile', chainId: 3448148188, checkedAt: new Date().toISOString(), payerAddress: input.payerAddress,
      gasFreeAddress, active: false, nonce: '0', allowSubmit: true,
      supportedTokens: [{ tokenAddress: token, symbol: 'USDT', decimal: 6, supported: true, activateFee: '10000000', transferFee: '1000000' }],
      providers: [{ address: provider, name: 'Provider-1', config: { maxPendingTransfer: 1, minDeadlineDuration: 60, maxDeadlineDuration: 600, defaultDeadlineDuration: 180 } }],
      selectedToken: { tokenAddress: token, symbol: 'USDT', decimal: 6, supported: true, activateFee: '10000000', transferFee: '1000000' },
      selectedProvider: { address: provider, name: 'Provider-1', config: { maxPendingTransfer: 1, minDeadlineDuration: 60, maxDeadlineDuration: 600, defaultDeadlineDuration: 180 } },
      balanceMicros: '1000000000', frozenMicros: '0', availableMicros: '1000000000', principalMicros,
      activationFeeMicros: 10_000_000, transferFeeMicros: 1_000_000,
      estimatedFeeMicros: 10_000_000 + input.payments.length * 1_000_000,
      totalDebitMicros: principalMicros + 10_000_000 + input.payments.length * 1_000_000,
      sufficientBalance: true, ready: true, blockers: [], payments: structuredClone(input.payments) };
    lastPreflight = result; return result;
  });
  const prepareAuthorization = vi.fn((check: GasFreePreflight, payment: { id: string; address: string; amountMicros: number }, options?: { manifestHash?: string }): GasFreeAuthorization => {
    const manifestHash = options?.manifestHash;
    const maxFee = String(payment.amountMicros), deadline = String(Math.floor(Date.now() / 1000) + 180);
    return { id: '11111111-1111-4111-8111-111111111111', requestId: '22222222-2222-4222-8222-222222222222', paymentId: payment.id,
      network: 'nile', gasFreeAddress, createdAt: new Date().toISOString(), digest: 'd'.repeat(64), manifestHash,
      operationHash: manifestHash ? operationHash(manifestHash, payment, { token, user: payer, gasFreeAddress,
        serviceProvider: provider, maxFee, deadline, version: '1', nonce: check.nonce }) : undefined,
      typedData: { domain: { name: 'GasFreeController', version: 'V1.0.0', chainId: 3448148188, verifyingContract: fixtureAddress(11) },
        types: { PermitTransfer: [] }, message: { token, serviceProvider: provider, user: payer, receiver: payment.address,
          value: String(payment.amountMicros), maxFee, deadline, version: '1', nonce: check.nonce } } };
  });
  const submitSigned = vi.fn(async (authorization: GasFreeAuthorization): Promise<GasFreeTransferResult> => ({ mode: 'live', network: 'nile',
    requestId: authorization.requestId, traceId: '33333333-3333-4333-8333-333333333333', status: 'PROCESSING', checkedAt: new Date().toISOString(),
    providerState: 'INPROGRESS', chainState: 'NOT_ON_CHAIN', verificationSource: 'gasfree-provider', retryAction: 'QUERY_ORIGINAL' }));
  const recover = vi.fn(async (authorization: GasFreeAuthorization, previous: GasFreeTransferResult): Promise<GasFreeTransferResult> => ({ ...previous,
    requestId: authorization.requestId, status: 'CONFIRMED', checkedAt: new Date().toISOString(), providerState: 'SUCCEED', chainState: 'SOLIDITY',
    txHash: 'ab'.repeat(32), actualFeeMicros: 9_000_000, actualAmountMicros: Number(authorization.typedData.message.value), retryAction: 'NONE',
    verificationSource: 'gasfree-provider+nile-solidity-rpc', chainVerification: { network: 'nile', source: 'nile-solidity-rpc', status: 'VERIFIED',
      checkedAt: new Date().toISOString(), txHash: 'ab'.repeat(32), explorerUrl: `https://nile.tronscan.org/#/transaction/${'ab'.repeat(32)}`,
      tokenAddress: String(authorization.typedData.message.token), fromAddress: authorization.gasFreeAddress,
      receiverAddress: String(authorization.typedData.message.receiver), amountMicros: String(authorization.typedData.message.value),
      manifestHash: authorization.manifestHash, operationHash: authorization.operationHash, blockNumber: 12_345, blockTimestamp: Date.now(),
      transferLogIndex: 0, message: 'verified' } }));
  return { payer, get lastPreflight() { return lastPreflight; }, adapter: { preflight, prepareAuthorization, submitSigned, recover,
    query: vi.fn() } as unknown as GasFreeAdapter, spies: { preflight, prepareAuthorization, submitSigned, recover } };
}

describe('live GasFree batch orchestration', () => {
  it('binds real preflight fees, stores the server authorization, then queries the original trace through confirmation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'settlemap-live-')); directories.push(directory);
    const store = new Store(join(directory, 'state.json')); await store.initialize();
    const fixture = adapterFixture();
    const config = readConfig({ GASFREE_API_KEY: 'key', GASFREE_API_SECRET: 'secret', ENABLE_GASFREE_LIVE: 'true' });
    const service = new SettlementService(store, config, fixture.adapter);
    const created = await service.create(sampleRows().slice(0, 3), 'live', fixture.payer);
    expect(created).toMatchObject({ mode: 'live', status: 'DRAFT', payerAddress: fixture.payer });
    const sameInputs = await service.create(sampleRows().slice(0, 3), 'live', fixture.payer);
    expect(sameInputs.id).not.toBe(created.id);
    expect(sameInputs.manifestHash).toBe(created.manifestHash);
    expect(created.settlementManifest).not.toHaveProperty('createdAt');
    expect(created.payments[0].manifestHash).toBe(created.manifestHash);
    expect(created.plan.summary).toMatchObject({ paymentCount: 1, mergedFeeMicros: 11_000_000 });
    await service.confirm(created.id, created.planDigest);
    const prepared = await service.prepareLive(created.id);
    expect(prepared.authorization).toMatchObject({ paymentId: created.payments[0].id, requestId: '22222222-2222-4222-8222-222222222222' });
    expect(prepared.authorization.manifestHash).toBe(created.manifestHash);
    expect(prepared.authorization.operationHash).toMatch(/^[a-f0-9]{64}$/);
    expect(prepared.batch.payments[0].attempts).toHaveLength(1);
    const processing = await service.submitLive(created.id, created.payments[0].id, prepared.authorization.requestId, '1'.repeat(130));
    expect(processing).toMatchObject({ status: 'PAUSED', payments: [{ status: 'PROCESSING', traceId: '33333333-3333-4333-8333-333333333333' }] });
    const completed = await service.recover(created.id);
    expect(completed).toMatchObject({ status: 'COMPLETED', payments: [{ status: 'CONFIRMED', txHash: 'ab'.repeat(32), actualFeeMicros: 9_000_000 }] });
    expect(fixture.spies.submitSigned).toHaveBeenCalledTimes(1);
    expect(fixture.spies.recover).toHaveBeenCalledTimes(1);
    expect(paymentsCsv(completed)).toContain('ab'.repeat(32));
  });

  it('pauses after a definite failure so remaining queued payments require an explicit review', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'settlemap-live-failed-')); directories.push(directory);
    const store = new Store(join(directory, 'state.json')); await store.initialize();
    const fixture = adapterFixture();
    fixture.spies.submitSigned.mockResolvedValueOnce({ mode: 'live', network: 'nile',
      requestId: '22222222-2222-4222-8222-222222222222', traceId: '33333333-3333-4333-8333-333333333333',
      status: 'FAILED', checkedAt: new Date().toISOString(), providerState: 'FAILED', chainState: 'NOT_ON_CHAIN',
      verificationSource: 'gasfree-provider', failureCode: 'PROVIDER_FAILED', failureReason: 'provider rejected transfer', retryAction: 'NEW_AUTHORIZATION_REQUIRED' });
    const config = readConfig({ GASFREE_API_KEY: 'key', GASFREE_API_SECRET: 'secret', ENABLE_GASFREE_LIVE: 'true' });
    const service = new SettlementService(store, config, fixture.adapter);
    const created = await service.create(sampleRows(), 'live', fixture.payer);
    expect(created.payments.length).toBeGreaterThan(1);
    await service.confirm(created.id, created.planDigest);
    const prepared = await service.prepareLive(created.id);
    const failed = await service.submitLive(created.id, prepared.authorization.paymentId, prepared.authorization.requestId, '1'.repeat(130));
    expect(failed.status).toBe('PAUSED');
    expect(failed.payments[0]).toMatchObject({ status: 'FAILED', failureCode: 'PROVIDER_FAILED' });
    expect(failed.payments.slice(1).every(payment => payment.status === 'QUEUED')).toBe(true);
  });

  it('never lets two store-wide payments claim the same transaction log', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'settlemap-live-proof-reuse-')); directories.push(directory);
    const store = new Store(join(directory, 'state.json')); await store.initialize();
    const fixture = adapterFixture();
    const config = readConfig({ GASFREE_API_KEY: 'key', GASFREE_API_SECRET: 'secret', ENABLE_GASFREE_LIVE: 'true' });
    const service = new SettlementService(store, config, fixture.adapter);
    const first = await service.create(sampleRows().slice(0, 3), 'live', fixture.payer);
    await service.confirm(first.id, first.planDigest);
    const firstAuthorization = await service.prepareLive(first.id);
    await service.submitLive(first.id, firstAuthorization.authorization.paymentId, firstAuthorization.authorization.requestId, '1'.repeat(130));
    const firstCompleted = await service.recover(first.id);
    expect(firstCompleted.payments[0]).toMatchObject({ status: 'CONFIRMED',
      chainVerification: { status: 'VERIFIED', txHash: 'ab'.repeat(32), transferLogIndex: 0 } });

    const secondRows = [{ ...sampleRows()[3], id: 'proof_reuse_row', invoiceId: 'UNIQUE-PROOF-REUSE',
      payeeId: 'creator_unique', payeeName: 'Unique Creator', address: fixtureAddress(15) }];
    const second = await service.create(secondRows, 'live', fixture.payer);
    await service.confirm(second.id, second.planDigest);
    const secondAuthorization = await service.prepareLive(second.id);
    await service.submitLive(second.id, secondAuthorization.authorization.paymentId, secondAuthorization.authorization.requestId, '2'.repeat(130));
    const blocked = await service.recover(second.id);
    expect(blocked.status).toBe('PAUSED');
    expect(blocked.payments[0]).toMatchObject({ status: 'UNKNOWN', failureCode: 'CHAIN_EVIDENCE_REUSED',
      chainVerification: { status: 'VERIFIED', txHash: 'ab'.repeat(32), transferLogIndex: 0 } });
    expect(blocked.payments[0].failureReason).toContain(first.id);
  });

  it('rechecks invoice history both before wallet authorization and immediately before live submit', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'settlemap-live-history-')); directories.push(directory);
    const store = new Store(join(directory, 'state.json')); await store.initialize();
    const fixture = adapterFixture();
    const config = readConfig({ GASFREE_API_KEY: 'key', GASFREE_API_SECRET: 'secret', ENABLE_GASFREE_LIVE: 'true' });
    const service = new SettlementService(store, config, fixture.adapter);
    const rows = sampleRows().slice(0, 3);
    const first = await service.create(rows, 'live', fixture.payer);
    const notPrepared = await service.create(rows, 'live', fixtureAddress(13));
    await service.confirm(first.id, first.planDigest);
    await service.confirm(notPrepared.id, notPrepared.planDigest);
    const firstAuthorization = await service.prepareLive(first.id);
    await service.submitLive(first.id, firstAuthorization.authorization.paymentId, firstAuthorization.authorization.requestId, '1'.repeat(130));
    await service.recover(first.id);
    await expect(service.prepareLive(notPrepared.id)).rejects.toMatchObject({ code: 'HISTORICAL_INVOICE_CONFLICT' });
    expect(fixture.spies.submitSigned).toHaveBeenCalledTimes(1);

    const secondDirectory = await mkdtemp(join(tmpdir(), 'settlemap-live-submit-history-')); directories.push(secondDirectory);
    const secondStore = new Store(join(secondDirectory, 'state.json')); await secondStore.initialize();
    const secondFixture = adapterFixture();
    const secondService = new SettlementService(secondStore, config, secondFixture.adapter);
    const preparedBatch = await secondService.create(rows, 'live', secondFixture.payer);
    const arrivingConflict = await secondService.create(rows, 'live', fixtureAddress(14));
    await secondService.confirm(preparedBatch.id, preparedBatch.planDigest);
    await secondService.confirm(arrivingConflict.id, arrivingConflict.planDigest);
    const staleAuthorization = await secondService.prepareLive(preparedBatch.id);
    const conflict = secondStore.batches.get(arrivingConflict.id)!;
    conflict.payments[0].status = 'CONFIRMED';
    conflict.payments[0].confirmedAt = new Date().toISOString();
    conflict.status = 'COMPLETED';
    await expect(secondService.submitLive(preparedBatch.id, staleAuthorization.authorization.paymentId, staleAuthorization.authorization.requestId, '2'.repeat(130)))
      .rejects.toMatchObject({ code: 'HISTORICAL_INVOICE_CONFLICT' });
    expect(secondFixture.spies.submitSigned).not.toHaveBeenCalled();
  });
});
