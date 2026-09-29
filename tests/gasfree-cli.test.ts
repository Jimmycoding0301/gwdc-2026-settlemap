import { chmod, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { TronWeb } from 'tronweb';
import { fixtureAddress } from '../shared/plan.js';
import type { GasFreeAuthorization, GasFreePreflight, GasFreeTransferResult } from '../shared/types.js';
import type { GasFreeAdapter } from '../server/integration/index.js';
import { NILE_CHAIN_ID, NILE_CONTROLLER } from '../server/integration/index.js';
import {
  BROADCAST_CONFIRMATION,
  executeOneShot,
  recoverOneShot,
  signWithPrivateKeyFile,
  type OneShotOptions,
} from '../tools/gasfree-nile-transfer.js';

const payer = fixtureAddress(21);
const receiver = fixtureAddress(22);
const gasFreeAddress = fixtureAddress(23);
const tokenAddress = fixtureAddress(24);
const providerAddress = fixtureAddress(25);
const requestId = '720c3647-4d89-4e30-8d80-071ca4d1c594';
const traceId = '6ab4c27c-f66b-4328-b40f-ffdc6cf1ca60';
const txHash = 'ab'.repeat(32);

function preflight(): GasFreePreflight {
  return {
    mode: 'live', network: 'nile', chainId: NILE_CHAIN_ID, checkedAt: '2026-09-30T00:00:00.000Z',
    payerAddress: payer, gasFreeAddress, active: true, nonce: '7', allowSubmit: true,
    supportedTokens: [{ tokenAddress, symbol: 'USDT', decimal: 6, supported: true, activateFee: '0', transferFee: '100000' }],
    providers: [{ address: providerAddress, name: 'Test provider', config: { maxPendingTransfer: 1,
      minDeadlineDuration: 60, maxDeadlineDuration: 600, defaultDeadlineDuration: 180 } }],
    selectedToken: { tokenAddress, symbol: 'USDT', decimal: 6, supported: true, activateFee: '0', transferFee: '100000' },
    selectedProvider: { address: providerAddress, name: 'Test provider', config: { maxPendingTransfer: 1,
      minDeadlineDuration: 60, maxDeadlineDuration: 600, defaultDeadlineDuration: 180 } },
    balanceMicros: '5000000', frozenMicros: '0', availableMicros: '5000000', principalMicros: 1_000_001,
    activationFeeMicros: 0, transferFeeMicros: 100_000, estimatedFeeMicros: 100_000, totalDebitMicros: 1_100_001,
    sufficientBalance: true, ready: true, blockers: [], payments: [{ id: 'gasfree-cli:test-intent', address: receiver, amountMicros: 1_000_001 }],
  };
}

function authorization(): GasFreeAuthorization {
  const typedData = { domain: { name: 'GasFreeController', version: 'V1.0.0', chainId: NILE_CHAIN_ID, verifyingContract: NILE_CONTROLLER },
    types: { PermitTransfer: [
      { name: 'token', type: 'address' }, { name: 'serviceProvider', type: 'address' }, { name: 'user', type: 'address' },
      { name: 'receiver', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'maxFee', type: 'uint256' },
      { name: 'deadline', type: 'uint256' }, { name: 'version', type: 'uint256' }, { name: 'nonce', type: 'uint256' },
    ] },
    message: { token: tokenAddress, serviceProvider: providerAddress, user: payer, receiver, value: '1000001', maxFee: '100000',
      deadline: '1790736180', version: '1', nonce: '7' } };
  return { id: '4a154f52-d256-4338-846d-6abe9592e302', requestId, paymentId: 'gasfree-cli:test-intent', network: 'nile',
    gasFreeAddress, createdAt: '2026-09-30T00:00:00.000Z', digest: 'cd'.repeat(32), typedData };
}

function result(status: GasFreeTransferResult['status']): GasFreeTransferResult {
  const base: GasFreeTransferResult = { mode: 'live', network: 'nile', requestId, traceId, status,
    checkedAt: '2026-09-30T00:00:01.000Z', providerState: status === 'CONFIRMED' ? 'SUCCEED' : 'INPROGRESS',
    chainState: status === 'CONFIRMED' ? 'SOLIDITY' : 'NOT_ON_CHAIN', verificationSource: 'gasfree-provider', retryAction: 'QUERY_ORIGINAL' };
  if (status !== 'CONFIRMED') return base;
  return { ...base, txHash, actualAmountMicros: 1_000_001, actualFeeMicros: 99_000, retryAction: 'NONE',
    verificationSource: 'gasfree-provider+nile-solidity-rpc', chainVerification: { network: 'nile', source: 'nile-solidity-rpc',
      status: 'VERIFIED', checkedAt: '2026-09-30T00:00:02.000Z', txHash,
      explorerUrl: `https://nile.tronscan.org/#/transaction/${txHash}`, tokenAddress, fromAddress: gasFreeAddress,
      receiverAddress: receiver, amountMicros: '1000001', blockNumber: 123, blockTimestamp: 1_790_736_002_000,
      transferLogIndex: 0, message: 'verified' } };
}

function options(overrides: Partial<OneShotOptions> = {}): OneShotOptions {
  return { payerAddress: payer, receiverAddress: receiver, amountMicros: 1_000_001, intentId: 'test-intent',
    signerKeyFile: '.data/test.key', broadcast: false, pollSeconds: 10, ...overrides };
}

function adapter(submitResult = result('PROCESSING')) {
  const prepareAuthorization = vi.fn(() => authorization());
  const submitSigned = vi.fn(async () => submitResult);
  const recover = vi.fn(async () => result('CONFIRMED'));
  return { value: { preflight: vi.fn(async () => preflight()), prepareAuthorization, submitSigned, recover,
    query: vi.fn() } as unknown as GasFreeAdapter, prepareAuthorization, submitSigned, recover };
}

describe('one-shot GasFree Nile CLI safety', () => {
  it('defaults to read-only preflight and writes only sanitized evidence', async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'settlemap-gasfree-preflight-'));
    const fake = adapter();
    const sign = vi.fn(async () => { throw new Error('must not sign'); });
    const output = await executeOneShot(options(), { adapter: fake.value, signTypedData: sign, dataDir, broadcastPostCount: () => 0 });
    expect(output.exitCode).toBe(0);
    expect(output.evidence).toMatchObject({ mode: 'PREFLIGHT_ONLY', exactTransferVerified: false, broadcastPostCount: 0 });
    expect(output.evidence.claim).toContain('no signature');
    expect(fake.prepareAuthorization).not.toHaveBeenCalled();
    expect(fake.submitSigned).not.toHaveBeenCalled();
    expect(sign).not.toHaveBeenCalled();
    const stored = await readFile(output.evidenceFile, 'utf8');
    expect(stored).not.toContain('ef'.repeat(65));
    expect(stored).not.toContain('TEST_ONLY_SECRET_SENTINEL');
    expect((await stat(output.evidenceFile)).mode & 0o077).toBe(0);
  });

  it('locks an intent before one submit, polls only its trace, and emits exact Transfer evidence', async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'settlemap-gasfree-broadcast-'));
    const fake = adapter();
    let clock = Date.parse('2026-09-30T00:00:00.000Z');
    const runOptions = options({ broadcast: true, confirmation: BROADCAST_CONFIRMATION });
    const dependencies = { adapter: fake.value, signTypedData: vi.fn(async () => 'ef'.repeat(65)), dataDir,
      now: () => clock, sleep: async (ms: number) => { clock += ms; }, broadcastPostCount: () => fake.submitSigned.mock.calls.length };
    const output = await executeOneShot(runOptions, dependencies);
    expect(fake.submitSigned).toHaveBeenCalledTimes(1);
    expect(fake.recover).toHaveBeenCalledTimes(1);
    expect(output.exitCode).toBe(0);
    expect(output.evidence).toMatchObject({ mode: 'BROADCAST_ATTEMPTED', exactTransferVerified: true, broadcastPostCount: 1,
      result: { status: 'CONFIRMED', chainVerification: { status: 'VERIFIED', tokenAddress, fromAddress: gasFreeAddress,
        receiverAddress: receiver, amountMicros: '1000001', transferLogIndex: 0 } } });
    const journal = await readFile(path.join(dataDir, 'test-intent.journal.json'), 'utf8');
    expect(journal).toContain('"phase": "FINISHED"');
    expect(journal).not.toContain('efefefef');
    expect(await readFile(output.evidenceFile, 'utf8')).not.toContain('ef'.repeat(65));
    await expect(executeOneShot(runOptions, dependencies)).rejects.toMatchObject({ code: 'INTENT_ALREADY_LOCKED' });
    expect(fake.submitSigned).toHaveBeenCalledTimes(1);
  });

  it('never claims success for an ambiguous result without a trace and refuses intent reuse', async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'settlemap-gasfree-unknown-'));
    const unknown = { ...result('PROCESSING'), status: 'UNKNOWN' as const, traceId: undefined,
      failureCode: 'SUBMISSION_UNKNOWN', failureReason: 'unknown', retryAction: 'MANUAL_RECONCILIATION' as const };
    const fake = adapter(unknown);
    const runOptions = options({ broadcast: true, confirmation: BROADCAST_CONFIRMATION });
    const dependencies = { adapter: fake.value, signTypedData: vi.fn(async () => 'ef'.repeat(65)), dataDir,
      broadcastPostCount: () => fake.submitSigned.mock.calls.length };
    const output = await executeOneShot(runOptions, dependencies);
    expect(output.exitCode).toBe(2);
    expect(output.evidence.exactTransferVerified).toBe(false);
    expect(output.evidence.claim).toContain('No verified transfer claim');
    expect(fake.submitSigned).toHaveBeenCalledTimes(1);
    expect(fake.recover).not.toHaveBeenCalled();
    await expect(executeOneShot(runOptions, dependencies)).rejects.toMatchObject({ code: 'INTENT_ALREADY_LOCKED' });
  });

  it('recovers a saved provider trace to Solidity verification without another submit', async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'settlemap-gasfree-recover-'));
    const fake = adapter();
    const runOptions = options({ broadcast: true, confirmation: BROADCAST_CONFIRMATION, pollSeconds: 0 });
    const dependencies = { adapter: fake.value, signTypedData: vi.fn(async () => 'ef'.repeat(65)), dataDir,
      broadcastPostCount: () => fake.submitSigned.mock.calls.length };
    const pending = await executeOneShot(runOptions, dependencies);
    expect(pending.exitCode).toBe(2);
    expect(fake.submitSigned).toHaveBeenCalledTimes(1);
    expect(fake.recover).not.toHaveBeenCalled();
    const recovered = await recoverOneShot({ recoverIntentId: 'test-intent', pollSeconds: 0 }, { adapter: fake.value, dataDir });
    expect(recovered.exitCode).toBe(0);
    expect(recovered.evidence.exactTransferVerified).toBe(true);
    expect(recovered.evidence.broadcastPostCount).toBe(1);
    expect(fake.submitSigned).toHaveBeenCalledTimes(1);
    expect(fake.recover).toHaveBeenCalledTimes(1);
  });

  it('uses an exclusive journal lock so concurrent processes cannot both submit one intent', async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'settlemap-gasfree-race-'));
    const fake = adapter(result('CONFIRMED'));
    const runOptions = options({ broadcast: true, confirmation: BROADCAST_CONFIRMATION });
    const dependencies = { adapter: fake.value, signTypedData: vi.fn(async () => 'ef'.repeat(65)), dataDir,
      broadcastPostCount: () => fake.submitSigned.mock.calls.length };
    const outcomes = await Promise.allSettled([executeOneShot(runOptions, dependencies), executeOneShot(runOptions, dependencies)]);
    expect(outcomes.filter(outcome => outcome.status === 'fulfilled')).toHaveLength(1);
    const rejected = outcomes.find(outcome => outcome.status === 'rejected');
    expect(rejected).toMatchObject({ reason: { code: 'INTENT_ALREADY_LOCKED' } });
    expect(fake.submitSigned).toHaveBeenCalledTimes(1);
  });

  it('uses official TIP-712 signing only when a mode-0600 key derives the declared payer', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'settlemap-gasfree-key-'));
    const keyFile = path.join(directory, 'signer.key');
    const privateKey = '01'.repeat(32);
    const signer = TronWeb.address.fromPrivateKey(privateKey, true);
    if (!signer) throw new Error('test key did not derive');
    await writeFile(keyFile, `${privateKey}\n`, { mode: 0o600 });
    await chmod(keyFile, 0o600);
    const typed = authorization().typedData;
    typed.message.user = signer;
    expect(await signWithPrivateKeyFile(keyFile, signer, typed)).toMatch(/^[0-9a-f]{130}$/i);
    await expect(signWithPrivateKeyFile(keyFile, fixtureAddress(26), typed)).rejects.toMatchObject({ code: 'SIGNER_MISMATCH' });
    await chmod(keyFile, 0o644);
    await expect(signWithPrivateKeyFile(keyFile, signer, typed)).rejects.toMatchObject({ code: 'SIGNER_FILE_PERMISSIONS' });
  });
});
