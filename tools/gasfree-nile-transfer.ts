import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rename, writeFile, chmod } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Trx, TronWeb } from 'tronweb';
import { isTronAddress } from '../shared/plan.js';
import type {
  GasFreeAuthorization,
  GasFreePreflight,
  GasFreeTransferResult,
  GasFreeTypedData,
} from '../shared/types.js';
import {
  createGasFreeAdapter,
  gasFreeConfigFromEnv,
  NILE_CHAIN_ID,
  NILE_CONTROLLER,
  type GasFreeAdapter,
} from '../server/integration/index.js';

export const BROADCAST_CONFIRMATION = 'BROADCAST_ONE_NILE_GASFREE_TRANSFER';
const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url));
const SUBMIT_PATH = '/nile/api/v1/gasfree/submit';
const MAX_POLL_SECONDS = 300;

export class GasFreeCliError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'GasFreeCliError';
  }
}

export interface OneShotOptions {
  payerAddress: string;
  receiverAddress: string;
  amountMicros: number;
  intentId: string;
  providerAddress?: string;
  tokenAddress?: string;
  signerKeyFile?: string;
  evidenceFile?: string;
  broadcast: boolean;
  confirmation?: string;
  pollSeconds: number;
}

export interface RecoverOptions {
  recoverIntentId: string;
  evidenceFile?: string;
  pollSeconds: number;
}

export interface OneShotEvidence {
  schemaVersion: 'settlemap.gasfree-nile-evidence.v1';
  generatedAt: string;
  intentId: string;
  network: 'nile';
  providerApi: 'https://open-test.gasfree.io/nile';
  solidityRpc: 'https://nile.trongrid.io';
  mode: 'PREFLIGHT_ONLY' | 'SUBMISSION_ARMED' | 'BROADCAST_ATTEMPTED';
  claim: string;
  preflight: {
    checkedAt: string;
    ready: boolean;
    blockers: { code: string; message: string }[];
    payerAddress: string;
    gasFreeAddress: string;
    receiverAddress: string;
    tokenAddress: string;
    providerAddress: string;
    amountMicros: string;
    balanceMicros: string;
    frozenMicros: string;
    availableMicros: string;
    activationFeeMicros: string;
    transferFeeMicros: string;
    maximumDebitMicros: string;
    nonce: string;
  };
  authorization?: {
    requestId: string;
    digest: string;
    createdAt: string;
    deadline: string;
  };
  result?: GasFreeTransferResult;
  exactTransferVerified: boolean;
  broadcastPostCount: number;
}

interface Journal {
  schemaVersion: 'settlemap.gasfree-nile-journal.v1';
  intentId: string;
  phase: 'BROADCASTING' | 'SUBMITTED' | 'FINISHED' | 'ERROR_AFTER_LOCK';
  updatedAt: string;
  evidenceFile: string;
  preflight: GasFreePreflight;
  authorization: GasFreeAuthorization;
  result?: GasFreeTransferResult;
  broadcastPostCount: number;
}

export interface OneShotDependencies {
  adapter: GasFreeAdapter;
  signTypedData: (typedData: GasFreeTypedData, payerAddress: string) => Promise<string>;
  dataDir?: string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  broadcastPostCount?: () => number;
}

export type RecoveryDependencies = Pick<OneShotDependencies, 'adapter' | 'dataDir' | 'now' | 'sleep'>;

function safeInteger(value: string | undefined, name: string, minimum: number, maximum: number): number {
  if (!value || !/^(0|[1-9]\d*)$/.test(value)) throw new GasFreeCliError('INVALID_ARGUMENT', `${name} must be a base-10 integer.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new GasFreeCliError('INVALID_ARGUMENT', `${name} is outside the supported range.`);
  }
  return parsed;
}

function optionMap(argv: string[]): Map<string, string | true> {
  const result = new Map<string, string | true>();
  const valueOptions = new Set([
    '--payer', '--receiver', '--amount-micros', '--intent', '--provider', '--token',
    '--signer-key-file', '--evidence', '--confirm-broadcast', '--poll-seconds', '--recover-intent',
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === '--broadcast' || item === '--help') {
      if (result.has(item)) throw new GasFreeCliError('INVALID_ARGUMENT', `Duplicate option: ${item}`);
      result.set(item, true);
      continue;
    }
    if (!valueOptions.has(item)) throw new GasFreeCliError('INVALID_ARGUMENT', `Unknown option: ${item}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new GasFreeCliError('INVALID_ARGUMENT', `Missing value for ${item}.`);
    if (result.has(item)) throw new GasFreeCliError('INVALID_ARGUMENT', `Duplicate option: ${item}`);
    result.set(item, value);
    index += 1;
  }
  return result;
}

function stringOption(options: Map<string, string | true>, flag: string, envValue?: string): string | undefined {
  const value = options.get(flag);
  return (typeof value === 'string' ? value : envValue)?.trim() || undefined;
}

export function parseOneShotOptions(argv: string[], env: NodeJS.ProcessEnv = process.env): OneShotOptions | RecoverOptions | { help: true } {
  const values = optionMap(argv);
  if (values.has('--help')) {
    if (values.size !== 1) throw new GasFreeCliError('INVALID_ARGUMENT', '--help cannot be combined with transfer options.');
    return { help: true };
  }
  const recoverIntentId = stringOption(values, '--recover-intent');
  if (recoverIntentId) {
    const allowed = new Set(['--recover-intent', '--evidence', '--poll-seconds']);
    if ([...values.keys()].some(key => !allowed.has(key))) {
      throw new GasFreeCliError('INVALID_ARGUMENT', '--recover-intent cannot be combined with signing, transfer, or broadcast options.');
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(recoverIntentId)) {
      throw new GasFreeCliError('INVALID_ARGUMENT', '--recover-intent must name a prior 1-64 character intent.');
    }
    return { recoverIntentId, evidenceFile: stringOption(values, '--evidence', env.GASFREE_EVIDENCE_FILE),
      pollSeconds: safeInteger(stringOption(values, '--poll-seconds', env.GASFREE_POLL_SECONDS) || '120', '--poll-seconds', 0, MAX_POLL_SECONDS) };
  }
  const payerAddress = stringOption(values, '--payer', env.GASFREE_PAYER_ADDRESS);
  const receiverAddress = stringOption(values, '--receiver', env.GASFREE_RECEIVER_ADDRESS);
  const amount = stringOption(values, '--amount-micros', env.GASFREE_AMOUNT_MICROS);
  const intentId = stringOption(values, '--intent', env.GASFREE_INTENT_ID);
  if (!payerAddress || !isTronAddress(payerAddress)) throw new GasFreeCliError('INVALID_ARGUMENT', 'A valid --payer Nile EOA is required.');
  if (!receiverAddress || !isTronAddress(receiverAddress)) throw new GasFreeCliError('INVALID_ARGUMENT', 'A valid --receiver TRON address is required.');
  if (!intentId || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(intentId)) {
    throw new GasFreeCliError('INVALID_ARGUMENT', '--intent must be a unique 1-64 character identifier.');
  }
  const providerAddress = stringOption(values, '--provider', env.GASFREE_PROVIDER_ADDRESS);
  const tokenAddress = stringOption(values, '--token', env.GASFREE_TOKEN_ADDRESS);
  if (providerAddress && !isTronAddress(providerAddress)) throw new GasFreeCliError('INVALID_ARGUMENT', '--provider is not a valid TRON address.');
  if (tokenAddress && !isTronAddress(tokenAddress)) throw new GasFreeCliError('INVALID_ARGUMENT', '--token is not a valid TRON address.');
  const pollValue = stringOption(values, '--poll-seconds', env.GASFREE_POLL_SECONDS) || '120';
  return {
    payerAddress,
    receiverAddress,
    amountMicros: safeInteger(amount, '--amount-micros', 1, Number.MAX_SAFE_INTEGER),
    intentId,
    providerAddress,
    tokenAddress,
    signerKeyFile: stringOption(values, '--signer-key-file', env.GASFREE_SIGNER_KEY_FILE),
    evidenceFile: stringOption(values, '--evidence', env.GASFREE_EVIDENCE_FILE),
    broadcast: values.has('--broadcast'),
    confirmation: stringOption(values, '--confirm-broadcast'),
    pollSeconds: safeInteger(pollValue, '--poll-seconds', 0, MAX_POLL_SECONDS),
  };
}

function resolveFromProject(value: string): string {
  return path.isAbsolute(value) ? value : path.resolve(PROJECT_ROOT, value);
}

async function exists(file: string): Promise<boolean> {
  try { await lstat(file); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function writePrivateJson(file: string, value: unknown): Promise<void> {
  const directory = path.dirname(file);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(directory, `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  await rename(temporary, file);
  await chmod(file, 0o600);
}

async function createPrivateJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  try {
    await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new GasFreeCliError('INTENT_ALREADY_LOCKED', 'This intent already has a durable broadcast journal; recover or reconcile it instead of submitting again.');
    }
    throw error;
  }
}

function evidenceFor(
  options: OneShotOptions,
  preflight: GasFreePreflight,
  authorization: GasFreeAuthorization | undefined,
  result: GasFreeTransferResult | undefined,
  now: () => number,
  broadcastPostCount: number,
): OneShotEvidence {
  const exactTransferVerified = result?.status === 'CONFIRMED' &&
    result.providerState === 'SUCCEED' && result.chainState === 'SOLIDITY' &&
    typeof result.txHash === 'string' && /^(?:0x)?[0-9a-f]{64}$/i.test(result.txHash) &&
    result.verificationSource === 'gasfree-provider+nile-solidity-rpc' &&
    result.chainVerification?.status === 'VERIFIED' &&
    result.chainVerification.txHash.replace(/^0x/i, '').toLowerCase() === result.txHash.replace(/^0x/i, '').toLowerCase() &&
    result.chainVerification.tokenAddress === preflight.selectedToken.tokenAddress &&
    result.chainVerification.fromAddress === preflight.gasFreeAddress &&
    result.chainVerification.receiverAddress === options.receiverAddress &&
    result.chainVerification.amountMicros === String(options.amountMicros);
  return {
    schemaVersion: 'settlemap.gasfree-nile-evidence.v1',
    generatedAt: new Date(now()).toISOString(),
    intentId: options.intentId,
    network: 'nile',
    providerApi: 'https://open-test.gasfree.io/nile',
    solidityRpc: 'https://nile.trongrid.io',
    mode: broadcastPostCount > 0 ? 'BROADCAST_ATTEMPTED' : authorization ? 'SUBMISSION_ARMED' : 'PREFLIGHT_ONLY',
    claim: exactTransferVerified
      ? 'GasFree provider result and Nile Solidity RPC independently verified the exact TRC-20 Transfer.'
      : broadcastPostCount > 0
        ? 'No verified transfer claim: inspect result and recovery action before any new authorization.'
        : authorization
          ? 'No provider submit POST was observed; this intent remains locked and must not be reused.'
        : 'Read-only preflight only; no signature was created and no transfer was submitted.',
    preflight: {
      checkedAt: preflight.checkedAt,
      ready: preflight.ready,
      blockers: preflight.blockers.map(blocker => ({ ...blocker })),
      payerAddress: preflight.payerAddress,
      gasFreeAddress: preflight.gasFreeAddress,
      receiverAddress: options.receiverAddress,
      tokenAddress: preflight.selectedToken.tokenAddress,
      providerAddress: preflight.selectedProvider.address,
      amountMicros: String(options.amountMicros),
      balanceMicros: preflight.balanceMicros,
      frozenMicros: preflight.frozenMicros,
      availableMicros: preflight.availableMicros,
      activationFeeMicros: String(preflight.activationFeeMicros),
      transferFeeMicros: String(preflight.transferFeeMicros),
      maximumDebitMicros: String(preflight.totalDebitMicros),
      nonce: preflight.nonce,
    },
    ...(authorization ? { authorization: { requestId: authorization.requestId, digest: authorization.digest,
      createdAt: authorization.createdAt, deadline: authorization.typedData.message.deadline } } : {}),
    ...(result ? { result: structuredClone(result) } : {}),
    exactTransferVerified,
    broadcastPostCount,
  };
}

function journalFor(options: OneShotOptions, evidenceFile: string, preflight: GasFreePreflight, authorization: GasFreeAuthorization,
  phase: Journal['phase'], now: () => number, broadcastPostCount: number, result?: GasFreeTransferResult): Journal {
  return { schemaVersion: 'settlemap.gasfree-nile-journal.v1', intentId: options.intentId, phase,
    updatedAt: new Date(now()).toISOString(), evidenceFile, preflight: structuredClone(preflight), authorization: structuredClone(authorization),
    ...(result ? { result: structuredClone(result) } : {}), broadcastPostCount };
}

export async function signWithPrivateKeyFile(file: string, expectedPayer: string, typedData: GasFreeTypedData): Promise<string> {
  const resolved = resolveFromProject(file);
  const relative = path.relative(PROJECT_ROOT, resolved);
  if (relative !== '.data' && !relative.startsWith(`.data${path.sep}`) && relative !== '..' && !relative.startsWith(`..${path.sep}`)) {
    throw new GasFreeCliError('SIGNER_FILE_TRACKABLE', 'A signer file inside the project must be under the ignored .data directory.');
  }
  const metadata = await lstat(resolved).catch(() => { throw new GasFreeCliError('SIGNER_FILE_UNAVAILABLE', 'Signer key file is unavailable.'); });
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new GasFreeCliError('SIGNER_FILE_UNSAFE', 'Signer key path must be a regular file, not a symlink.');
  if ((metadata.mode & 0o077) !== 0) throw new GasFreeCliError('SIGNER_FILE_PERMISSIONS', 'Signer key file must not be readable or writable by group/others (use mode 0600).');
  const raw = await readFile(resolved);
  try {
    const privateKey = raw.toString('utf8').trim().replace(/^0x/i, '');
    if (!/^[0-9a-f]{64}$/i.test(privateKey)) throw new GasFreeCliError('SIGNER_KEY_INVALID', 'Signer key file must contain exactly one 32-byte hexadecimal private key.');
    const derived = TronWeb.address.fromPrivateKey(privateKey, true);
    if (!derived || derived !== expectedPayer) throw new GasFreeCliError('SIGNER_MISMATCH', 'Signer key does not derive the declared payer address.');
    if (typedData.domain.chainId !== NILE_CHAIN_ID || typedData.domain.verifyingContract !== NILE_CONTROLLER || typedData.message.user !== expectedPayer) {
      throw new GasFreeCliError('TYPED_DATA_MISMATCH', 'Refusing to sign typed data outside the official Nile GasFree domain or declared payer.');
    }
    const signature = Trx._signTypedData(typedData.domain, typedData.types, typedData.message, privateKey).replace(/^0x/i, '');
    if (!/^[0-9a-f]{130}$/i.test(signature)) throw new GasFreeCliError('SIGNATURE_INVALID', 'TIP-712 signer returned an invalid signature.');
    return signature;
  } finally {
    raw.fill(0);
  }
}

export async function executeOneShot(options: OneShotOptions, dependencies: OneShotDependencies): Promise<{ evidence: OneShotEvidence; evidenceFile: string; exitCode: number }> {
  const now = dependencies.now ?? Date.now;
  const sleep = dependencies.sleep ?? (async (ms: number) => new Promise(resolve => setTimeout(resolve, ms)));
  const dataDir = dependencies.dataDir ?? path.join(PROJECT_ROOT, '.data', 'gasfree-one-shot');
  const journalFile = path.join(dataDir, `${options.intentId}.journal.json`);
  const evidenceFile = options.evidenceFile ? resolveFromProject(options.evidenceFile) : path.join(dataDir, `${options.intentId}.evidence.json`);
  if (options.broadcast) {
    if (options.confirmation !== BROADCAST_CONFIRMATION) {
      throw new GasFreeCliError('BROADCAST_CONFIRMATION_REQUIRED', `Broadcast requires --confirm-broadcast ${BROADCAST_CONFIRMATION}.`);
    }
    if (!options.signerKeyFile) throw new GasFreeCliError('SIGNER_REQUIRED', 'Broadcast requires --signer-key-file or GASFREE_SIGNER_KEY_FILE.');
    if (await exists(journalFile)) {
      throw new GasFreeCliError('INTENT_ALREADY_LOCKED', 'This intent already has a durable broadcast journal; recover or reconcile it instead of submitting again.');
    }
  }
  const payment = { id: `gasfree-cli:${options.intentId}`, address: options.receiverAddress, amountMicros: options.amountMicros };
  const preflight = await dependencies.adapter.preflight({ payerAddress: options.payerAddress, payments: [payment],
    ...(options.providerAddress ? { providerAddress: options.providerAddress } : {}),
    ...(options.tokenAddress ? { tokenAddress: options.tokenAddress } : {}) });
  let evidence = evidenceFor(options, preflight, undefined, undefined, now, dependencies.broadcastPostCount?.() ?? 0);
  await writePrivateJson(evidenceFile, evidence);
  if (!options.broadcast || !preflight.ready) return { evidence, evidenceFile, exitCode: preflight.ready ? 0 : 2 };

  const authorization = dependencies.adapter.prepareAuthorization(preflight, payment);
  const signature = await dependencies.signTypedData(authorization.typedData, options.payerAddress);
  // Exclusive creation closes the cross-process race between the early existence
  // check and the submit. Even a partial crash file burns the intent safely.
  await createPrivateJson(journalFile, journalFor(options, evidenceFile, preflight, authorization, 'BROADCASTING', now,
    dependencies.broadcastPostCount?.() ?? 0));
  let result: GasFreeTransferResult;
  try {
    result = await dependencies.adapter.submitSigned(authorization, signature);
  } catch {
    await writePrivateJson(journalFile, journalFor(options, evidenceFile, preflight, authorization, 'ERROR_AFTER_LOCK', now,
      dependencies.broadcastPostCount?.() ?? 0));
    throw new GasFreeCliError('SUBMISSION_UNRESOLVED', 'Submission raised an unexpected error after the durable intent lock; do not resubmit this intent.');
  }
  await writePrivateJson(journalFile, journalFor(options, evidenceFile, preflight, authorization, 'SUBMITTED', now,
    dependencies.broadcastPostCount?.() ?? 0, result));
  const stopAt = now() + options.pollSeconds * 1000;
  while (result.traceId && result.status !== 'CONFIRMED' && result.status !== 'FAILED' && result.retryAction === 'QUERY_ORIGINAL' && now() < stopAt) {
    await sleep(Math.min(2_000, Math.max(0, stopAt - now())));
    result = await dependencies.adapter.recover(authorization, result);
    await writePrivateJson(journalFile, journalFor(options, evidenceFile, preflight, authorization, 'SUBMITTED', now,
      dependencies.broadcastPostCount?.() ?? 0, result));
  }
  await writePrivateJson(journalFile, journalFor(options, evidenceFile, preflight, authorization, 'FINISHED', now,
    dependencies.broadcastPostCount?.() ?? 0, result));
  evidence = evidenceFor(options, preflight, authorization, result, now, dependencies.broadcastPostCount?.() ?? 0);
  await writePrivateJson(evidenceFile, evidence);
  return { evidence, evidenceFile, exitCode: evidence.exactTransferVerified ? 0 : 2 };
}

async function readJournal(file: string, intentId: string): Promise<Journal> {
  let metadata;
  try { metadata = await lstat(file); }
  catch { throw new GasFreeCliError('JOURNAL_NOT_FOUND', 'No local journal exists for that intent.'); }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 1_000_000) {
    throw new GasFreeCliError('JOURNAL_INVALID', 'The local intent journal is not a safe regular JSON file.');
  }
  let parsed: unknown;
  try { parsed = JSON.parse(await readFile(file, 'utf8')); }
  catch { throw new GasFreeCliError('JOURNAL_INVALID', 'The local intent journal is not valid JSON.'); }
  const journal = parsed as Partial<Journal>;
  if (journal.schemaVersion !== 'settlemap.gasfree-nile-journal.v1' || journal.intentId !== intentId ||
      typeof journal.evidenceFile !== 'string' || !journal.preflight || !journal.authorization ||
      typeof journal.broadcastPostCount !== 'number' || !Number.isInteger(journal.broadcastPostCount) || journal.broadcastPostCount < 0 || journal.broadcastPostCount > 1) {
    throw new GasFreeCliError('JOURNAL_INVALID', 'The local intent journal failed structural validation.');
  }
  return journal as Journal;
}

export async function recoverOneShot(options: RecoverOptions, dependencies: RecoveryDependencies): Promise<{ evidence: OneShotEvidence; evidenceFile: string; exitCode: number }> {
  const now = dependencies.now ?? Date.now;
  const sleep = dependencies.sleep ?? (async (ms: number) => new Promise(resolve => setTimeout(resolve, ms)));
  const dataDir = dependencies.dataDir ?? path.join(PROJECT_ROOT, '.data', 'gasfree-one-shot');
  const journalFile = path.join(dataDir, `${options.recoverIntentId}.journal.json`);
  const journal = await readJournal(journalFile, options.recoverIntentId);
  if (!journal.result) {
    throw new GasFreeCliError('RECOVERY_REQUIRES_TRACE', 'The locked intent has no saved provider result or trace ID; do not resubmit it and reconcile manually.');
  }
  const msg = journal.authorization.typedData?.message;
  const amountMicros = Number(msg?.value);
  if (!msg || !Number.isSafeInteger(amountMicros) || amountMicros <= 0 || journal.preflight.network !== 'nile' ||
      journal.preflight.payerAddress !== msg.user || journal.preflight.gasFreeAddress !== journal.authorization.gasFreeAddress ||
      journal.preflight.selectedToken.tokenAddress !== msg.token || journal.preflight.selectedProvider.address !== msg.serviceProvider ||
      journal.preflight.payments[0]?.address !== msg.receiver || journal.preflight.payments[0]?.amountMicros !== amountMicros) {
    throw new GasFreeCliError('JOURNAL_MISMATCH', 'The saved preflight and authorization do not describe the same exact transfer.');
  }
  const transferOptions: OneShotOptions = { payerAddress: msg.user, receiverAddress: msg.receiver, amountMicros,
    intentId: options.recoverIntentId, providerAddress: msg.serviceProvider, tokenAddress: msg.token, broadcast: true,
    confirmation: BROADCAST_CONFIRMATION, pollSeconds: options.pollSeconds };
  let result = journal.result;
  const evidenceFile = options.evidenceFile ? resolveFromProject(options.evidenceFile) : journal.evidenceFile;
  const stopAt = now() + options.pollSeconds * 1000;
  if (result.traceId && result.status !== 'CONFIRMED' && result.status !== 'FAILED' && result.retryAction === 'QUERY_ORIGINAL') {
    result = await dependencies.adapter.recover(journal.authorization, result);
    await writePrivateJson(journalFile, journalFor(transferOptions, evidenceFile, journal.preflight, journal.authorization,
      'SUBMITTED', now, journal.broadcastPostCount, result));
  }
  while (result.traceId && result.status !== 'CONFIRMED' && result.status !== 'FAILED' && result.retryAction === 'QUERY_ORIGINAL' && now() < stopAt) {
    await sleep(Math.min(2_000, Math.max(0, stopAt - now())));
    result = await dependencies.adapter.recover(journal.authorization, result);
    await writePrivateJson(journalFile, journalFor(transferOptions, evidenceFile, journal.preflight, journal.authorization,
      'SUBMITTED', now, journal.broadcastPostCount, result));
  }
  await writePrivateJson(journalFile, journalFor(transferOptions, evidenceFile, journal.preflight, journal.authorization,
    'FINISHED', now, journal.broadcastPostCount, result));
  const evidence = evidenceFor(transferOptions, journal.preflight, journal.authorization, result, now, journal.broadcastPostCount);
  await writePrivateJson(evidenceFile, evidence);
  return { evidence, evidenceFile, exitCode: evidence.exactTransferVerified ? 0 : 2 };
}

function usage(): string {
  return [
    'Read-only by default; no signature or submit occurs without --broadcast and the exact confirmation phrase.',
    '',
    'Preflight:',
    '  npm run gasfree:nile -- --payer <EOA> --receiver <TRON_ADDRESS> --amount-micros <INTEGER> --intent <UNIQUE_ID>',
    '',
    'One Nile broadcast (after reviewing preflight and funding the derived GasFree account):',
    `  npm run gasfree:nile -- --payer <EOA> --receiver <TRON_ADDRESS> --amount-micros <INTEGER> --intent <NEW_ID> --signer-key-file .data/gasfree-nile-signer.key --broadcast --confirm-broadcast ${BROADCAST_CONFIRMATION}`,
    '',
    'Optional: --provider <ADDRESS> --token <ADDRESS> --evidence <FILE> --poll-seconds <0-300>',
    'Recover/query a saved trace without signing or POSTing:',
    '  npm run gasfree:nile -- --recover-intent <PRIOR_ID> [--poll-seconds 120]',
    'Amounts are integer micro-USDT. Each --intent is permanently single-use once broadcast is armed.',
  ].join('\n');
}

async function main(): Promise<void> {
  const command = parseOneShotOptions(process.argv.slice(2));
  if ('help' in command) { console.log(usage()); return; }
  const config = gasFreeConfigFromEnv();
  if (!config.apiKey || !config.apiSecret) {
    throw new GasFreeCliError('GASFREE_NOT_CONFIGURED', 'GasFree Nile API key and secret are required for preflight or trace recovery; no transfer was submitted.');
  }
  if ('broadcast' in command && command.broadcast && !config.enabled) {
    throw new GasFreeCliError('GASFREE_LIVE_DISABLED', 'Broadcast requires ENABLE_GASFREE_LIVE=true; no transfer was submitted.');
  }
  let broadcastPostCount = 0;
  const guardedFetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if ((init?.method || 'GET').toUpperCase() === 'POST' && url.origin === 'https://open-test.gasfree.io' && url.pathname === SUBMIT_PATH) {
      broadcastPostCount += 1;
      if (broadcastPostCount > 1) throw new GasFreeCliError('MULTIPLE_BROADCAST_BLOCKED', 'The one-shot guard blocked a second submit POST.');
    }
    return globalThis.fetch(input, init);
  };
  const adapter = createGasFreeAdapter(config, { fetch: guardedFetch });
  const output = 'recoverIntentId' in command
    ? await recoverOneShot(command, { adapter })
    : await executeOneShot(command, {
      adapter,
      signTypedData: (typedData, payer) => signWithPrivateKeyFile(command.signerKeyFile!, payer, typedData),
      broadcastPostCount: () => broadcastPostCount,
    });
  console.log(JSON.stringify({ evidenceFile: output.evidenceFile, evidence: output.evidence }, null, 2));
  process.exitCode = output.exitCode;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    const safe = error instanceof GasFreeCliError || (error && typeof error === 'object' &&
      typeof (error as { code?: unknown }).code === 'string' && typeof (error as { message?: unknown }).message === 'string');
    console.error(JSON.stringify({ status: 'ERROR', code: safe ? (error as { code: string }).code : 'UNEXPECTED_ERROR',
      message: safe ? (error as { message: string }).message : 'Unexpected local failure; no success claim was written.' }));
    process.exitCode = 1;
  });
}
