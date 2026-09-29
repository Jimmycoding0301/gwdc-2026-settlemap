import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import gasFreeSdk from '@gasfree/gasfree-sdk';
import { fixtureAddress } from '../shared/plan.js';
import { createGasFreeAdapter, NILE_CHAIN_ID, NILE_CONTROLLER, gasFreeConfigFromEnv } from '../server/integration/index.js';
import type { GasFreeTransferResult } from '../shared/types.js';

const payer = fixtureAddress(1), receiver = fixtureAddress(2), token = fixtureAddress(3), providerAddress = fixtureAddress(4);
const sdk = new gasFreeSdk.TronGasFree({ chainId: NILE_CHAIN_ID });
const gasFreeAddress: string = sdk.generateGasFreeAddress(payer);
const time = 1_790_500_000_000;
const requestId = '720c3647-4d89-4e30-8d80-071ca4d1c594';
const traceId = '6ab4c27c-f66b-4328-b40f-ffdc6cf1ca60';
const hash = 'ab'.repeat(32);
const signature = 'cd'.repeat(65);
const config = { apiKey: 'TEST_ONLY_API_SENTINEL', apiSecret: 'TEST_ONLY_SECRET_SENTINEL', baseUrl: 'https://open-test.gasfree.io/nile', enabled: true };
const payments = [{ id: 'payment_1', address: receiver, amountMicros: 2_000_000 }, { id: 'payment_2', address: fixtureAddress(5), amountMicros: 3_000_000 }];
const envelope = (data: unknown) => new Response(JSON.stringify({ code: 200, data }), { headers: { 'Content-Type': 'application/json' } });
const transferTopic = 'ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
function addressHex(value: string) {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let decoded = 0n;
  for (const character of value) decoded = decoded * 58n + BigInt(alphabet.indexOf(character));
  return decoded.toString(16).padStart(50, '0').slice(2, 42);
}

function rig(overrides: Partial<typeof config> = {}) {
  const state = {
    clock: time,
    tokens: [{ tokenAddress: token, symbol: 'USDT', decimal: 6, supported: true, activateFee: '1000000', transferFee: '100000' }],
    providers: [{ address: providerAddress, name: 'Test provider', config: { maxPendingTransfer: 1, minDeadlineDuration: 60, maxDeadlineDuration: 600, defaultDeadlineDuration: 180 } }],
    account: { accountAddress: payer, gasFreeAddress, active: false, nonce: '7', allow_submit: true,
      assets: [{ tokenAddress: token, tokenSymbol: 'USDT', decimal: 6, activateFee: '1000000', transferFee: '100000', frozen: '500000' }] },
    balance: 10_000_000n,
    submit: async (): Promise<Response> => envelope(receipt('WAITING')),
    query: async (): Promise<Response> => envelope(receipt('SUCCEED')),
    chain: async (): Promise<Response> => new Response(JSON.stringify({ id: hash, blockNumber: 12_345, blockTimeStamp: time,
      receipt: { result: 'SUCCESS' }, log: [{ address: addressHex(token), topics: [transferTopic,
        addressHex(gasFreeAddress).padStart(64, '0'), addressHex(receiver).padStart(64, '0')],
        data: BigInt(2_000_000).toString(16).padStart(64, '0') }] })),
    transaction: async (): Promise<Response> => new Response(JSON.stringify({ txID: hash, ret: [{ contractRet: 'SUCCESS' }] })),
  };
  function receipt(status: string) {
    return { id: traceId, accountAddress: payer, gasFreeAddress, providerAddress, targetAddress: receiver, tokenAddress: token,
      amount: '2000000', nonce: '7', maxFee: '1100000', state: status,
      ...(status === 'SUCCEED' ? { txnState: 'SOLIDITY', txnHash: hash, txnAmount: '2000000', txnTotalFee: '1090000' } : {}) };
  }
  const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const path = new URL(String(url)).pathname;
    if (path.endsWith('/config/token/all')) return envelope({ tokens: state.tokens });
    if (path.endsWith('/config/provider/all')) return envelope({ providers: state.providers });
    if (path.endsWith('/address/' + payer)) return envelope(state.account);
    if (path === '/wallet/triggerconstantcontract') return new Response(JSON.stringify({ result: { result: true }, constant_result: [state.balance.toString(16).padStart(64, '0')] }));
    if (path === '/walletsolidity/gettransactioninfobyid') return state.chain();
    if (path === '/walletsolidity/gettransactionbyid') return state.transaction();
    if (path.endsWith('/gasfree/submit') && init?.method === 'POST') return state.submit();
    if (path.endsWith('/gasfree/' + traceId) && init?.method === 'GET') return state.query();
    throw new Error('Unexpected test URL');
  });
  const adapter = createGasFreeAdapter({ ...config, ...overrides }, { fetch: fetcher, now: () => state.clock });
  const preflight = () => adapter.preflight({ payerAddress: payer, payments });
  const prepare = async () => adapter.prepareAuthorization(await preflight(), payments[0], { requestId });
  const postCount = () => fetcher.mock.calls.filter(([url]) => String(url).endsWith('/gasfree/submit')).length;
  const queryCount = () => fetcher.mock.calls.filter(([url]) => String(url).endsWith('/gasfree/' + traceId)).length;
  return { adapter, state, fetcher, preflight, prepare, receipt, postCount, queryCount };
}

describe('official GasFree Nile preflight and typed authorization', () => {
  it('requires explicit credentials and live enablement; never falls back to fixture', async () => {
    const missing = rig({ apiKey: '', apiSecret: '' });
    await expect(missing.preflight()).rejects.toMatchObject({ code: 'GASFREE_NOT_CONFIGURED' });
    expect(missing.fetcher).not.toHaveBeenCalled();
    const disabled = rig({ enabled: false });
    const auth = await disabled.prepare();
    await expect(disabled.adapter.submitSigned(auth, signature)).rejects.toMatchObject({ code: 'GASFREE_LIVE_DISABLED' });
    expect(disabled.postCount()).toBe(0);
    expect(gasFreeConfigFromEnv({})).toMatchObject({ apiKey: '', apiSecret: '', enabled: false });
  });
  it('rejects mainnet and other origins before sending credentials', () => {
    for (const baseUrl of ['https://open.gasfree.io/tron', 'https://attacker.example/nile', 'https://open-test.gasfree.io/nile?x=1']) {
      expect(() => createGasFreeAdapter({ ...config, baseUrl })).toThrow(/Nile/);
    }
    expect(() => createGasFreeAdapter({ ...config, rpcUrl: 'https://api.trongrid.io' })).toThrow(/Nile/);
  });
  it('signs the full /nile path and separates GasFree and RPC credentials', async () => {
    const test = rig();
    await test.preflight();
    const [url, init] = test.fetcher.mock.calls[0];
    const timestamp = String(time / 1000);
    const expected = createHmac('sha256', config.apiSecret).update('GET' + new URL(String(url)).pathname + timestamp).digest('base64');
    expect(init?.headers).toMatchObject({ Timestamp: timestamp, Authorization: `ApiKey ${config.apiKey}:${expected}` });
    const rpc = test.fetcher.mock.calls.find(([url]) => String(url).includes('trongrid'))!;
    expect(JSON.stringify(rpc)).not.toContain(config.apiKey);
    expect(JSON.stringify(rpc)).not.toContain(config.apiSecret);
    expect(rpc[1]?.redirect).toBe('error');
    expect(JSON.parse(String(rpc[1]?.body))).toMatchObject({ owner_address: payer, contract_address: token, function_selector: 'balanceOf(address)', visible: true });
  });
  it('uses the GasFree on-chain balance minus frozen funds and charges activation once', async () => {
    const test = rig();
    const result = await test.preflight();
    expect(result).toMatchObject({ mode: 'live', network: 'nile', chainId: NILE_CHAIN_ID, payerAddress: payer, gasFreeAddress,
      balanceMicros: '10000000', frozenMicros: '500000', availableMicros: '9500000', nonce: '7',
      principalMicros: 5_000_000, activationFeeMicros: 1_000_000, transferFeeMicros: 100_000, estimatedFeeMicros: 1_200_000,
      totalDebitMicros: 6_200_000, ready: true });
    const rpcBody = JSON.parse(String(test.fetcher.mock.calls.find(([url]) => String(url).includes('trongrid'))![1]?.body));
    expect(rpcBody.parameter).toHaveLength(64);
    expect(rpcBody.parameter).toBe(sdk.calculateSalt(gasFreeAddress).slice(2).toLowerCase());
    test.state.account.active = true;
    expect(await test.preflight()).toMatchObject({ activationFeeMicros: 0, estimatedFeeMicros: 200_000 });
  });
  it('blocks pending accounts and insufficient spendable balances without inventing funds', async () => {
    const test = rig();
    test.state.account.allow_submit = false;
    test.state.balance = 400_000n;
    const check = await test.preflight();
    expect(check.availableMicros).toBe('0');
    expect(check.ready).toBe(false);
    expect(check.blockers.map(b => b.code)).toEqual(['PENDING_LIMIT', 'INSUFFICIENT_BALANCE']);
    expect(() => test.adapter.prepareAuthorization(check, payments[0])).toThrow(/预检/);
  });
  it('does not guess missing frozen balances, tokens, or the provider', async () => {
    const test = rig();
    test.state.account.assets = [];
    await expect(test.preflight()).rejects.toMatchObject({ code: 'ACCOUNT_ASSET_UNAVAILABLE' });
    const tokenTest = rig(); tokenTest.state.tokens[0].supported = false;
    await expect(tokenTest.preflight()).rejects.toMatchObject({ code: 'UNSUPPORTED_TOKEN' });
    const multi = rig(); multi.state.providers.push({ ...multi.state.providers[0], address: fixtureAddress(6) });
    await expect(multi.preflight()).rejects.toMatchObject({ code: 'PROVIDER_SELECTION_REQUIRED' });
  });
  it('checks that the GasFree address is the SDK-derived account for the selected EOA', async () => {
    const test = rig(); test.state.account.gasFreeAddress = fixtureAddress(10);
    await expect(test.preflight()).rejects.toMatchObject({ code: 'ACCOUNT_MISMATCH' });
  });
  it('builds the exact official SDK TIP-712 payload, retaining decimal integer strings', async () => {
    const test = rig(); const auth = await test.prepare();
    expect(auth).toMatchObject({ requestId, paymentId: payments[0].id, network: 'nile', gasFreeAddress });
    expect(auth.typedData).toEqual(sdk.assembleGasFreeTransactionJson(auth.typedData.message));
    expect(auth.typedData.domain).toEqual({ name: 'GasFreeController', version: 'V1.0.0', chainId: NILE_CHAIN_ID, verifyingContract: NILE_CONTROLLER });
    expect(auth.typedData.message).toMatchObject({ user: payer, receiver, token, serviceProvider: providerAddress, value: '2000000', maxFee: '1100000', nonce: '7', version: '1', deadline: String(time / 1000 + 180) });
    expect(JSON.stringify(auth)).not.toContain(config.apiKey);
    expect(JSON.stringify(auth)).not.toContain(config.apiSecret);
  });
  it('requires fresh preflight, next-payment ordering, and a sufficient fee cap', async () => {
    const test = rig(); const check = await test.preflight();
    expect(() => test.adapter.prepareAuthorization(check, payments[1])).toThrow(/下一笔/);
    expect(() => test.adapter.prepareAuthorization(check, payments[0], { maxFeeMicros: 1 })).toThrow(/费用上限/);
    test.state.clock += 30_001;
    expect(() => test.adapter.prepareAuthorization(check, payments[0])).toThrow(/过期/);
  });
});

describe('submission, real identifiers, and status-first recovery', () => {
  it('rechecks nonce and fees immediately before submission', async () => {
    const test = rig(); const auth = await test.prepare();
    test.state.account.nonce = '8';
    expect(await test.adapter.submitSigned(auth, signature)).toMatchObject({ status: 'FAILED', failureCode: 'PREFLIGHT_CHANGED' });
    expect(test.postCount()).toBe(0);
    const fee = rig(); const feeAuth = await fee.prepare(); fee.state.account.assets[0].transferFee = '200000';
    expect(await fee.adapter.submitSigned(feeAuth, signature)).toMatchObject({ status: 'FAILED', failureCode: 'PREFLIGHT_CHANGED' });
    expect(fee.postCount()).toBe(0);
  });
  it('distinguishes requestId and traceId from a confirmed chain transaction hash', async () => {
    const test = rig(); const auth = await test.prepare();
    const accepted = await test.adapter.submitSigned(auth, '0x' + signature);
    expect(accepted).toMatchObject({ requestId, traceId, status: 'PROCESSING', retryAction: 'QUERY_ORIGINAL' });
    expect(accepted.txHash).toBeUndefined();
    expect(accepted.actualFeeMicros).toBeUndefined();
    const confirmed = await test.adapter.recover(auth, accepted);
    expect(confirmed).toMatchObject({ requestId, traceId, txHash: hash, status: 'CONFIRMED', actualFeeMicros: 1_090_000, actualAmountMicros: 2_000_000 });
    expect(confirmed).toMatchObject({ verificationSource: 'gasfree-provider+nile-solidity-rpc',
      chainVerification: { status: 'VERIFIED', blockNumber: 12_345, transferLogIndex: 0 } });
    expect(test.postCount()).toBe(1);
    expect(test.queryCount()).toBe(1);
    const sent = JSON.parse(String(test.fetcher.mock.calls.find(([url]) => String(url).endsWith('/gasfree/submit'))![1]?.body));
    expect(sent).toEqual({ requestId, ...auth.typedData.message, sig: signature });
    expect(JSON.stringify(confirmed)).not.toContain(signature);
  });
  it('never repeats an ambiguous POST even when the user retries or process state lacks traceId', async () => {
    const test = rig(); const auth = await test.prepare();
    test.state.submit = async () => { throw new Error(config.apiSecret); };
    const unknown = await test.adapter.submitSigned(auth, signature);
    expect(unknown).toMatchObject({ status: 'UNKNOWN', requestId, retryAction: 'MANUAL_RECONCILIATION' });
    expect(unknown.traceId).toBeUndefined();
    expect(unknown.txHash).toBeUndefined();
    expect(JSON.stringify(unknown)).not.toContain(config.apiSecret);
    const afterRetry = await test.adapter.submitSigned(auth, signature);
    expect(afterRetry.failureCode).toBe('MISSING_TRACE_ID');
    const restarted = rig();
    expect(await restarted.adapter.submitSigned(auth, signature, unknown)).toMatchObject({ status: 'UNKNOWN', failureCode: 'MISSING_TRACE_ID' });
    expect(restarted.fetcher).not.toHaveBeenCalled();
    expect(test.postCount()).toBe(1);
  });
  it('coalesces concurrent clicks into one POST then checks the original trace', async () => {
    const test = rig(); const auth = await test.prepare();
    const results = await Promise.all([test.adapter.submitSigned(auth, signature), test.adapter.submitSigned(auth, signature)]);
    expect(test.postCount()).toBe(1);
    expect(results.map(r => r.status)).toEqual(['PROCESSING', 'CONFIRMED']);
  });
  it('maps explicit provider rejections to FAILED with safe reasons, without echoing provider messages', async () => {
    const test = rig(); const auth = await test.prepare();
    test.state.submit = async () => new Response(JSON.stringify({ code: 400, reason: 'NonceNotMatchException', message: config.apiSecret, data: null }));
    const result = await test.adapter.submitSigned(auth, signature);
    expect(result).toMatchObject({ status: 'FAILED', failureCode: 'NonceNotMatchException', retryAction: 'NEW_AUTHORIZATION_REQUIRED' });
    expect(result.failureReason).toContain('nonce');
    expect(JSON.stringify(result)).not.toContain(config.apiSecret);
    expect(result.txHash).toBeUndefined();
    expect(await test.adapter.recover(auth, result)).toEqual(result);
    expect(test.queryCount()).toBe(0);
  });
  it('treats HTTP errors and business runtime errors as unknown after POST', async () => {
    for (const response of [new Response('unavailable', { status: 503 }), new Response(JSON.stringify({ code: 500, reason: 'RuntimeException', data: null }))]) {
      const test = rig(); const auth = await test.prepare(); test.state.submit = async () => response;
      expect(await test.adapter.submitSigned(auth, signature)).toMatchObject({ status: 'UNKNOWN', retryAction: 'MANUAL_RECONCILIATION' });
      expect(test.postCount()).toBe(1);
    }
  });
  it('retains a trace ID from malformed acceptance so recovery can query, never re-submit', async () => {
    const test = rig(); const auth = await test.prepare(); test.state.submit = async () => envelope({ id: traceId });
    const result = await test.adapter.submitSigned(auth, signature);
    expect(result).toMatchObject({ status: 'UNKNOWN', traceId, failureCode: 'INVALID_TRANSFER_RESPONSE' });
    expect(await test.adapter.recover(auth, result)).toMatchObject({ status: 'CONFIRMED' });
    expect(test.postCount()).toBe(1);
  });
  it('requires matching authorization fields, solidified success, and a real hash before confirming', async () => {
    for (const patch of [{ txnState: 'ON_CHAIN' }, { txnHash: '' }, { targetAddress: fixtureAddress(8) }, { nonce: '8' }, { amount: '1' }, { txnAmount: '1' }, { txnTotalFee: '99999999' }]) {
      const test = rig(); const auth = await test.prepare();
      test.state.query = async () => envelope({ ...test.receipt('SUCCEED'), ...patch });
      const result = await test.adapter.query(auth, traceId);
      expect(result.status).not.toBe('CONFIRMED');
      expect(result.retryAction).toBe('QUERY_ORIGINAL');
    }
  });
  it('keeps provider success unresolved when the independent solidified receipt does not match', async () => {
    const test = rig(); const auth = await test.prepare();
    test.state.chain = async () => new Response(JSON.stringify({ id: hash, blockNumber: 12_345, blockTimeStamp: time,
      receipt: { result: 'SUCCESS' }, log: [] }));
    const result = await test.adapter.query(auth, traceId);
    expect(result).toMatchObject({ status: 'UNKNOWN', failureCode: 'CHAIN_MISMATCH', retryAction: 'QUERY_ORIGINAL',
      chainVerification: { status: 'MISMATCH' } });
  });
  it('requires both the solidified transaction body and receipt to report success', async () => {
    const test = rig(); const auth = await test.prepare();
    test.state.transaction = async () => new Response(JSON.stringify({ txID: hash, ret: [{ contractRet: 'REVERT' }] }));
    expect(await test.adapter.query(auth, traceId)).toMatchObject({ status: 'UNKNOWN', failureCode: 'CHAIN_MISMATCH',
      chainVerification: { status: 'MISMATCH' } });
    const receipt = rig(); const receiptAuth = await receipt.prepare();
    receipt.state.chain = async () => new Response(JSON.stringify({ id: hash, blockNumber: 12_345, blockTimeStamp: time,
      receipt: { result: 'FAILED' }, log: [] }));
    expect(await receipt.adapter.query(receiptAuth, traceId)).toMatchObject({ status: 'UNKNOWN', failureCode: 'CHAIN_MISMATCH' });
  });
  it('rejects an otherwise exact Transfer outside the authorization time window with 30-second skew tolerance', async () => {
    for (const blockTimeStamp of [time - 30_001, time + 180_000 + 30_001]) {
      const test = rig(); const auth = await test.prepare();
      test.state.chain = async () => new Response(JSON.stringify({ id: hash, blockNumber: 12_345, blockTimeStamp,
        receipt: { result: 'SUCCESS' }, log: [{ address: addressHex(token), topics: [transferTopic,
          addressHex(gasFreeAddress).padStart(64, '0'), addressHex(receiver).padStart(64, '0')],
          data: BigInt(2_000_000).toString(16).padStart(64, '0') }] }));
      const result = await test.adapter.query(auth, traceId);
      expect(result).toMatchObject({ status: 'UNKNOWN', failureCode: 'CHAIN_MISMATCH',
        chainVerification: { status: 'MISMATCH', blockTimestamp: blockTimeStamp } });
      expect(result.failureReason).toContain('30 秒');
    }
  });
  it('keeps unknown query outcomes unresolved and records definitive per-payment failure', async () => {
    const test = rig(); const auth = await test.prepare();
    test.state.query = async () => { throw new Error('offline'); };
    expect(await test.adapter.query(auth, traceId)).toMatchObject({ status: 'UNKNOWN', traceId, retryAction: 'QUERY_ORIGINAL' });
    test.state.query = async () => envelope({ ...test.receipt('FAILED'), txnHash: hash, txnState: 'ON_CHAIN_FAILED' });
    expect(await test.adapter.query(auth, traceId)).toMatchObject({ status: 'FAILED', txHash: hash, failureCode: 'ON_CHAIN_FAILED' });
    expect(test.postCount()).toBe(0);
  });
  it('does not promote estimated fees to actual fees', async () => {
    const test = rig(); const auth = await test.prepare();
    const { txnTotalFee: _fee, txnAmount: _amount, ...receipt } = test.receipt('SUCCEED');
    test.state.query = async () => envelope({ ...receipt, estimatedTotalFee: 999_999 });
    expect((await test.adapter.query(auth, traceId)).actualFeeMicros).toBeUndefined();
  });
  it('does not unlock repayment when a failed record also reports transferred funds', async () => {
    const test = rig(); const auth = await test.prepare();
    test.state.query = async () => envelope({ ...test.receipt('FAILED'), txnHash: hash, txnAmount: '2000000', txnState: 'ON_CHAIN_FAILED' });
    expect(await test.adapter.query(auth, traceId)).toMatchObject({ status: 'UNKNOWN', txHash: hash, failureCode: 'INCONSISTENT_FAILURE', retryAction: 'QUERY_ORIGINAL' });
  });
  it('rejects mutated authorizations, malformed signatures, simulated traces, and unrelated recovery', async () => {
    const test = rig(); const auth = await test.prepare();
    const modified = structuredClone(auth); modified.typedData.message.receiver = fixtureAddress(10);
    await expect(test.adapter.submitSigned(modified, signature)).rejects.toMatchObject({ code: 'INVALID_AUTHORIZATION' });
    await expect(test.adapter.submitSigned(auth, 'bad')).rejects.toMatchObject({ code: 'INVALID_SIGNATURE' });
    await expect(test.adapter.query(auth, 'sim_trace_a')).rejects.toMatchObject({ code: 'INVALID_TRACE_ID' });
    await expect(test.adapter.recover(auth, { mode: 'live', network: 'nile', requestId: 'different' } as GasFreeTransferResult)).rejects.toMatchObject({ code: 'RECOVERY_MISMATCH' });
    expect(test.postCount()).toBe(0);
  });
});
