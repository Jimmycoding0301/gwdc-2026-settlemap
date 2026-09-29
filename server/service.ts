import { randomUUID } from 'node:crypto';
import { applyLivePreflight, buildPlan, canonical, planDigest } from '../shared/plan.js';
import type { Batch, GasFreeAuthorization, GasFreeTransferResult, InputRow, NileChainVerification, PaymentExecution, PaymentPlan } from '../shared/types.js';
import type { Config } from './config.js';
import type { GasFreeAdapter } from './integration/index.js';
import { Store } from './store.js';
import type { FixtureReceipt } from './store.js';
import { inspectOperations } from './ops.js';
import { priorMonthRows } from '../shared/sample.js';
import { buildSettlementManifest, manifestMatchesPlan, settlementManifestHash } from './evidence.js';

export class ServiceError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly details?: unknown) { super(message); }
}
const simId = (kind: string) => `sim_${kind}_${randomUUID()}`;
const liveId = (kind: string) => `live_${kind}_${randomUUID()}`;
const timestamp = () => new Date().toISOString();

export class SettlementService {
  private busy = false;
  constructor(readonly store: Store, private readonly config: Config, private readonly gasFree?: GasFreeAdapter) {}

  private find(id: string): Batch {
    const batch = this.store.batches.get(id);
    if (!batch) throw new ServiceError(404, 'BATCH_NOT_FOUND', '找不到该批次。');
    return batch;
  }
  get(id: string) { return structuredClone(this.find(id)); }
  list() { return [...this.store.batches.values()].map(batch => structuredClone(batch)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }
  inspect(rows: InputRow[], excludeBatchId?: string) { return inspectOperations(rows, this.store.batches.values(), excludeBatchId); }
  private assertHistory(rows: InputRow[], excludeBatchId?: string) {
    const activeRows = rows.filter(row => !row.deferred);
    const inspection = this.inspect(activeRows, excludeBatchId);
    if (inspection.summary.settled || inspection.summary.unresolved) {
      throw new ServiceError(409, 'HISTORICAL_INVOICE_CONFLICT', `历史中有 ${inspection.summary.settled} 条已结算、${inspection.summary.unresolved} 条待核查业务。请暂缓这些行，禁止重复付款。`, inspection);
    }
    const unreviewed = inspection.items.filter((item, index) => item.addressStatus === 'CHANGED' && activeRows[index].reviewedAddressChange !== true);
    if (unreviewed.length) throw new ServiceError(409, 'ADDRESS_CHANGE_UNREVIEWED', `${unreviewed.length} 条业务的收款地址与最近已确认记录不同。请明确人工复核或暂缓；人工复核不等于证明地址归属。`, inspection);
  }
  private event(batch: Batch, kind: string, title: string, detail: string) {
    batch.updatedAt = timestamp();
    batch.events.push({ id: batch.mode === 'fixture' ? simId('event') : liveId('event'), at: batch.updatedAt, kind, title, detail });
  }
  private assertPlan(batch: Batch) {
    if (batch.planDigest !== batch.plan.digest || planDigest(batch.plan) !== batch.planDigest) {
      throw new ServiceError(409, 'PLAN_CHANGED', '结算清单已变化，请重新创建并确认批次。');
    }
    if (batch.payments.length !== batch.plan.payments.length || batch.payments.some((payment, index) => {
      const original: PaymentPlan = { id: payment.id, payeeId: payment.payeeId, payeeName: payment.payeeName,
        address: payment.address, token: payment.token, amountMicros: payment.amountMicros, feeMicros: payment.feeMicros,
        rowIds: payment.rowIds, invoiceIds: payment.invoiceIds };
      return canonical(original) !== canonical(batch.plan.payments[index]);
    })) throw new ServiceError(409, 'PAYMENT_PLAN_CHANGED', '付款参数不再匹配已确认清单。');
    if (batch.mode === 'live') {
      if (!batch.preflight || !batch.settlementManifest || !batch.manifestHash ||
          settlementManifestHash(batch.settlementManifest) !== batch.manifestHash ||
          !manifestMatchesPlan(batch.settlementManifest, batch.plan, batch.preflight, batch.payerAddress) ||
          batch.payments.some(payment => payment.manifestHash !== batch.manifestHash)) {
        throw new ServiceError(409, 'MANIFEST_CHANGED', '确定性结算清单与实时付款参数不再匹配，请重新创建批次。');
      }
    }
  }
  private async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    if (this.busy) throw new ServiceError(409, 'EXECUTION_BUSY', '同一付款账户正在执行其他操作，请等待其状态明确。');
    this.busy = true;
    try { return await fn(); } finally { this.busy = false; }
  }

  private liveError(error: unknown, fallback: string): ServiceError {
    if (error && typeof error === 'object') {
      const candidate = error as { status?: unknown; code?: unknown; message?: unknown };
      const status = typeof candidate.status === 'number' && candidate.status >= 400 && candidate.status < 600 ? candidate.status : 502;
      const code = typeof candidate.code === 'string' && /^[A-Z0-9_]{2,80}$/.test(candidate.code) ? candidate.code : 'GASFREE_ERROR';
      const message = typeof candidate.message === 'string' && candidate.message.length <= 500 ? candidate.message : fallback;
      return new ServiceError(status, code, message);
    }
    return new ServiceError(502, 'GASFREE_ERROR', fallback);
  }

  /** A solidified event log is a consumable proof: one store-wide payment/operation may claim it. */
  private chainEvidenceConflict(batch: Batch, payment: PaymentExecution, proof: NileChainVerification, operationHash: string) {
    if (!Number.isSafeInteger(proof.transferLogIndex)) return undefined;
    for (const candidateBatch of this.store.batches.values()) {
      for (const candidatePayment of candidateBatch.payments) {
        const claims = [
          ...(candidatePayment.chainVerification ? [{ proof: candidatePayment.chainVerification, operationHash: candidatePayment.operationHash }] : []),
          ...candidatePayment.attempts.flatMap(attempt => attempt.chainVerification
            ? [{ proof: attempt.chainVerification, operationHash: attempt.chainVerification.operationHash || attempt.authorization?.operationHash }]
            : []),
        ];
        for (const claim of claims) {
          if (typeof claim.proof.txHash !== 'string' || claim.proof.txHash.toLowerCase() !== proof.txHash.toLowerCase()
            || claim.proof.transferLogIndex !== proof.transferLogIndex) continue;
          const samePayment = candidateBatch.id === batch.id && candidatePayment === payment;
          if (samePayment && claim.operationHash === operationHash) continue;
          return { batchId: candidateBatch.id, paymentId: candidatePayment.id, operationHash: claim.operationHash };
        }
      }
    }
    return undefined;
  }

  async create(rows: InputRow[], mode: 'fixture' | 'live' = 'fixture', payerAddress?: string): Promise<Batch> {
    return this.exclusive(async () => {
    const createdAt = timestamp();
    const plan = buildPlan(rows, createdAt, mode);
    this.assertHistory(plan.rows.filter(row => row.status === 'VALID'));
    let preflight: Batch['preflight'];
    if (mode === 'live') {
      if (!this.config.apiKey || !this.config.apiSecret || !this.gasFree) throw new ServiceError(409, 'LIVE_NOT_CONFIGURED', 'GasFree API Key 与 Secret 尚未配置；未发起支付，也不会回退模拟。');
      if (!payerAddress) throw new ServiceError(422, 'PAYER_REQUIRED', '请先连接 TronLink 并选择付款人 EOA 地址。');
      try {
        preflight = await this.gasFree.preflight({ payerAddress, payments: plan.payments.map(payment => ({ id: payment.id, address: payment.address, amountMicros: payment.amountMicros })) });
      } catch (error) { throw this.liveError(error, 'GasFree 实时预检失败；未创建可签名清单。'); }
      applyLivePreflight(plan, preflight);
      if (!preflight.ready) throw new ServiceError(409, 'PREFLIGHT_BLOCKED', 'GasFree 余额、冻结金额或待处理限制未通过，不能创建付款清单。', preflight);
    }
    const batch: Batch = { id: mode === 'fixture' ? simId('batch') : liveId('batch'), createdAt, updatedAt: createdAt, mode, status: 'DRAFT', plan,
      planDigest: plan.digest, payments: plan.payments.map(payment => ({ ...structuredClone(payment), status: 'QUEUED', attempts: [] })), events: [] };
    if (mode === 'live') {
      batch.payerAddress = payerAddress; batch.preflight = preflight;
      batch.settlementManifest = buildSettlementManifest(plan, preflight!);
      batch.manifestHash = settlementManifestHash(batch.settlementManifest);
      batch.payments.forEach(payment => { payment.manifestHash = batch.manifestHash; });
    }
    this.event(batch, 'created', '结算草稿已生成', mode === 'fixture'
      ? `${plan.summary.validRows} 条有效业务合并为 ${plan.summary.paymentCount} 笔模拟付款；${plan.summary.invalidRows} 条异常业务排除。`
      : `${plan.summary.validRows} 条有效业务合并为 ${plan.summary.paymentCount} 笔 GasFree 付款；已绑定付款账户、币种、余额与实时费用快照。`);
    this.store.batches.set(batch.id, batch);
    await this.store.persist();
    return this.get(batch.id);
    });
  }

  async confirm(id: string, digest: string): Promise<Batch> {
    return this.exclusive(async () => {
    const batch = this.find(id);
    this.assertPlan(batch);
    if (digest !== batch.planDigest) throw new ServiceError(409, 'DIGEST_MISMATCH', '确认摘要与当前清单不符。');
    if (batch.status === 'CONFIRMED') {
      this.assertHistory(batch.plan.rows.filter(row => row.status === 'VALID'), batch.id);
      return this.get(id);
    }
    if (batch.status !== 'DRAFT') throw new ServiceError(409, 'INVALID_STATE', '仅草稿可以确认。');
    if (batch.payments.length === 0) throw new ServiceError(409, 'NO_PAYMENTS', '没有可付款的有效业务行。');
    this.assertHistory(batch.plan.rows.filter(row => row.status === 'VALID'), batch.id);
    batch.status = 'CONFIRMED'; batch.confirmedAt = timestamp();
    this.event(batch, 'confirmed', '清单已确认', batch.mode === 'fixture'
      ? '确认绑定了业务行、收款人、地址、金额和演示费率的完整摘要。异常行不参与付款。'
      : '确认绑定了付款人、GasFree 账户、业务行、收款地址、金额和实时费用快照。每笔仍需钱包单独签名。');
    await this.store.persist();
    return this.get(id);
    });
  }

  async resetDemo() {
    return this.exclusive(async () => {
      if ([...this.store.batches.values()].some(batch => batch.mode !== 'fixture' || !batch.id.startsWith('sim_batch_'))
        || [...this.store.receipts.values()].some(receipt => !receipt.traceId.startsWith('sim_trace_'))) {
        throw new ServiceError(409, 'RESET_NOT_FIXTURE', '存储中存在非模拟记录，演示重置已拒绝；未删除任何数据。');
      }
      return this.store.resetFixture();
    });
  }

  /** Reset fixture state, then create a confirmed August ledger for the KOL demo. */
  async prepareCreatorDemo() {
    const reset = await this.resetDemo();
    const baseline = await this.create(priorMonthRows());
    await this.confirm(baseline.id, baseline.planDigest);
    const firstPass = await this.run(baseline.id);
    const completed = firstPass.status === 'PAUSED' ? await this.recover(baseline.id) : firstPass;
    if (completed.status !== 'COMPLETED') throw new ServiceError(500, 'DEMO_HISTORY_INCOMPLETE', '无法准备上月演示账本。');
    return { ...reset, baselineBatchId: completed.id, historicalPayments: completed.payments.length };
  }

  async run(id: string): Promise<Batch> {
    return this.exclusive(async () => {
      const batch = this.find(id);
      this.assertPlan(batch);
      if (batch.mode === 'live') throw new ServiceError(409, 'WALLET_SIGNATURE_REQUIRED', '真实 GasFree 付款需要逐笔生成 TIP-712 授权并由 TronLink 签名，不能用模拟运行接口。');
      if (batch.status === 'COMPLETED') return this.get(id);
      if (batch.status !== 'CONFIRMED') throw new ServiceError(409, 'INVALID_STATE', '请先确认清单；未知状态必须查询恢复，不能再次运行付款。');
      await this.runQueue(batch);
      return this.get(id);
    });
  }

  private applyReceipt(batch: Batch, payment: PaymentExecution, receipt: FixtureReceipt) {
    const attempt = payment.attempts.at(-1);
    if (!attempt || receipt.traceId !== attempt.traceId || receipt.requestId !== attempt.requestId
      || receipt.paymentId !== payment.id || receipt.address !== payment.address || receipt.token !== payment.token
      || receipt.amountMicros !== payment.amountMicros || receipt.feeMicros !== payment.feeMicros || receipt.status !== 'CONFIRMED') {
      throw new ServiceError(409, 'RECEIPT_MISMATCH', '回执与原付款参数不匹配。批次保持待核查，不能重新支付。');
    }
    payment.status = 'CONFIRMED'; payment.actualFeeMicros = receipt.feeMicros; payment.confirmedAt = timestamp();
    attempt.status = 'CONFIRMED';
    this.event(batch, 'payment_confirmed', '模拟付款已核对', `${payment.payeeName} 的 ${payment.invoiceIds.length} 条业务已关联至 ${receipt.traceId}。该标识不是链上交易哈希。`);
  }

  private async runQueue(batch: Batch) {
    const unresolved = [...this.store.batches.values()].find(other => other.id !== batch.id
      && (other.status === 'RUNNING' || other.payments.some(payment => payment.status === 'UNKNOWN')));
    if (unresolved) throw new ServiceError(409, 'ACCOUNT_UNRESOLVED', '同一模拟付款账户仍有其他批次结果待核查。请先恢复该批次，禁止并行推进新付款。');
    this.assertHistory(batch.plan.rows.filter(row => row.status === 'VALID'), batch.id);
    batch.status = 'RUNNING'; delete batch.error;
    await this.store.persist();
    for (let index = 0; index < batch.payments.length; index++) {
      const payment = batch.payments[index];
      if (payment.status === 'CONFIRMED') continue;
      if (payment.status === 'UNKNOWN' || payment.attempts.length > 0) {
        batch.status = 'PAUSED'; await this.store.persist(); return;
      }
      this.assertPlan(batch);
      const attempt = { id: simId('attempt'), requestId: simId('request'), traceId: simId('trace'), startedAt: timestamp(), status: 'SUBMITTING' as const, queries: 0 };
      payment.attempts.push(attempt); payment.traceId = attempt.traceId; payment.status = 'UNKNOWN';
      this.event(batch, 'submitted', '按顺序提交模拟付款', `${payment.payeeName}：已记录唯一 request/trace，后续付款等待本笔状态明确。`);
      await this.store.persist();
      // Fixture provider: its accepted result persists separately from the caller's state.
      const receipt: FixtureReceipt = { traceId: attempt.traceId, requestId: attempt.requestId, paymentId: payment.id,
        address: payment.address, token: payment.token, amountMicros: payment.amountMicros, feeMicros: payment.feeMicros, status: 'CONFIRMED' };
      this.store.receipts.set(attempt.traceId, receipt);
      await this.store.persist();
      if (index === 1) {
        payment.attempts[0].status = 'UNKNOWN'; batch.status = 'PAUSED';
        this.event(batch, 'unknown', '浏览器响应丢失，批次暂停', '第二笔的模拟 Provider trace 已由服务端保存，但浏览器没有收到结果。第三笔保持 QUEUED；只能查询原 trace，不能生成新付款。');
        await this.store.persist(); return;
      }
      this.applyReceipt(batch, payment, receipt);
      await this.store.persist();
    }
    batch.status = 'COMPLETED';
    this.event(batch, 'completed', '模拟结算完成', '每条有效业务均已映射到对应模拟付款。没有真实 USDT 转账或链上交易哈希。');
    await this.store.persist();
  }

  private applyLiveResult(batch: Batch, payment: PaymentExecution, result: GasFreeTransferResult) {
    const attempt = payment.attempts.at(-1);
    if (!attempt || !attempt.authorization || attempt.requestId !== result.requestId) {
      throw new ServiceError(409, 'LIVE_RESULT_MISMATCH', 'GasFree 状态与本地保存的原授权不匹配，保持待核查。');
    }
    payment.requestId = result.requestId;
    payment.traceId = result.traceId;
    payment.txHash = result.txHash;
    payment.providerState = result.providerState;
    payment.chainState = result.chainState;
    payment.failureCode = result.failureCode;
    payment.failureReason = result.failureReason;
    attempt.traceId = result.traceId;
    attempt.txHash = result.txHash;
    attempt.failureCode = result.failureCode;
    attempt.failureReason = result.failureReason;
    attempt.chainVerification = result.chainVerification;
    payment.chainVerification = result.chainVerification;
    payment.manifestHash = attempt.authorization.manifestHash;
    payment.operationHash = attempt.authorization.operationHash;
    if (result.status === 'CONFIRMED') {
      if (!result.traceId || !result.txHash || result.chainVerification?.status !== 'VERIFIED' ||
          result.verificationSource !== 'gasfree-provider+nile-solidity-rpc' ||
          result.chainVerification.manifestHash !== batch.manifestHash ||
          result.chainVerification.operationHash !== attempt.authorization.operationHash ||
          !Number.isSafeInteger(result.chainVerification.transferLogIndex)) {
        payment.status = 'UNKNOWN'; attempt.status = 'UNKNOWN'; payment.failureCode = 'CONFIRMATION_INCOMPLETE';
        payment.failureReason = 'GasFree 成功记录尚未通过绑定清单的 Nile 固化回执核验。';
        attempt.failureCode = payment.failureCode; attempt.failureReason = payment.failureReason;
        this.event(batch, 'live_unknown', '链上证据尚未闭合', `${payment.payeeName}：保留原 trace，等待 Nile 固化回执与 Transfer 日志核验。`);
        return;
      }
      const conflict = this.chainEvidenceConflict(batch, payment, result.chainVerification, attempt.authorization.operationHash!);
      if (conflict) {
        payment.status = 'UNKNOWN'; attempt.status = 'UNKNOWN'; payment.failureCode = 'CHAIN_EVIDENCE_REUSED';
        payment.failureReason = `交易 ${result.txHash} 的 Transfer 日志 #${result.chainVerification.transferLogIndex} 已绑定批次 ${conflict.batchId} / 付款 ${conflict.paymentId}；禁止把同一链上事件再次关联。`;
        attempt.failureCode = payment.failureCode; attempt.failureReason = payment.failureReason;
        this.event(batch, 'live_unknown', '链上证据已被其他付款占用', `${payment.payeeName}：同一 tx/log 不能绑定第二个 operation；保持 UNKNOWN，禁止重付。`);
        return;
      }
      payment.status = 'CONFIRMED'; attempt.status = 'CONFIRMED'; payment.actualFeeMicros = result.actualFeeMicros; payment.confirmedAt = result.checkedAt;
      this.event(batch, 'live_confirmed', 'Nile 链上付款已核验', `${payment.payeeName}：trace ${result.traceId}，交易 ${result.txHash}，区块 ${result.chainVerification.blockNumber}。`);
    } else if (result.status === 'FAILED') {
      payment.status = 'FAILED'; attempt.status = 'FAILED';
      this.event(batch, 'live_failed', 'GasFree 付款已失败', `${payment.payeeName}：${result.failureReason || '服务商返回失败'}。重新付款需独立复核和新授权。`);
    } else if (result.status === 'PROCESSING') {
      payment.status = 'PROCESSING'; attempt.status = 'PROCESSING';
      this.event(batch, 'live_processing', 'GasFree 正在处理', `${payment.payeeName}：已保存 trace ${result.traceId}，后续只查询这份授权。`);
    } else {
      payment.status = 'UNKNOWN'; attempt.status = 'UNKNOWN';
      this.event(batch, 'live_unknown', 'GasFree 结果待核查', result.traceId
        ? `${payment.payeeName}：已保存 trace ${result.traceId}，禁止重新 submit。`
        : `${payment.payeeName}：未收到 traceId，官方无按 requestId 查询接口，只能人工核对，禁止重发。`);
    }
  }

  private updateLiveBatchState(batch: Batch) {
    if (batch.payments.some(payment => payment.status === 'PROCESSING' || payment.status === 'UNKNOWN')) batch.status = 'PAUSED';
    else if (batch.payments.some(payment => payment.status === 'FAILED')
      && batch.payments.some(payment => payment.status === 'QUEUED')) batch.status = 'PAUSED';
    else if (batch.payments.some(payment => payment.status === 'QUEUED')) batch.status = 'CONFIRMED';
    else {
      batch.status = 'COMPLETED';
      const confirmed = batch.payments.filter(payment => payment.status === 'CONFIRMED').length;
      const failed = batch.payments.filter(payment => payment.status === 'FAILED').length;
      this.event(batch, 'live_completed', 'GasFree 批次已有明确结果', `${confirmed} 笔成功，${failed} 笔失败；原始业务、requestId、traceId、链上哈希与费用已关联。`);
    }
  }

  async prepareLive(id: string): Promise<{ batch: Batch; authorization: GasFreeAuthorization }> {
    return this.exclusive(async () => {
      const batch = this.find(id);
      this.assertPlan(batch);
      if (batch.mode !== 'live' || !batch.payerAddress || !batch.preflight || !this.gasFree) throw new ServiceError(409, 'LIVE_BATCH_REQUIRED', '该批次不是可签名的 GasFree 真实清单。');
      if (!['CONFIRMED', 'PAUSED'].includes(batch.status)) throw new ServiceError(409, 'INVALID_STATE', '请先确认清单，或等当前付款状态明确。');
      this.assertHistory(batch.plan.rows.filter(row => row.status === 'VALID'), batch.id);
      if (batch.payments.some(payment => payment.status === 'PROCESSING' || payment.status === 'UNKNOWN')) {
        throw new ServiceError(409, 'PAYMENT_UNRESOLVED', '当前授权仍在处理或结果未知；先查询原 trace，不生成新授权。');
      }
      const other = [...this.store.batches.values()].find(candidate => candidate.id !== batch.id && candidate.mode === 'live'
        && candidate.payerAddress === batch.payerAddress && candidate.payments.some(payment => payment.status === 'PROCESSING' || payment.status === 'UNKNOWN'
          || payment.attempts.at(-1)?.status === 'SUBMITTING'));
      if (other) throw new ServiceError(409, 'ACCOUNT_UNRESOLVED', '同一 GasFree 付款账户还有其他授权待处理，请先核对原批次。');
      const payment = batch.payments.find(candidate => candidate.status === 'QUEUED');
      if (!payment) { this.updateLiveBatchState(batch); await this.store.persist(); throw new ServiceError(409, 'NO_QUEUED_PAYMENT', '没有等待签名的付款。'); }
      const pending = payment.attempts.at(-1);
      if (pending?.status === 'SUBMITTING' && pending.authorization) {
        const deadline = Number(pending.authorization.typedData.message.deadline) * 1000;
        if (Number.isFinite(deadline) && deadline > Date.now() + 5_000) return { batch: this.get(id), authorization: structuredClone(pending.authorization) };
        pending.status = 'FAILED'; pending.failureCode = 'AUTHORIZATION_EXPIRED'; pending.failureReason = '钱包签名前授权已过期，该授权从未提交。';
      }
      let check;
      try {
        check = await this.gasFree.preflight({ payerAddress: batch.payerAddress,
          providerAddress: batch.preflight.selectedProvider.address, tokenAddress: batch.preflight.selectedToken.tokenAddress,
          payments: [{ id: payment.id, address: payment.address, amountMicros: payment.amountMicros }] });
      } catch (error) { throw this.liveError(error, '无法刷新 GasFree 账户余额、nonce 与费用。'); }
      if (!check.ready) throw new ServiceError(409, 'PREFLIGHT_BLOCKED', '最新 GasFree 预检未通过，未生成签名授权。', check);
      batch.preflight = check;
      const requiredFee = check.activationFeeMicros + check.transferFeeMicros;
      if (requiredFee > payment.feeMicros) throw new ServiceError(409, 'FEE_CHANGED_RECONFIRM', `最新费用 ${requiredFee} micro-USDT 超过已确认上限 ${payment.feeMicros}；请重新生成和确认清单。`, check);
      let authorization: GasFreeAuthorization;
      try { authorization = this.gasFree.prepareAuthorization(check, payment, { maxFeeMicros: payment.feeMicros, manifestHash: batch.manifestHash }); }
      catch (error) { throw this.liveError(error, '无法生成 GasFree TIP-712 授权。'); }
      if (authorization.manifestHash !== batch.manifestHash || !authorization.operationHash) {
        throw new ServiceError(409, 'EVIDENCE_BINDING_FAILED', '钱包授权未绑定当前结算清单；未发起签名。');
      }
      payment.operationHash = authorization.operationHash;
      payment.requestId = authorization.requestId;
      payment.attempts.push({ id: liveId('attempt'), requestId: authorization.requestId, startedAt: timestamp(), status: 'SUBMITTING', queries: 0, authorization });
      this.event(batch, 'signature_requested', '等待钱包签名', `${payment.payeeName}：${payment.amountMicros} micro-USDT，费用上限 ${payment.feeMicros} micro-USDT。尚未提交给 GasFree。`);
      await this.store.persist();
      return { batch: this.get(id), authorization: structuredClone(authorization) };
    });
  }

  async submitLive(id: string, paymentId: string, requestId: string, signature: string): Promise<Batch> {
    return this.exclusive(async () => {
      const batch = this.find(id);
      this.assertPlan(batch);
      if (batch.mode !== 'live' || !this.gasFree) throw new ServiceError(409, 'LIVE_BATCH_REQUIRED', '该批次不支持 GasFree 真实提交。');
      this.assertHistory(batch.plan.rows.filter(row => row.status === 'VALID'), batch.id);
      const payment = batch.payments.find(candidate => candidate.id === paymentId);
      const attempt = payment?.attempts.at(-1);
      if (!payment || payment.status !== 'QUEUED' || !attempt?.authorization || attempt.status !== 'SUBMITTING'
        || attempt.requestId !== requestId || attempt.authorization.paymentId !== paymentId) {
        throw new ServiceError(409, 'AUTHORIZATION_MISMATCH', '签名与服务端保存的当前付款授权不匹配；未提交。');
      }
      batch.status = 'RUNNING'; delete batch.error;
      this.event(batch, 'submitting', '已接收钱包签名', `${payment.payeeName}：服务端将且只将提交已保存的 request ${requestId}。`);
      await this.store.persist();
      let result: GasFreeTransferResult;
      try { result = await this.gasFree.submitSigned(attempt.authorization, signature); }
      catch (error) {
        batch.status = 'CONFIRMED';
        this.event(batch, 'signature_rejected', '授权未提交', '签名或本地配置未通过提交前检查；已保留原授权。');
        await this.store.persist();
        throw this.liveError(error, 'GasFree 提交前检查失败，未能确认已发送。');
      }
      this.applyLiveResult(batch, payment, result);
      this.updateLiveBatchState(batch);
      await this.store.persist();
      return this.get(id);
    });
  }

  async recover(id: string): Promise<Batch> {
    return this.exclusive(async () => {
      const batch = this.find(id);
      this.assertPlan(batch);
      if (batch.status === 'COMPLETED') return this.get(id);
      if (batch.status !== 'PAUSED') throw new ServiceError(409, 'INVALID_STATE', '仅暂停批次可以查询恢复。');
      if (batch.mode === 'live') {
        if (!this.gasFree) throw new ServiceError(409, 'LIVE_NOT_CONFIGURED', 'GasFree 适配器未配置，未查询外部状态。');
        const unresolved = batch.payments.filter(entry => entry.status === 'PROCESSING' || entry.status === 'UNKNOWN');
        if (!unresolved.length) {
          this.updateLiveBatchState(batch); await this.store.persist(); return this.get(id);
        }
        for (const payment of unresolved) {
          const attempt = payment.attempts.at(-1);
          if (!attempt?.authorization || !attempt.traceId) {
            payment.status = 'UNKNOWN';
            payment.failureCode = payment.failureCode || 'MISSING_TRACE_ID';
            payment.failureReason = payment.failureReason || '未收到 traceId，官方无按 requestId 查询接口；需人工核对，禁止重发。';
            this.event(batch, 'manual_reconciliation', '需人工核对 GasFree 请求', `${payment.payeeName}：request ${attempt?.requestId || payment.requestId || '未知'} 没有 traceId。`);
            continue;
          }
          attempt.queries += 1; attempt.lastQueriedAt = timestamp();
          this.event(batch, 'live_query', '查询原 GasFree trace', `${attempt.traceId}；没有新建授权或再次 submit。`);
          const previous: GasFreeTransferResult = { mode: 'live', network: 'nile', requestId: attempt.requestId,
            traceId: attempt.traceId, txHash: attempt.txHash, status: payment.status === 'PROCESSING' ? 'PROCESSING' : 'UNKNOWN', checkedAt: attempt.lastQueriedAt,
            providerState: payment.providerState as GasFreeTransferResult['providerState'], chainState: payment.chainState as GasFreeTransferResult['chainState'],
            failureCode: payment.failureCode, failureReason: payment.failureReason, verificationSource: payment.chainVerification?.status === 'VERIFIED'
              ? 'gasfree-provider+nile-solidity-rpc' : 'gasfree-provider', chainVerification: payment.chainVerification, retryAction: 'QUERY_ORIGINAL' };
          let result: GasFreeTransferResult;
          try { result = await this.gasFree.recover(attempt.authorization, previous); }
          catch (error) { result = { ...previous, status: 'UNKNOWN', checkedAt: timestamp(), failureCode: 'QUERY_FAILED',
            failureReason: this.liveError(error, '查询未能确认原授权状态。').message, retryAction: 'QUERY_ORIGINAL' }; }
          this.applyLiveResult(batch, payment, result);
          await this.store.persist();
        }
        this.updateLiveBatchState(batch);
        await this.store.persist();
        return this.get(id);
      }
      for (const payment of batch.payments.filter(entry => entry.status === 'UNKNOWN')) {
        const attempt = payment.attempts.at(-1);
        if (!attempt?.traceId || payment.traceId !== attempt.traceId) throw new ServiceError(409, 'MISSING_TRACE', '缺少原始 trace，需人工核查，禁止重付。');
        attempt.queries += 1; attempt.lastQueriedAt = timestamp();
        this.event(batch, 'query', '查询原始 trace', `${attempt.traceId}；没有新增 payment attempt。`);
        await this.store.persist();
        const receipt = this.store.receipts.get(attempt.traceId);
        if (!receipt) throw new ServiceError(409, 'STILL_UNKNOWN', '原 trace 未查得确定结果，保持 UNKNOWN，不重付。');
        this.applyReceipt(batch, payment, receipt);
        await this.store.persist();
      }
      await this.runQueue(batch);
      return this.get(id);
    });
  }
}
