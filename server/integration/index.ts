import { createHash, createHmac, randomUUID } from 'node:crypto';
import gasFreeSdk from '@gasfree/gasfree-sdk';
import { z } from 'zod';
import { canonical, isTronAddress } from '../../shared/plan.js';
import type { GasFreeAuthorization, GasFreePaymentInput, GasFreePreflight, GasFreeTransferResult, GasFreeTypedData, NileChainVerification } from '../../shared/types.js';
import { NILE_CHAIN_ID, NILE_CONTROLLER, validateGasFreeConfig, type GasFreeConfig } from './config.js';
import { operationHash } from '../evidence.js';
export { gasFreeConfigFromEnv, NILE_CHAIN_ID, NILE_CONTROLLER } from './config.js';
export type { GasFreeConfig } from './config.js';

const reasons: Record<string, string> = {
  ProviderAddressNotMatchException: 'GasFree 服务商地址不匹配。',
  DeadlineExceededException: '签名授权已过期，需要重新核对后签名。',
  InvalidSignatureException: '钱包签名未通过 GasFree 校验。',
  UnsupportedTokenException: 'GasFree 当前不支持该代币。',
  TooManyPendingTransferException: '付款账户存在待处理授权，先查询原授权。',
  VersionNotSupportedException: 'GasFree 不支持该授权版本。',
  NonceNotMatchException: '账户 nonce 已变化，需要重新预检和签名。',
  MaxFeeExceededException: '动态费用超过已签名的费用上限。',
  InsufficientBalanceException: 'GasFree 账户可用余额不足。',
};

export class GasFreeError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 502, public readonly definiteRejection = false) {
    super(message); this.name = 'GasFreeError';
  }
}

const address = z.string().refine(isTronAddress);
const uint = z.union([z.string().regex(/^(0|[1-9]\d{0,77})$/), z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)])
  .transform(String).refine(value => BigInt(value) < (1n << 256n));
const safeInt = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const tokenSchema = z.object({ tokenAddress: address, symbol: z.string().min(1).max(20), decimal: z.number().int().min(0).max(36),
  supported: z.boolean(), activateFee: uint, transferFee: uint });
const providerSchema = z.object({ address, name: z.string().max(100), config: z.object({ maxPendingTransfer: safeInt,
  minDeadlineDuration: safeInt, maxDeadlineDuration: safeInt, defaultDeadlineDuration: safeInt }) })
  .refine(p => p.config.minDeadlineDuration > 0 && p.config.maxDeadlineDuration <= 86_400 &&
    p.config.defaultDeadlineDuration >= p.config.minDeadlineDuration && p.config.defaultDeadlineDuration <= p.config.maxDeadlineDuration);
const assetSchema = z.object({ tokenAddress: address, tokenSymbol: z.string().max(20), decimal: z.number().int().min(0).max(36),
  activateFee: uint, transferFee: uint, frozen: uint });
const accountSchema = z.object({ accountAddress: address, gasFreeAddress: address, active: z.boolean(), nonce: uint,
  allowSubmit: z.boolean().optional(), allow_submit: z.boolean().optional(), assets: z.array(assetSchema).max(100) })
  .refine(a => a.allowSubmit !== undefined || a.allow_submit !== undefined)
  .refine(a => a.allowSubmit === undefined || a.allow_submit === undefined || a.allowSubmit === a.allow_submit);
const uuid = z.string().uuid();
const requestIdSchema = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
const transferSchema = z.object({
  id: uuid, accountAddress: address, gasFreeAddress: address, providerAddress: address, targetAddress: address, tokenAddress: address,
  amount: uint, nonce: uint, maxFee: uint.optional(),
  state: z.enum(['WAITING', 'INPROGRESS', 'CONFIRMING', 'SUCCEED', 'FAILED']),
  txnState: z.enum(['INIT', 'NOT_ON_CHAIN', 'ON_CHAIN', 'SOLIDITY', 'ON_CHAIN_FAILED']).nullish(),
  txnHash: z.string().regex(/^(?:0x)?[0-9a-f]{64}$/i).or(z.literal('')).nullish(),
  txnTotalFee: uint.nullish(), txnAmount: uint.nullish(),
});
const chainLogSchema = z.object({ address: z.string().regex(/^(?:41)?[0-9a-f]{40}$/i),
  topics: z.array(z.string().regex(/^[0-9a-f]{64}$/i)).max(16), data: z.string().regex(/^[0-9a-f]*$/i) }).passthrough();
const solidityReceiptSchema = z.object({ id: z.string().regex(/^[0-9a-f]{64}$/i), blockNumber: safeInt,
  blockTimeStamp: safeInt, receipt: z.object({ result: z.string().optional() }).passthrough().optional(),
  result: z.string().optional(), log: z.array(chainLogSchema).max(10_000).optional() }).passthrough();
const solidityTransactionSchema = z.object({ txID: z.string().regex(/^[0-9a-f]{64}$/i),
  ret: z.array(z.object({ contractRet: z.string() }).passthrough()).min(1).max(32) }).passthrough();
const TRANSFER_TOPIC = 'ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
/** Allows minor wall-clock skew without accepting an unrelated old or future transfer. */
const CHAIN_CLOCK_TOLERANCE_MS = 30_000;
// Published 1.1.2 is CommonJS; a named ESM import fails under Node/tsx.
const sdk = new gasFreeSdk.TronGasFree({ chainId: NILE_CHAIN_ID });
const digest = (input: unknown) => createHash('sha256').update(canonical(input)).digest('hex');
const exactNumber = (value: string | bigint): number => {
  const n = BigInt(value);
  if (n < 0n || n > BigInt(Number.MAX_SAFE_INTEGER)) throw new GasFreeError('UNSAFE_AMOUNT', '金额超出本应用可安全表示的范围。', 422);
  return Number(n);
};
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new GasFreeError('INVALID_PROVIDER_RESPONSE', 'GasFree 或 RPC 响应不符合已验证的接口格式。');
  return result.data;
}
function validatePayment(payment: GasFreePaymentInput): void {
  if (!payment || typeof payment.id !== 'string' || payment.id.length < 1 || payment.id.length > 200 ||
      !isTronAddress(payment.address) || !Number.isSafeInteger(payment.amountMicros) || payment.amountMicros <= 0) {
    throw new GasFreeError('INVALID_PAYMENT', '付款地址或金额无效。', 422);
  }
}
function addressParameter(value: string): string {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let n = 0n;
  for (const char of value) n = n * 58n + BigInt(alphabet.indexOf(char));
  return n.toString(16).padStart(50, '0').slice(2, 42).padStart(64, '0');
}
function addressHex(value: string): string { return addressParameter(value).slice(-40).toLowerCase(); }
const normalizeLogAddress = (value: string) => value.toLowerCase().replace(/^41(?=[0-9a-f]{40}$)/, '');
function typedData(parameters: GasFreeTypedData['message']): GasFreeTypedData {
  const assembled = sdk.assembleGasFreeTransactionJson(parameters);
  // All numeric parameters are strings, matching the SDK contract and preserving uint256 precision.
  return { domain: { ...assembled.domain, chainId: NILE_CHAIN_ID }, types: { PermitTransfer: assembled.types.PermitTransfer.map(field => ({ ...field })) },
    message: { ...parameters } };
}

export interface PreflightInput {
  payerAddress: string;
  payments: GasFreePaymentInput[];
  providerAddress?: string;
  tokenAddress?: string;
}
export interface AdapterDependencies { fetch?: typeof globalThis.fetch; now?: () => number }

export function createGasFreeAdapter(rawConfig: GasFreeConfig, dependencies: AdapterDependencies = {}) {
  const config = validateGasFreeConfig(rawConfig);
  const fetcher = dependencies.fetch ?? globalThis.fetch;
  const now = dependencies.now ?? Date.now;
  const submitted = new Map<string, { digest: string; result: Promise<GasFreeTransferResult> }>();
  const time = () => new Date(now()).toISOString();
  const credentials = () => {
    if (!config.apiKey || !config.apiSecret) throw new GasFreeError('GASFREE_NOT_CONFIGURED', '尚未配置 GasFree API Key 和 Secret，不能发起真实请求。', 409);
  };
  async function json(url: string, init: RequestInit): Promise<unknown> {
    let response: Response;
    try { response = await fetcher(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(config.timeoutMs) }); }
    catch { throw new GasFreeError('PROVIDER_UNAVAILABLE', '网络请求未得到可靠结果；未自动重试。'); }
    if (!response.ok) throw new GasFreeError('PROVIDER_HTTP_ERROR', 'GasFree 或 RPC 返回了非成功的 HTTP 状态；未自动重试。');
    try {
      const declaredLength = Number(response.headers.get('content-length'));
      if (declaredLength > 1_000_000) throw new Error();
      const reader = response.body?.getReader();
      if (!reader) throw new Error();
      const chunks: Uint8Array[] = [];
      let length = 0;
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        length += next.value.length;
        if (length > 1_000_000) { await reader.cancel(); throw new Error(); }
        chunks.push(next.value);
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch { throw new GasFreeError('INVALID_PROVIDER_RESPONSE', '服务响应无效或超过大小限制；未自动重试。'); }
  }
  async function provider(method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown> {
    credentials();
    const url = new URL(config.baseUrl + path);
    const timestamp = String(Math.floor(now() / 1000));
    const signature = createHmac('sha256', config.apiSecret).update(method + url.pathname + timestamp).digest('base64');
    const result = parse(z.object({ code: z.number().int(), reason: z.string().nullish(), data: z.unknown().optional() }),
      await json(url.href, { method, headers: { 'Content-Type': 'application/json', Timestamp: timestamp, Authorization: `ApiKey ${config.apiKey}:${signature}` },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
    if (result.code !== 200) {
      const known = result.reason && Object.hasOwn(reasons, result.reason) ? result.reason : undefined;
      throw new GasFreeError(known ?? 'GASFREE_REJECTED', known ? reasons[known] : 'GasFree 未接受该请求。', 502, result.code === 400);
    }
    return result.data;
  }
  async function chainBalance(payerAddress: string, gasFreeAddress: string, tokenAddress: string): Promise<string> {
    const result = parse(z.object({ result: z.object({ result: z.literal(true) }), constant_result: z.tuple([z.string().regex(/^[0-9a-f]{64}$/i)]) }),
      await json(config.rpcUrl + '/wallet/triggerconstantcontract', { method: 'POST', headers: { 'Content-Type': 'application/json',
        ...(config.tronGridApiKey ? { 'TRON-PRO-API-KEY': config.tronGridApiKey } : {}) },
        body: JSON.stringify({ owner_address: payerAddress, contract_address: tokenAddress, function_selector: 'balanceOf(address)',
          parameter: addressParameter(gasFreeAddress), visible: true }) }));
    return BigInt('0x' + result.constant_result[0]).toString();
  }
  async function preflight(input: PreflightInput): Promise<GasFreePreflight> {
    credentials();
    if (!isTronAddress(input.payerAddress) || !Array.isArray(input.payments) || input.payments.length === 0 || input.payments.length > 500) {
      throw new GasFreeError('INVALID_PREFLIGHT', '请提供付款人 EOA 地址及 1–500 笔付款。', 422);
    }
    input.payments.forEach(validatePayment);
    if (new Set(input.payments.map(payment => payment.id)).size !== input.payments.length) throw new GasFreeError('INVALID_PREFLIGHT', '付款编号不能重复。', 422);
    const [tokenResponse, providerResponse, accountResponse] = await Promise.all([
      provider('GET', '/api/v1/config/token/all'), provider('GET', '/api/v1/config/provider/all'),
      provider('GET', `/api/v1/address/${input.payerAddress}`),
    ]);
    const tokens = parse(z.object({ tokens: z.array(tokenSchema).max(100) }), tokenResponse).tokens;
    const providers = parse(z.object({ providers: z.array(providerSchema).min(1).max(100) }), providerResponse).providers;
    const account = parse(accountSchema, accountResponse);
    if (account.accountAddress !== input.payerAddress || account.gasFreeAddress !== sdk.generateGasFreeAddress(input.payerAddress)) {
      throw new GasFreeError('ACCOUNT_MISMATCH', 'GasFree 返回的 EOA 或派生账户与所选钱包不一致。');
    }
    const supportedTokens = tokens.filter(token => token.supported);
    const eligible = supportedTokens.filter(token => token.symbol === 'USDT' && token.decimal === 6 && (!input.tokenAddress || token.tokenAddress === input.tokenAddress));
    if (eligible.length !== 1) throw new GasFreeError('UNSUPPORTED_TOKEN', '请选择一个当前支持的 6 位精度 USDT 合约。', 422);
    const selectedToken = eligible[0];
    const selectedProvider = input.providerAddress ? providers.find(p => p.address === input.providerAddress) : providers.length === 1 ? providers[0] : undefined;
    if (!selectedProvider) throw new GasFreeError('PROVIDER_SELECTION_REQUIRED', '请从当前 GasFree 服务商列表中明确选择一家。', 422);
    const assets = account.assets.filter(asset => asset.tokenAddress === selectedToken.tokenAddress);
    if (assets.length !== 1 || assets[0].decimal !== 6 || assets[0].tokenSymbol !== 'USDT') {
      throw new GasFreeError('ACCOUNT_ASSET_UNAVAILABLE', '缺少该代币的账户费用或冻结金额，不能猜测可用余额。');
    }
    const asset = assets[0];
    const balanceMicros = await chainBalance(account.accountAddress, account.gasFreeAddress, selectedToken.tokenAddress);
    const frozenMicros = asset.frozen;
    const available = BigInt(balanceMicros) > BigInt(frozenMicros) ? BigInt(balanceMicros) - BigInt(frozenMicros) : 0n;
    const principalMicros = exactNumber(input.payments.reduce((sum, payment) => sum + BigInt(payment.amountMicros), 0n));
    const activationFeeMicros = account.active ? 0 : exactNumber(asset.activateFee);
    const transferFeeMicros = exactNumber(asset.transferFee);
    const estimatedFeeMicros = exactNumber(BigInt(activationFeeMicros) + BigInt(transferFeeMicros) * BigInt(input.payments.length));
    const totalDebitMicros = exactNumber(BigInt(principalMicros) + BigInt(estimatedFeeMicros));
    const allowSubmit = account.allowSubmit ?? account.allow_submit!;
    const sufficientBalance = available >= BigInt(totalDebitMicros);
    const blockers: GasFreePreflight['blockers'] = [];
    if (!allowSubmit) blockers.push({ code: 'PENDING_LIMIT', message: '账户暂不允许提交新授权；先查询已有付款。' });
    if (selectedProvider.config.maxPendingTransfer < 1) blockers.push({ code: 'PROVIDER_PAUSED', message: '当前服务商不接受待处理授权。' });
    if (!sufficientBalance) blockers.push({ code: 'INSUFFICIENT_BALANCE', message: 'GasFree 账户余额减去冻结金额后，不足以支付本批本金及动态费用。' });
    return { mode: 'live', network: 'nile', chainId: NILE_CHAIN_ID, checkedAt: time(), payerAddress: account.accountAddress,
      gasFreeAddress: account.gasFreeAddress, active: account.active, nonce: account.nonce, allowSubmit,
      supportedTokens, providers, selectedToken, selectedProvider, balanceMicros, frozenMicros, availableMicros: available.toString(),
      principalMicros, activationFeeMicros, transferFeeMicros, estimatedFeeMicros, totalDebitMicros, sufficientBalance,
      ready: blockers.length === 0, blockers, payments: input.payments.map(p => ({ id: p.id, address: p.address, amountMicros: p.amountMicros })) };
  }
  function prepareAuthorization(check: GasFreePreflight, payment: GasFreePaymentInput,
    options: { requestId?: string; maxFeeMicros?: number; manifestHash?: string } = {}): GasFreeAuthorization {
    credentials();
    validatePayment(payment);
    if (!check.ready || check.network !== 'nile' || check.chainId !== NILE_CHAIN_ID) throw new GasFreeError('PREFLIGHT_BLOCKED', '预检未通过，不能生成签名授权。', 409);
    const age = now() - Date.parse(check.checkedAt);
    if (!Number.isFinite(age) || age < 0 || age > 30_000) throw new GasFreeError('PREFLIGHT_EXPIRED', '预检已过期，请重新获取 nonce、余额和费用。', 409);
    // Only prepare the next payment; the next nonce must be read again after its predecessor resolves.
    if (canonical(check.payments[0]) !== canonical(payment)) throw new GasFreeError('PAYMENT_MISMATCH', '只能为预检中的下一笔付款生成授权。', 409);
    const requiredFee = check.activationFeeMicros + check.transferFeeMicros;
    const maxFee = options.maxFeeMicros ?? requiredFee;
    if (!Number.isSafeInteger(maxFee) || maxFee < requiredFee || BigInt(payment.amountMicros) + BigInt(maxFee) > BigInt(check.availableMicros)) {
      throw new GasFreeError('INVALID_MAX_FEE', '签名费用上限低于预估费用或超过可用余额。', 422);
    }
    const requestId = options.requestId ?? randomUUID();
    if (!requestIdSchema.safeParse(requestId).success) throw new GasFreeError('INVALID_REQUEST_ID', 'GasFree requestId 必须是 UUID v4。', 422);
    if (options.manifestHash !== undefined && !/^[a-f0-9]{64}$/.test(options.manifestHash)) {
      throw new GasFreeError('INVALID_MANIFEST_HASH', '结算清单摘要无效，不能生成签名授权。', 409);
    }
    const typed = typedData({ token: check.selectedToken.tokenAddress, serviceProvider: check.selectedProvider.address, user: check.payerAddress,
        receiver: payment.address, value: String(payment.amountMicros), maxFee: String(maxFee), deadline: String(Math.floor(now() / 1000) + check.selectedProvider.config.defaultDeadlineDuration),
        version: '1', nonce: check.nonce });
    const evidence = options.manifestHash ? { manifestHash: options.manifestHash,
      operationHash: operationHash(options.manifestHash, { id: payment.id, address: payment.address, amountMicros: payment.amountMicros },
        { token: typed.message.token, user: typed.message.user, gasFreeAddress: check.gasFreeAddress,
          serviceProvider: typed.message.serviceProvider, maxFee: typed.message.maxFee, deadline: typed.message.deadline,
          version: typed.message.version, nonce: typed.message.nonce }) } : {};
    const payload = { id: randomUUID(), requestId, paymentId: payment.id, network: 'nile' as const, gasFreeAddress: check.gasFreeAddress, createdAt: time(),
      typedData: typed, ...evidence };
    return { ...payload, digest: digest(payload) };
  }
  function validateAuthorization(authorization: GasFreeAuthorization): void {
    const { digest: expected, ...payload } = authorization;
    const msg = authorization?.typedData?.message;
    const createdAtMs = Date.parse(authorization?.createdAt || ''), deadlineMs = Number(msg?.deadline) * 1000;
    if (!msg || authorization.network !== 'nile' || !uuid.safeParse(authorization.id).success || !requestIdSchema.safeParse(authorization.requestId).success ||
        !isTronAddress(authorization.gasFreeAddress) || expected !== digest(payload) ||
        ![msg.token, msg.serviceProvider, msg.user, msg.receiver].every(isTronAddress) ||
        ![msg.value, msg.maxFee, msg.deadline, msg.version, msg.nonce].every(v => uint.safeParse(v).success) || msg.version !== '1' || BigInt(msg.value) <= 0n ||
        !Number.isFinite(createdAtMs) || !Number.isSafeInteger(deadlineMs) || createdAtMs > deadlineMs ||
        canonical(authorization.typedData) !== canonical(typedData(msg)) || authorization.typedData.domain.verifyingContract !== NILE_CONTROLLER ||
        ((authorization.manifestHash === undefined) !== (authorization.operationHash === undefined)) ||
        (authorization.manifestHash !== undefined && (!/^[a-f0-9]{64}$/.test(authorization.manifestHash) ||
          authorization.operationHash !== operationHash(authorization.manifestHash,
            { id: authorization.paymentId, address: msg.receiver, amountMicros: exactNumber(msg.value) },
            { token: msg.token, user: msg.user, gasFreeAddress: authorization.gasFreeAddress,
              serviceProvider: msg.serviceProvider, maxFee: msg.maxFee, deadline: msg.deadline, version: msg.version, nonce: msg.nonce })))) {
      throw new GasFreeError('INVALID_AUTHORIZATION', '授权内容或摘要不匹配；请重新核对付款。', 409);
    }
  }
  const baseResult = (authorization: GasFreeAuthorization): Pick<GasFreeTransferResult, 'mode' | 'network' | 'requestId' | 'checkedAt' | 'verificationSource'> =>
    ({ mode: 'live', network: 'nile', requestId: authorization.requestId, checkedAt: time(), verificationSource: 'gasfree-provider' });
  function uncertain(authorization: GasFreeAuthorization, code: string, message: string, traceId?: string): GasFreeTransferResult {
    return { ...baseResult(authorization), status: 'UNKNOWN', ...(traceId ? { traceId } : {}), failureCode: code, failureReason: message,
      retryAction: traceId ? 'QUERY_ORIGINAL' : 'MANUAL_RECONCILIATION' };
  }
  function transfer(authorization: GasFreeAuthorization, data: unknown, expectedTraceId?: string): GasFreeTransferResult {
    // Save a valid trace even when other fields are malformed, so a future recovery can query it.
    const candidate = data && typeof data === 'object' && 'id' in data && uuid.safeParse(data.id).success ? String(data.id) : undefined;
    let receipt: z.infer<typeof transferSchema>;
    try { receipt = parse(transferSchema, data); }
    catch { return uncertain(authorization, 'INVALID_TRANSFER_RESPONSE', '授权状态响应不完整；不能宣称付款成功。', expectedTraceId || candidate); }
    const msg = authorization.typedData.message;
    if ((expectedTraceId && receipt.id !== expectedTraceId) || receipt.accountAddress !== msg.user || receipt.gasFreeAddress !== authorization.gasFreeAddress ||
        receipt.providerAddress !== msg.serviceProvider || receipt.targetAddress !== msg.receiver || receipt.tokenAddress !== msg.token ||
        receipt.amount !== msg.value || receipt.nonce !== msg.nonce || (receipt.maxFee !== undefined && receipt.maxFee !== msg.maxFee)) {
      return uncertain(authorization, 'TRANSFER_MISMATCH', '状态响应与原授权的付款人、收款人、金额或 nonce 不匹配。', expectedTraceId || candidate);
    }
    const fields = { ...baseResult(authorization), traceId: receipt.id, providerState: receipt.state,
      ...(receipt.txnState ? { chainState: receipt.txnState } : {}), ...(receipt.txnHash ? { txHash: receipt.txnHash.replace(/^0x/, '').toLowerCase() } : {}) };
    if (receipt.state === 'FAILED' || receipt.txnState === 'ON_CHAIN_FAILED') {
      // A failure combined with reported transferred funds is not safe to repay.
      if ((receipt.state === 'FAILED' && receipt.txnState === 'SOLIDITY') || receipt.state === 'SUCCEED' ||
          (receipt.txnAmount != null && BigInt(receipt.txnAmount) > 0n)) {
        return { ...uncertain(authorization, 'INCONSISTENT_FAILURE', '失败标记与链状态或实际转出金额冲突，必须先人工对账。', receipt.id),
          ...(fields.txHash ? { txHash: fields.txHash } : {}), providerState: receipt.state, ...(receipt.txnState ? { chainState: receipt.txnState } : {}) };
      }
      return { ...fields, status: 'FAILED',
        failureCode: receipt.txnState === 'ON_CHAIN_FAILED' ? 'ON_CHAIN_FAILED' : 'PROVIDER_FAILED',
        failureReason: 'GasFree 报告该授权失败；保留原 requestId、traceId 和可用链哈希，重新付款需独立复核和新授权。', retryAction: 'NEW_AUTHORIZATION_REQUIRED',
        ...(receipt.txnTotalFee != null && BigInt(receipt.txnTotalFee) <= BigInt(msg.maxFee) ? { actualFeeMicros: exactNumber(receipt.txnTotalFee) } : {}) };
    }
    if (receipt.state === 'SUCCEED' && receipt.txnState === 'SOLIDITY' && receipt.txnHash) {
      if (receipt.txnAmount !== undefined && receipt.txnAmount !== null && receipt.txnAmount !== msg.value) {
        return uncertain(authorization, 'ACTUAL_AMOUNT_MISMATCH', '链上实际转出金额与授权不一致，需要人工对账。', receipt.id);
      }
      if (receipt.txnTotalFee !== undefined && receipt.txnTotalFee !== null && BigInt(receipt.txnTotalFee) > BigInt(msg.maxFee)) {
        return uncertain(authorization, 'ACTUAL_FEE_MISMATCH', '实际费用超过已授权上限，需要人工对账。', receipt.id);
      }
      return { ...fields, status: 'CONFIRMED', retryAction: 'NONE',
        ...(receipt.txnTotalFee !== undefined && receipt.txnTotalFee !== null ? { actualFeeMicros: exactNumber(receipt.txnTotalFee) } : {}),
        ...(receipt.txnAmount !== undefined && receipt.txnAmount !== null ? { actualAmountMicros: exactNumber(receipt.txnAmount) } : {}) };
    }
    return { ...fields, status: 'PROCESSING', retryAction: 'QUERY_ORIGINAL' };
  }

  async function verifySolidifiedTransfer(authorization: GasFreeAuthorization, txHash: string): Promise<NileChainVerification> {
    const msg = authorization.typedData.message;
    const base = { network: 'nile' as const, source: 'nile-solidity-rpc' as const, checkedAt: time(), txHash,
      explorerUrl: `https://nile.tronscan.org/#/transaction/${txHash}`, tokenAddress: msg.token,
      fromAddress: authorization.gasFreeAddress, receiverAddress: msg.receiver, amountMicros: msg.value,
      ...(authorization.manifestHash ? { manifestHash: authorization.manifestHash } : {}),
      ...(authorization.operationHash ? { operationHash: authorization.operationHash } : {}) };
    let rawInfo: unknown, rawTransaction: unknown;
    try {
      const request = (path: string) => json(config.rpcUrl + path, { method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(config.tronGridApiKey ? { 'TRON-PRO-API-KEY': config.tronGridApiKey } : {}) },
        body: JSON.stringify({ value: txHash }) });
      [rawInfo, rawTransaction] = await Promise.all([
        request('/walletsolidity/gettransactioninfobyid'), request('/walletsolidity/gettransactionbyid'),
      ]);
    } catch {
      return { ...base, status: 'UNAVAILABLE', message: 'Nile Solidity RPC 暂时不可用；保留原 trace，稍后重查。' };
    }
    const empty = (value: unknown) => value && typeof value === 'object' && Object.keys(value).length === 0;
    if (empty(rawInfo) || empty(rawTransaction)) {
      return { ...base, status: 'PENDING', message: 'Nile Solidity RPC 尚未返回固化回执；保留原 trace，稍后重查。' };
    }
    const parsedInfo = solidityReceiptSchema.safeParse(rawInfo), parsedTransaction = solidityTransactionSchema.safeParse(rawTransaction);
    if (!parsedInfo.success || !parsedTransaction.success) return { ...base, status: 'MISMATCH', message: 'Nile Solidity RPC 的交易正文或回执结构异常，不能把付款标记为已核验。' };
    const receipt = parsedInfo.data, transaction = parsedTransaction.data;
    if (receipt.id.toLowerCase() !== txHash.toLowerCase() || transaction.txID.toLowerCase() !== txHash.toLowerCase() ||
        transaction.ret[0].contractRet !== 'SUCCESS' || receipt.receipt?.result !== 'SUCCESS') {
      return { ...base, status: 'MISMATCH', blockNumber: receipt.blockNumber, blockTimestamp: receipt.blockTimeStamp,
        message: '固化交易正文、交易哈希或执行结果与 GasFree 成功记录不一致。' };
    }
    const authorizationStart = Date.parse(authorization.createdAt);
    const authorizationEnd = Number(msg.deadline) * 1000;
    if (!Number.isSafeInteger(authorizationEnd) || receipt.blockTimeStamp < authorizationStart - CHAIN_CLOCK_TOLERANCE_MS ||
        receipt.blockTimeStamp > authorizationEnd + CHAIN_CLOCK_TOLERANCE_MS) {
      return { ...base, status: 'MISMATCH', blockNumber: receipt.blockNumber, blockTimestamp: receipt.blockTimeStamp,
        message: '固化区块时间不在该授权的创建时间至 deadline 窗口内（允许前后 30 秒链时钟偏差）。' };
    }
    const expectedToken = addressHex(msg.token), expectedFrom = addressHex(authorization.gasFreeAddress), expectedReceiver = addressHex(msg.receiver);
    const index = (receipt.log || []).findIndex(log => normalizeLogAddress(log.address) === expectedToken &&
      log.topics.length >= 3 && log.topics[0].toLowerCase() === TRANSFER_TOPIC &&
      log.topics[1].slice(-40).toLowerCase() === expectedFrom && log.topics[2].slice(-40).toLowerCase() === expectedReceiver &&
      log.data.length === 64 && BigInt('0x' + log.data) === BigInt(msg.value));
    if (index < 0) return { ...base, status: 'MISMATCH', blockNumber: receipt.blockNumber, blockTimestamp: receipt.blockTimeStamp,
      message: '固化回执中未找到与代币、GasFree 账户、收款人和金额完全一致的 TRC-20 Transfer 日志。' };
    return { ...base, status: 'VERIFIED', blockNumber: receipt.blockNumber, blockTimestamp: receipt.blockTimeStamp,
      transferLogIndex: index, message: 'Nile 固化交易正文、成功回执、授权时间窗口与 USDT Transfer 日志已独立核验。' };
  }

  async function withChainVerification(authorization: GasFreeAuthorization, result: GasFreeTransferResult): Promise<GasFreeTransferResult> {
    if (result.status !== 'CONFIRMED' || !result.txHash) return result;
    const chainVerification = await verifySolidifiedTransfer(authorization, result.txHash);
    if (chainVerification.status === 'VERIFIED') return { ...result, chainVerification,
      verificationSource: 'gasfree-provider+nile-solidity-rpc' };
    return { ...result, status: chainVerification.status === 'MISMATCH' ? 'UNKNOWN' : 'PROCESSING', chainVerification,
      failureCode: `CHAIN_${chainVerification.status}`, failureReason: chainVerification.message, retryAction: 'QUERY_ORIGINAL' };
  }
  async function query(authorization: GasFreeAuthorization, traceId: string): Promise<GasFreeTransferResult> {
    credentials();
    validateAuthorization(authorization);
    if (!uuid.safeParse(traceId).success) throw new GasFreeError('INVALID_TRACE_ID', 'GasFree traceId 必须是有效 UUID，不能使用模拟编号。', 422);
    try { return withChainVerification(authorization, transfer(authorization, await provider('GET', `/api/v1/gasfree/${traceId}`), traceId)); }
    catch (error) { return uncertain(authorization, error instanceof GasFreeError ? error.code : 'QUERY_FAILED', '本次查询未能可靠确认原授权状态；未发起新付款。', traceId); }
  }
  async function recover(authorization: GasFreeAuthorization, previous: GasFreeTransferResult): Promise<GasFreeTransferResult> {
    validateAuthorization(authorization);
    if (previous.requestId !== authorization.requestId || previous.mode !== 'live' || previous.network !== 'nile') {
      throw new GasFreeError('RECOVERY_MISMATCH', '只能恢复原付款授权。', 409);
    }
    if (previous.status === 'CONFIRMED' || previous.status === 'FAILED') return structuredClone(previous);
    if (!previous.traceId) return uncertain(authorization, 'MISSING_TRACE_ID', '提交结果未知且未收到 traceId。官方未提供按 requestId 查询接口；需人工向服务商核对，禁止直接重发。');
    return query(authorization, previous.traceId);
  }
  async function send(authorization: GasFreeAuthorization, signature: string): Promise<GasFreeTransferResult> {
    const msg = authorization.typedData.message;
    // Fresh account/fees immediately before POST; rejection here is definite because nothing was submitted.
    try {
      const check = await preflight({ payerAddress: msg.user, tokenAddress: msg.token, providerAddress: msg.serviceProvider,
        payments: [{ id: authorization.paymentId, address: msg.receiver, amountMicros: exactNumber(msg.value) }] });
      if (!check.ready || check.nonce !== msg.nonce || check.gasFreeAddress !== authorization.gasFreeAddress ||
          BigInt(check.activationFeeMicros + check.transferFeeMicros) > BigInt(msg.maxFee) ||
          BigInt(msg.value) + BigInt(msg.maxFee) > BigInt(check.availableMicros)) {
        throw new GasFreeError('PREFLIGHT_CHANGED', '余额、nonce、待处理状态或费用已变化；没有提交授权。', 409);
      }
      const remaining = BigInt(msg.deadline) - BigInt(Math.floor(now() / 1000));
      if (remaining < BigInt(check.selectedProvider.config.minDeadlineDuration) || remaining > BigInt(check.selectedProvider.config.maxDeadlineDuration)) {
        throw new GasFreeError('AUTHORIZATION_EXPIRED', '授权剩余有效期不符合服务商要求；没有提交授权。', 409);
      }
    } catch (error) {
      return { ...baseResult(authorization), status: 'FAILED', failureCode: error instanceof GasFreeError ? error.code : 'PRECHECK_FAILED',
        failureReason: error instanceof GasFreeError ? error.message : '提交前预检失败，没有发送付款授权。', retryAction: 'NEW_AUTHORIZATION_REQUIRED' };
    }
    try { return withChainVerification(authorization, transfer(authorization, await provider('POST', '/api/v1/gasfree/submit', { requestId: authorization.requestId, ...msg, sig: signature }))); }
    catch (error) {
      if (error instanceof GasFreeError && error.definiteRejection) return { ...baseResult(authorization), status: 'FAILED',
        failureCode: error.code, failureReason: error.message, retryAction: 'NEW_AUTHORIZATION_REQUIRED' };
      return uncertain(authorization, 'SUBMISSION_UNKNOWN', '提交请求未获得可靠结果，可能已被受理；禁止重复发送，先核对原请求。');
    }
  }
  async function submitSigned(authorization: GasFreeAuthorization, signature: string, previous?: GasFreeTransferResult): Promise<GasFreeTransferResult> {
    credentials();
    if (!config.enabled) throw new GasFreeError('GASFREE_LIVE_DISABLED', '真实提交尚未启用，需要 ENABLE_GASFREE_LIVE=true。', 409);
    validateAuthorization(authorization);
    if (previous) return recover(authorization, previous);
    const existing = submitted.get(authorization.requestId);
    if (existing) {
      if (existing.digest !== authorization.digest) throw new GasFreeError('REQUEST_ID_REUSED', '同一 requestId 不能用于另一份授权。', 409);
      return recover(authorization, await existing.result);
    }
    const normalized = typeof signature === 'string' ? signature.replace(/^0x/, '') : '';
    if (!/^[0-9a-f]{130}$/i.test(normalized)) throw new GasFreeError('INVALID_SIGNATURE', '钱包签名必须是 65 字节十六进制字符串。', 422);
    if (submitted.size >= 10_000) throw new GasFreeError('ADAPTER_CAPACITY', '本服务会话的提交数已达到上限，请保留历史后重启。', 409);
    // Added synchronously before the first await: simultaneous clicks cannot double-POST.
    const result = send(authorization, normalized);
    submitted.set(authorization.requestId, { digest: authorization.digest, result });
    return result;
  }
  return { preflight, prepareAuthorization, submitSigned, query, recover };
}

export type GasFreeAdapter = ReturnType<typeof createGasFreeAdapter>;
