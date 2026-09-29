/** All money is stored as safe integer micro-USDT. Input amounts are decimal strings. */
export interface InputRow {
  id: string;
  invoiceId: string;
  payeeId: string;
  payeeName: string;
  address: string;
  token: string;
  amount: string;
  note: string;
  /** Explicit user review, retained in the confirmed plan and exports. */
  reviewedOverLimit?: boolean;
  /** Manual review only; this does not prove ownership of the recipient address. */
  reviewedAddressChange?: boolean;
  deferred?: boolean;
  reviewNote?: string;
}

export interface OpsInspectionItem {
  rowId: string;
  invoiceId: string;
  historyStatus: 'NEW' | 'SETTLED' | 'UNRESOLVED';
  addressStatus: 'NEW' | 'MATCH' | 'CHANGED';
  previousAddress?: string;
  previousBatchId?: string;
  traceId?: string;
}

export interface OpsInspection {
  items: OpsInspectionItem[];
  summary: { settled: number; unresolved: number; addressChanged: number; newPayees: number };
}

export interface RowIssue { code: string; message: string }
export interface ValidatedRow extends InputRow {
  line: number;
  status: 'VALID' | 'INVALID';
  amountMicros?: number;
  issues: RowIssue[];
  paymentId?: string;
}

export interface PaymentPlan {
  id: string;
  payeeId: string;
  payeeName: string;
  address: string;
  token: 'USDT';
  amountMicros: number;
  feeMicros: number;
  rowIds: string[];
  invoiceIds: string[];
}

export interface SettlementPlan {
  id: string;
  digest: string;
  createdAt: string;
  mode: 'fixture' | 'live';
  rows: ValidatedRow[];
  payments: PaymentPlan[];
  summary: {
    inputRows: number;
    validRows: number;
    invalidRows: number;
    paymentCount: number;
    principalMicros: number;
    unmergedFeeMicros: number;
    mergedFeeMicros: number;
    feeSavingsMicros: number;
    totalDebitMicros: number;
    reviewedOverLimitRows: number;
    reviewedAddressChangeRows: number;
    deferredRows: number;
  };
  feeNote: string;
}

export interface PaymentAttempt {
  id: string;
  requestId: string;
  traceId?: string;
  startedAt: string;
  status: 'SUBMITTING' | 'PROCESSING' | 'CONFIRMED' | 'UNKNOWN' | 'FAILED';
  queries: number;
  lastQueriedAt?: string;
  txHash?: string;
  failureCode?: string;
  failureReason?: string;
  authorization?: GasFreeAuthorization;
  /** Independent solidified-receipt audit. Persisted with the attempt. */
  chainVerification?: NileChainVerification;
}

export interface PaymentExecution extends PaymentPlan {
  status: 'QUEUED' | 'PROCESSING' | 'CONFIRMED' | 'UNKNOWN' | 'FAILED';
  attempts: PaymentAttempt[];
  traceId?: string;
  actualFeeMicros?: number;
  confirmedAt?: string;
  requestId?: string;
  txHash?: string;
  failureCode?: string;
  failureReason?: string;
  providerState?: string;
  chainState?: string;
  /** Hash of the deterministic batch manifest this operation belongs to. */
  manifestHash?: string;
  /** Local hash associating the manifest with signed fields; this hash itself is not signed or on-chain. */
  operationHash?: string;
  chainVerification?: NileChainVerification;
}

export interface BatchEvent { id: string; at: string; kind: string; title: string; detail: string }
export interface Batch {
  id: string;
  createdAt: string;
  updatedAt: string;
  mode: 'fixture' | 'live';
  status: 'DRAFT' | 'CONFIRMED' | 'RUNNING' | 'PAUSED' | 'COMPLETED' | 'ERROR';
  plan: SettlementPlan;
  planDigest: string;
  confirmedAt?: string;
  payments: PaymentExecution[];
  events: BatchEvent[];
  error?: string;
  payerAddress?: string;
  preflight?: GasFreePreflight;
  settlementManifest?: SettlementManifest;
  manifestHash?: string;
}

export interface Health {
  app: 'SettleMap';
  paymentMode: 'fixture' | 'live';
  liveConfigured: boolean;
  liveEnabled: boolean;
  gasFree: { apiKeyConfigured: boolean; apiSecretConfigured: boolean; baseUrl: string; configured: boolean; executable: boolean };
  note: string;
}

/** Public DTOs: no API credentials or wallet signatures are persisted here. */
export interface GasFreeToken {
  tokenAddress: string;
  symbol: string;
  decimal: number;
  supported: boolean;
  activateFee: string;
  transferFee: string;
}

export interface GasFreeProvider {
  address: string;
  name: string;
  config: { maxPendingTransfer: number; minDeadlineDuration: number; maxDeadlineDuration: number; defaultDeadlineDuration: number };
}

export interface GasFreePaymentInput { id: string; address: string; amountMicros: number }

export interface GasFreePreflight {
  mode: 'live';
  network: 'nile';
  chainId: 3448148188;
  checkedAt: string;
  payerAddress: string;
  gasFreeAddress: string;
  active: boolean;
  nonce: string;
  allowSubmit: boolean;
  supportedTokens: GasFreeToken[];
  providers: GasFreeProvider[];
  selectedToken: GasFreeToken;
  selectedProvider: GasFreeProvider;
  balanceMicros: string;
  frozenMicros: string;
  availableMicros: string;
  principalMicros: number;
  activationFeeMicros: number;
  transferFeeMicros: number;
  estimatedFeeMicros: number;
  totalDebitMicros: number;
  sufficientBalance: boolean;
  ready: boolean;
  blockers: { code: string; message: string }[];
  payments: GasFreePaymentInput[];
}

export interface GasFreeTypedData {
  domain: { name: string; version: string; chainId: number; verifyingContract: string };
  types: { PermitTransfer: { name: string; type: string }[] };
  message: { token: string; serviceProvider: string; user: string; receiver: string; value: string; maxFee: string; deadline: string; version: string; nonce: string };
}

export interface GasFreeAuthorization {
  id: string;
  requestId: string;
  paymentId: string;
  network: 'nile';
  gasFreeAddress: string;
  createdAt: string;
  /** Detect accidental persisted-payload mutation; this is not a wallet signature. */
  digest: string;
  typedData: GasFreeTypedData;
  /** Local evidence link. The wallet signs the typedData fields; this hash is verified against them server-side. */
  manifestHash?: string;
  operationHash?: string;
}

export interface SettlementManifestPayment {
  paymentId: string;
  payeeId: string;
  address: string;
  token: 'USDT';
  amountMicros: number;
  rowIds: string[];
  invoiceIds: string[];
}

/** Excludes timestamps and random batch IDs so identical settlement inputs hash identically. */
export interface SettlementManifest {
  version: '1';
  network: 'nile';
  payerAddress: string;
  gasFreeAddress: string;
  tokenAddress: string;
  providerAddress: string;
  payments: SettlementManifestPayment[];
}

export interface NileChainVerification {
  network: 'nile';
  source: 'nile-solidity-rpc';
  status: 'VERIFIED' | 'PENDING' | 'MISMATCH' | 'UNAVAILABLE';
  checkedAt: string;
  txHash: string;
  explorerUrl: string;
  tokenAddress: string;
  fromAddress: string;
  receiverAddress: string;
  amountMicros: string;
  manifestHash?: string;
  operationHash?: string;
  blockNumber?: number;
  blockTimestamp?: number;
  transferLogIndex?: number;
  message: string;
}

export interface GasFreeTransferResult {
  mode: 'live';
  network: 'nile';
  requestId: string;
  traceId?: string;
  txHash?: string;
  status: 'PROCESSING' | 'CONFIRMED' | 'UNKNOWN' | 'FAILED';
  checkedAt: string;
  providerState?: 'WAITING' | 'INPROGRESS' | 'CONFIRMING' | 'SUCCEED' | 'FAILED';
  chainState?: 'INIT' | 'NOT_ON_CHAIN' | 'ON_CHAIN' | 'SOLIDITY' | 'ON_CHAIN_FAILED';
  actualFeeMicros?: number;
  actualAmountMicros?: number;
  failureCode?: string;
  failureReason?: string;
  /** CONFIRMED means the provider reports a solidified transfer; not a second RPC receipt audit. */
  verificationSource: 'gasfree-provider' | 'gasfree-provider+nile-solidity-rpc';
  chainVerification?: NileChainVerification;
  /** Never automatically resubmit: requestId is a diagnostic UUID, not an idempotency guarantee. */
  retryAction: 'QUERY_ORIGINAL' | 'MANUAL_RECONCILIATION' | 'NEW_AUTHORIZATION_REQUIRED' | 'NONE';
}
