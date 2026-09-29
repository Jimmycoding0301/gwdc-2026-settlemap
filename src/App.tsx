import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  BadgeCheck,
  Check,
  ChevronDown,
  CircleDollarSign,
  ClipboardCheck,
  ClipboardPaste,
  Copy,
  Clock3,
  Download,
  FileCheck2,
  FileSpreadsheet,
  Fingerprint,
  FolderInput,
  Gauge,
  Layers3,
  Link2,
  ListFilter,
  LoaderCircle,
  MapPinned,
  Network,
  Play,
  PackageOpen,
  ReceiptText,
  RefreshCcw,
  Route,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Upload,
  WalletCards,
  X,
  Command,
  FileImage,
  Search,
  Undo2,
} from 'lucide-react';
import type { Batch, GasFreeAuthorization, GasFreePreflight, Health, InputRow, PaymentExecution, SettlementPlan, ValidatedRow } from '../shared/types';
import { ApiError, api, downloadUrl, post } from './api';
import { connectTronLink, signGasFreeAuthorization } from './tronlink';
import { parseTabular, resolveIntake, exceptionHandoff } from '../shared/intake';
import { ScreenshotImport } from './ScreenshotImport';
import { CommandMenu } from './CommandMenu';
import { Dialog } from './Dialog';
import { addressChanges, verificationMessage } from './address-review';

type Sample = { rows: InputRow[]; csv: string; note: string };
type OpsItem = {
  rowId: string;
  invoiceId: string;
  historyStatus: 'NEW' | 'SETTLED' | 'UNRESOLVED';
  addressStatus: 'NEW' | 'MATCH' | 'CHANGED';
  previousAddress?: string;
  previousBatchId?: string;
  traceId?: string;
};

function preflightFromError(error: unknown): GasFreePreflight | null {
  const details = error instanceof ApiError ? error.details : undefined;
  return details && typeof details === 'object' && (details as Partial<GasFreePreflight>).mode === 'live'
    ? details as GasFreePreflight : null;
}
type OpsReport = {
  items: OpsItem[];
  summary: { settled: number; unresolved: number; addressChanged: number; newPayees: number };
};

const statusLabel: Record<Batch['status'], string> = {
  DRAFT: '待确认',
  CONFIRMED: '方案已锁定',
  RUNNING: '执行中',
  PAUSED: '等待核验',
  COMPLETED: '对账完成',
  ERROR: '运行失败',
};

const paymentLabel: Record<PaymentExecution['status'], string> = {
  QUEUED: '等待提交',
  PROCESSING: '链上处理中',
  CONFIRMED: '已确认',
  UNKNOWN: '状态未知',
  FAILED: '已失败',
};

const money = (micros = 0) => (micros / 1_000_000).toLocaleString('en-US', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 6,
});
const exactMoney = (micros = '0') => {
  const value = BigInt(micros);
  const fraction = String(value % 1_000_000n).padStart(6, '0').replace(/0+$/, '');
  return `${(value / 1_000_000n).toLocaleString('en-US')}${fraction ? `.${fraction}` : '.00'}`;
};

const short = (value?: string) => value ? `${value.slice(0, 8)}…${value.slice(-6)}` : '—';


function IssuePill({ row }: { row: ValidatedRow }) {
  if (row.status === 'VALID') return <span className="status-pill valid"><Check size={13} />可结算</span>;
  return <span className="status-pill invalid" title={row.issues.map(issue => issue.message).join('；')}><AlertTriangle size={13} />{row.issues[0]?.message || '需处理'}</span>;
}

function AddressDiff({ previous, current }: { previous: string; current: string }) {
  const changes = addressChanges(previous, current);
  const changed = new Set(changes.map(item => item.index));
  const summary = changes.slice(0, 6).map(item => `#${item.index + 1} ${item.before}→${item.after}`).join(' · ');
  const render = (value: string) => [...value].map((character, index) => changed.has(index)
    ? <mark key={index}>{character}</mark> : <span key={index}>{character}</span>);
  return <div className="address-diff" aria-label={`地址有 ${changes.length} 个字符不同`}>
    <div><b>参考</b><code>{render(previous)}</code></div>
    <div><b>本次</b><code>{render(current)}</code></div>
    <small>{changes.length ? `${summary}${changes.length > 6 ? ` · 共 ${changes.length} 处` : ''}` : '字符一致'}</small>
  </div>;
}

function PaymentCard({ payment, execution, rows, onCopyReceipt }: {
  payment: SettlementPlan['payments'][number];
  execution?: PaymentExecution;
  rows: ValidatedRow[];
  onCopyReceipt: (payment: PaymentExecution) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const status = execution?.status;
  const sourceRows = payment.rowIds.flatMap(id => {
    const row = rows.find(candidate => candidate.id === id);
    return row ? [row] : [];
  });
  const aliases = [...new Set(sourceRows.map(row => row.payeeName))];
  return <article className={`payment-card ${status?.toLowerCase() || ''}`}>
    <button className="payment-head" onClick={() => setExpanded(value => !value)} aria-expanded={expanded}>
      <span className="payee-avatar">{payment.payeeName.slice(0, 1)}</span>
      <span className="payee-copy"><strong>{payment.payeeName}</strong><small>{payment.invoiceIds.length} 条业务明细 · {short(payment.address)}</small></span>
      <span className="payment-value"><strong>{money(payment.amountMicros)} <small>USDT</small></strong>{status ? <span className={`payment-state ${status.toLowerCase()}`}>{paymentLabel[status]}</span> : <small>预计费用 {money(payment.feeMicros)}</small>}</span>
      <ChevronDown size={17} className={expanded ? 'up' : ''} />
    </button>
    {expanded && <div className="payment-detail">
      <div className="lineage-detail"><span>原始业务</span><div className="lineage-list">
        {sourceRows.map(row => <div className="lineage-row" key={row.id}><code>{row.invoiceId}</code><p>{row.note || row.payeeName}</p><b>{money(row.amountMicros)} USDT</b></div>)}
        <div className="lineage-total"><span>合并核算</span><strong>{sourceRows.map(row => money(row.amountMicros)).join(' + ')} = {money(payment.amountMicros)} USDT</strong></div>
      </div></div>
      {aliases.length > 1 && <div><span>同一达人别名</span><p>{aliases.join(' · ')}</p></div>}
      <div><span>收款地址</span><code>{payment.address}</code></div>
      {execution?.attempts.map(attempt => <div className="attempt" key={attempt.id}><span>{attempt.authorization ? 'GasFree 授权' : '唯一付款尝试'}</span><p><code>{attempt.requestId}</code><b>{attempt.queries} 次状态查询</b></p></div>)}
      {execution?.traceId && <div><span>Provider trace</span><code>{execution.traceId}</code></div>}
      {execution?.manifestHash && <div><span>本地清单摘要</span><code>{execution.manifestHash}</code></div>}
      {execution?.operationHash && <div><span>本地关联摘要</span><code>{execution.operationHash}</code></div>}
      {execution?.txHash && <div><span>TRON 交易哈希</span><a className="chain-link" href={`https://nile.tronscan.org/#/transaction/${execution.txHash}`} target="_blank" rel="noreferrer"><code>{execution.txHash}</code><ArrowRight size={12} /></a></div>}
      {execution?.chainVerification && <div><span>独立链上核验</span><p className={`chain-proof ${execution.chainVerification.status.toLowerCase()}`}><b>{execution.chainVerification.status === 'VERIFIED' ? `Nile 已固化 · 区块 ${execution.chainVerification.blockNumber}` : execution.chainVerification.status}</b>{execution.chainVerification.message}</p></div>}
      {execution?.failureReason && <div><span>失败 / 待核查原因</span><p>{execution.failureCode ? `${execution.failureCode}：` : ''}{execution.failureReason}</p></div>}
      {execution?.status === 'CONFIRMED' && <div><span>收款人通知</span><button className="copy-receipt" onClick={() => onCopyReceipt(execution)}><Copy size={13} />复制付款回执</button></div>}
    </div>}
  </article>;
}

export default function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [rows, setRows] = useState<InputRow[]>([]);
  const [plan, setPlan] = useState<SettlementPlan | null>(null);
  const [batch, setBatch] = useState<Batch | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState('');
  const [onlyExceptions, setOnlyExceptions] = useState(true);
  const [opsReport, setOpsReport] = useState<OpsReport | null>(null);
  const [recoverableBatch, setRecoverableBatch] = useState<Batch | null>(null);
  const [settlementMode, setSettlementMode] = useState<'fixture' | 'live'>('fixture');
  const [walletAddress, setWalletAddress] = useState('');
  const [preflightReport, setPreflightReport] = useState<GasFreePreflight | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [omniText, setOmniText] = useState('');
  const [matchedIds, setMatchedIds] = useState<string[]>([]);
  const [screenshotOpen, setScreenshotOpen] = useState(false);
  const [screenshotFile, setScreenshotFile] = useState<File>();
  const [commandsOpen, setCommandsOpen] = useState(false);
  const [handoffText, setHandoffText] = useState('');
  const [undoRows, setUndoRows] = useState<InputRow[] | null>(null);
  const [scenarioPrepared, setScenarioPrepared] = useState(false);

  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        if (!screenshotOpen && !handoffText) setCommandsOpen(current => !current);
      }
    };
    window.addEventListener('keydown', shortcut);
    return () => window.removeEventListener('keydown', shortcut);
  }, [screenshotOpen, handoffText]);

  function openScreenshot(file?: File) { setScreenshotFile(file); setScreenshotOpen(true); }
  function showWorkspace() { document.getElementById('workspace')?.scrollIntoView({ behavior: 'smooth' }); }
  function openPaste() { setPasteOpen(true); setTimeout(() => document.getElementById('paste-intake')?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 30); }
  function handleOmni() {
    setError('');
    try {
      const result = resolveIntake(omniText, rows);
      if (result.kind === 'table') {
        setPasteText(omniText); openPaste();
        setNotice(`识别为 ${result.rows.length} 行表格。请检查文本，再点击“读取并校验”；当前账表尚未替换。`);
      } else {
        setMatchedIds(result.rowIds); setOnlyExceptions(false);
        if (!result.rowIds.length) { setError(`没有找到“${result.query}”对应的业务单或完整地址。`); return; }
        setTimeout(() => document.getElementById(`business-${result.rowIds[0]}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 40);
        setNotice(`找到 ${result.rowIds.length} 条相关业务，已在表格中标出。`);
      }
    } catch (caught) { setError((caught as Error).message); }
  }
  async function copyExceptions() {
    if (dirty) { setError('账表有未校验的修改，请先重新校验后生成交接清单。'); return; }
    const handoff = exceptionHandoff(rows, plan, opsReport, batch);
    if (!handoff.count) { setNotice('当前没有异常或待核查项，不生成空交接清单。'); return; }
    try {
      if (!navigator.clipboard?.writeText) throw new Error();
      await navigator.clipboard.writeText(handoff.text);
      setNotice(`已复制 ${handoff.count} 条异常 / 待核查项；正常业务未包含在内。`);
    } catch { setHandoffText(handoff.text); setError('剪贴板访问失败。交接清单已打开，请选中内容手动复制。'); }
  }
  async function applyScreenshot(nextRows: InputRow[], mode: 'append' | 'replace') {
    const previousRows = structuredClone(rows);
    const incoming = nextRows.map((row, index) => ({ ...row, id: `ocr_import_${Date.now()}_${index + 1}` }));
    const combined = mode === 'append' ? [...rows, ...incoming] : incoming;
    await applyRows(
      combined,
      mode === 'append' ? `已追加 ${incoming.length} 条截图草稿并校验。` : `已用 ${incoming.length} 条截图草稿替换账表。`,
      { rethrow: true },
    );
    setUndoRows(previousRows);
    setOnlyExceptions(false); setMatchedIds([]); showWorkspace();
  }
  function continueUnsettled() {
    if (batch && batch.status !== 'COMPLETED') document.getElementById('execution')?.scrollIntoView({ behavior: 'smooth' });
    else resumeSavedBatch();
  }

  async function preview(nextRows: InputRow[]) {
    const result = await post<SettlementPlan>('/preview', { rows: nextRows });
    setPlan(result); setBatch(null); setDirty(false); setOpsReport(null); setPreflightReport(null);
    return result;
  }

  async function loadSample(resetHistory = false) {
    setBusy(true); setError('');
    try {
      if (resetHistory) await post('/demo/creator-scenario', { confirm: 'PREPARE_CREATOR_SCENARIO' });
      const sample = await api<Sample>('/sample');
      setRows(sample.rows);
      await preview(sample.rows);
      setPasteText(''); setPasteOpen(false); setOnlyExceptions(true); setRecoverableBatch(null);
      if (resetHistory) {
        const report = await post<OpsReport>('/ops/inspect', { rows: sample.rows });
        setOpsReport(report); setScenarioPrepared(true);
      }
      setNotice(resetHistory ? '完整演示已就绪：上月已付、新地址和本月异常已标出。' : '已加载 12 条 KOL 佣金草稿。');
    } catch (caught) { setError((caught as Error).message); }
    finally { setBusy(false); }
  }

  useEffect(() => {
    let cancelled = false;
    Promise.all([api<Health>('/health'), api<Sample>('/sample'), api<Batch[]>('/batches')]).then(async ([nextHealth, sample, batches]) => {
      if (cancelled) return;
      const restored = batches.find(item => item.plan.rows.some(row => row.invoiceId.startsWith('AURORA-SEP-')));
      const workspaceRows = restored ? restored.plan.rows.map(row => ({
        id: row.id, invoiceId: row.invoiceId, payeeId: row.payeeId, payeeName: row.payeeName,
        address: row.address, token: row.token, amount: row.amount, note: row.note,
        reviewedOverLimit: row.reviewedOverLimit, reviewedAddressChange: row.reviewedAddressChange,
        deferred: row.deferred, reviewNote: row.reviewNote,
      })) : sample.rows;
      setHealth(nextHealth); setRows(workspaceRows);
      setRecoverableBatch(batches.find(item => item.status === 'PAUSED' || item.status === 'RUNNING') || null);
      if (restored) { setBatch(restored); setSettlementMode(restored.mode); setPreflightReport(restored.preflight || null); }
      const scenarioReady = batches.some(item => item.plan.rows.some(row => row.id.startsWith('sim_history_')));
      setScenarioPrepared(scenarioReady);
      const [result, report] = await Promise.all([
        restored ? Promise.resolve(restored.plan) : post<SettlementPlan>('/preview', { rows: workspaceRows }),
        scenarioReady ? post<OpsReport>('/ops/inspect', { rows: workspaceRows, ...(restored ? { excludeBatchId: restored.id } : {}) }) : Promise.resolve(null),
      ]);
      if (!cancelled) { setPlan(result); setOpsReport(report); }
    }).catch(caught => { if (!cancelled) setError(`本地服务尚未连接：${caught.message}`); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!batch || batch.status !== 'RUNNING') return;
    const batchId = batch.id;
    const controller = new AbortController();
    let active = true;
    let latestSeenAt = batch.updatedAt;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const updated = await api<Batch>(`/batches/${batchId}`, { signal: controller.signal });
        if (!active) return;
        if (updated.updatedAt < latestSeenAt) {
          timer = setTimeout(poll, 500);
          return;
        }
        latestSeenAt = updated.updatedAt;
        setBatch(current => {
          if (!current || current.id !== batchId || current.status !== 'RUNNING') return current;
          return updated.updatedAt < current.updatedAt ? current : updated;
        });
        if (updated.status === 'RUNNING') timer = setTimeout(poll, 500);
      } catch (caught) {
        if (!active || controller.signal.aborted) return;
        setError((caught as Error).message);
        timer = setTimeout(poll, 1_000);
      }
    };
    timer = setTimeout(poll, 500);
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
      controller.abort();
    };
  }, [batch?.id, batch?.status, batch?.updatedAt]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(''), 4200);
    return () => clearTimeout(timer);
  }, [notice]);

  function editRow(id: string, key: keyof InputRow, value: string) {
    setRows(current => current.map(row => {
      if (row.id !== id) return row;
      const updated = { ...row, [key]: value };
      if (key === 'address' && value !== row.address) {
        const hadReview = updated.reviewedAddressChange;
        delete updated.reviewedAddressChange;
        if (hadReview) delete updated.reviewNote;
      }
      if (key === 'amount' && value !== row.amount) {
        const hadReview = updated.reviewedOverLimit;
        delete updated.reviewedOverLimit;
        if (hadReview) delete updated.reviewNote;
      }
      return updated;
    }));
    setDirty(true); setBatch(null); setOpsReport(null);
  }

  function resumeSavedBatch() {
    if (!recoverableBatch) return;
    setSettlementMode(recoverableBatch.mode);
    setPreflightReport(recoverableBatch.preflight || null);
    setRows(recoverableBatch.plan.rows.map(row => ({
      id: row.id, invoiceId: row.invoiceId, payeeId: row.payeeId, payeeName: row.payeeName,
      address: row.address, token: row.token, amount: row.amount, note: row.note,
      reviewedOverLimit: row.reviewedOverLimit, reviewedAddressChange: row.reviewedAddressChange,
      deferred: row.deferred, reviewNote: row.reviewNote,
    })));
    setBatch(recoverableBatch); setPlan(recoverableBatch.plan);
    setDirty(false); setOpsReport(null);
    document.getElementById('execution')?.scrollIntoView({ behavior: 'smooth' });
  }

  function removeRow(id: string) {
    setRows(current => current.filter(row => row.id !== id));
    setDirty(true); setBatch(null);
  }

  async function validateRows() {
    setBusy(true); setError('');
    try { await preview(rows); setNotice('已重新校验并生成最新付款分组。'); }
    catch (caught) { setError((caught as Error).message); }
    finally { setBusy(false); }
  }

  async function handleFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    setBusy(true); setError('');
    try {
      const parsed = parseTabular(await file.text());
      setRows(parsed);
      await preview(parsed);
      setNotice(`已导入 ${parsed.length} 条业务明细。`);
    } catch (caught) { setError((caught as Error).message); }
    finally { setBusy(false); event.target.value = ''; }
  }

  async function importPastedTable() {
    setBusy(true); setError('');
    try {
      const parsed = parseTabular(pasteText);
      setRows(parsed);
      await preview(parsed);
      setPasteOpen(false); setPasteText('');
      setNotice(`已从剪贴表格读取 ${parsed.length} 条业务；常见中英文列名已自动对应。`);
    } catch (caught) { setError((caught as Error).message); }
    finally { setBusy(false); }
  }

  async function inspectOperations() {
    setBusy(true); setError('');
    try {
      const report = await post<OpsReport>('/ops/inspect', { rows });
      setOpsReport(report);
      setNotice(`历史检查完成：${report.summary.settled} 条已结算，${report.summary.unresolved} 条待核查，${report.summary.addressChanged} 个地址变化。`);
    } catch (caught) { setError((caught as Error).message); }
    finally { setBusy(false); }
  }

  async function applyRows(nextRows: InputRow[], message: string, options: { rethrow?: boolean } = {}) {
    const refreshHistory = Boolean(opsReport);
    setBusy(true); setError('');
    try {
      const [nextPlan, nextOpsReport] = await Promise.all([
        post<SettlementPlan>('/preview', { rows: nextRows }),
        refreshHistory ? post<OpsReport>('/ops/inspect', { rows: nextRows }) : Promise.resolve(null),
      ]);
      setRows(nextRows);
      setPlan(nextPlan); setBatch(null); setDirty(false); setPreflightReport(null);
      setOpsReport(nextOpsReport);
      setNotice(message);
    }
    catch (caught) {
      setError((caught as Error).message);
      if (options.rethrow) throw caught;
    }
    finally { setBusy(false); }
  }

  async function deferRow(id: string, reason: string) {
    await applyRows(rows.map(row => row.id === id ? { ...row, deferred: true, reviewNote: reason } : row), '该业务已暂缓并保留原因；它不会进入付款，但会留在对账资料中。');
  }

  async function approveHighAmount(id: string) {
    await applyRows(rows.map(row => row.id === id ? { ...row, reviewedOverLimit: true, reviewNote: '负责人已人工复核本批次金额' } : row), '该金额已留下人工复核标记，并重新生成付款方案。');
  }

  async function approveAddressChange(id: string) {
    const source = rows.find(row => row.id === id);
    if (!source) return;
    const affected = rows.filter(row => row.payeeId === source.payeeId && row.address === source.address && !row.deferred).length;
    await applyRows(rows.map(row => row.payeeId === source.payeeId && row.address === source.address && !row.deferred
      ? { ...row, reviewedAddressChange: true, reviewNote: '负责人已通过原聊天渠道核对新收款地址' } : row), `已将同一创作者的 ${affected} 条佣金标记为已核址。`);
  }

  async function generateUniqueInvoice(id: string) {
    const source = rows.find(row => row.id === id);
    if (!source) return;
    const used = new Set(rows.map(row => row.invoiceId));
    let suffix = 1;
    let nextId = `${source.invoiceId}-R${suffix}`;
    while (used.has(nextId)) { suffix += 1; nextId = `${source.invoiceId}-R${suffix}`; }
    await applyRows(rows.map(row => row.id === id ? { ...row, invoiceId: nextId, reviewNote: `负责人确认这是独立业务；原单号 ${source.invoiceId}` } : row), `已生成独立业务单号 ${nextId}。此操作只适用于两项独立业务误用了同一单号。`);
  }

  async function applyReferenceAddress(id: string, referenceAddress: string) {
    await applyRows(rows.map(row => row.id === id ? { ...row, address: referenceAddress,
      reviewNote: '操作者使用同一 payee 活动表中的参考地址修正 OCR 草稿' } : row), '已用活动表中的参考地址修正 OCR 字符，并重新校验。');
  }

  async function deferHistoryRows() {
    if (!opsReport) return;
    const deferred = new Set(rows.filter(row => row.deferred).map(row => row.id));
    const risky = new Map(opsReport.items.filter(item => item.historyStatus !== 'NEW' && !deferred.has(item.rowId)).map(item => [item.rowId, item.historyStatus]));
    await applyRows(rows.map(row => risky.has(row.id) ? {
      ...row,
      deferred: true,
      reviewNote: risky.get(row.id) === 'SETTLED' ? '历史批次已结算，本批暂缓' : '历史付款结果待核查，本批暂缓',
    } : row), `已暂缓 ${risky.size} 条历史已付或待核查业务，其余项目可以继续。`);
  }

  async function copyReceipt(payment: PaymentExecution) {
    const trace = payment.traceId || '尚无 trace';
    const invoices = payment.invoiceIds.join('、');
    const live = batch?.mode === 'live';
    const receipt = live
      ? `【GasFree Nile 测试网结算回执 / Payout receipt】\n${payment.payeeName}：${money(payment.amountMicros)} USDT 已确认 / confirmed\n内容编号 / content IDs：${invoices}\nrequestId：${payment.requestId || '—'}\ntraceId（GasFree）：${trace}\nTRON tx（GasFree 返回）：${payment.txHash || '—'}\nNile Explorer：${payment.txHash ? `https://nile.tronscan.org/#/transaction/${payment.txHash}` : '—'}\n链上核验 / verification：${payment.chainVerification?.status || '—'}\nlocal manifest（未上链/未签名）：${payment.manifestHash || '—'}\nlocal operation：${payment.operationHash || '—'}\n实际费用 / fee：${payment.actualFeeMicros === undefined ? '待返回 / pending' : `${money(payment.actualFeeMicros)} USDT`}`
      : `【模拟结算回执 / Demo payout receipt】\n${payment.payeeName}：${money(payment.amountMicros)} USDT 已确认 / confirmed\n内容编号 / content IDs：${invoices}\nProvider trace：${trace}\n本地 fixture / no on-chain transaction.`;
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard API unavailable');
      await navigator.clipboard.writeText(receipt);
    } catch {
      const fallback = document.createElement('textarea');
      fallback.value = receipt; fallback.style.position = 'fixed'; fallback.style.opacity = '0';
      document.body.appendChild(fallback); fallback.select();
      const copied = document.execCommand('copy'); fallback.remove();
      if (!copied) { setError('浏览器阻止了剪贴板访问，请展开回执后手动复制。'); return; }
    }
    setNotice(live ? `已复制 ${payment.payeeName} 的 GasFree 对账回执。` : `已复制 ${payment.payeeName} 的付款回执；模拟标识不会被写成链上哈希。`);
  }

  async function copyAddressCheck(row: InputRow, previousAddress: string) {
    const message = verificationMessage({ payeeName: row.payeeName, invoiceId: row.invoiceId, previousAddress, currentAddress: row.address });
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard API unavailable');
      await navigator.clipboard.writeText(message);
      setNotice('已复制中英双语核址消息。');
    } catch {
      setHandoffText(message); setError('剪贴板不可用。核址消息已打开。');
    }
  }

  async function connectWallet() {
    setBusy(true); setError('');
    try {
      const address = await connectTronLink();
      if (address !== walletAddress) { setBatch(null); setPreflightReport(null); }
      setWalletAddress(address); setNotice(`TronLink 已连接 ${short(address)}；尚未签名或付款。`);
    }
    catch (caught) { setError((caught as Error).message); }
    finally { setBusy(false); }
  }

  async function selectSettlementMode(mode: 'fixture' | 'live') {
    setSettlementMode(mode); setBatch(null); setPreflightReport(null); setBusy(true); setError('');
    try { await preview(rows); }
    catch (caught) { setError((caught as Error).message); }
    finally { setBusy(false); }
  }

  async function createBatch() {
    setBusy(true); setError('');
    try {
      if (settlementMode === 'live' && !walletAddress) throw new Error('请先连接 TronLink；服务端需要 EOA 才能读取对应 GasFree 账户、余额和 nonce。');
      const created = await post<Batch>('/batches', { rows, mode: settlementMode, ...(settlementMode === 'live' ? { payerAddress: walletAddress } : {}) });
      setBatch(created); setPlan(created.plan); setPreflightReport(created.preflight || null);
      document.getElementById('execution')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (caught) {
      const failedPreflight = preflightFromError(caught); if (failedPreflight) setPreflightReport(failedPreflight);
      setError((caught as Error).message);
    }
    finally { setBusy(false); }
  }

  async function confirmBatch() {
    if (!batch) return;
    setBusy(true); setError('');
    try { setBatch(await post<Batch>(`/batches/${batch.id}/confirm`, { planDigest: batch.planDigest })); setNotice('结算清单已锁定；修改任何金额或地址都会产生新摘要。'); }
    catch (caught) { setError((caught as Error).message); }
    finally { setBusy(false); }
  }

  async function runBatch() {
    if (!batch) return;
    setBusy(true); setError('');
    try {
      const updated = await post<Batch>(`/batches/${batch.id}/run`);
      setBatch(updated);
      if (updated.status === 'PAUSED') setRecoverableBatch(updated);
    }
    catch (caught) { setError((caught as Error).message); }
    finally { setBusy(false); }
  }

  async function signAndSubmitNext() {
    if (!batch || batch.mode !== 'live') return;
    setBusy(true); setError('');
    try {
      const prepared = await post<{ batch: Batch; authorization: GasFreeAuthorization }>(`/batches/${batch.id}/live/prepare`, {});
      setBatch(prepared.batch); setPreflightReport(prepared.batch.preflight || null);
      const signature = await signGasFreeAuthorization(prepared.authorization.typedData);
      const updated = await post<Batch>(`/batches/${batch.id}/live/submit`, {
        paymentId: prepared.authorization.paymentId, requestId: prepared.authorization.requestId, signature,
      });
      setBatch(updated); setPlan(updated.plan); setPreflightReport(updated.preflight || null);
      if (updated.status === 'PAUSED') setRecoverableBatch(updated);
      setNotice(updated.status === 'COMPLETED' ? '最后一笔已确认，对账资料已更新。' : '钱包签名已提交；只有 GasFree 返回实际 trace/链上结果后才会标记成功。');
    } catch (caught) {
      const failedPreflight = preflightFromError(caught); if (failedPreflight) setPreflightReport(failedPreflight);
      setError((caught as Error).message);
    }
    finally { setBusy(false); }
  }

  async function recoverBatch() {
    if (!batch) return;
    setBusy(true); setError('');
    try {
      const updated = await post<Batch>(`/batches/${batch.id}/recover`);
      setBatch(updated);
      if (updated.status === 'COMPLETED') setRecoverableBatch(null);
      setNotice(updated.mode === 'live' ? '已查询原 GasFree trace；没有创建新授权或重复 submit。' : '原 trace 已核验；没有创建第二次付款尝试，队列已继续。');
    }
    catch (caught) { setError((caught as Error).message); }
    finally { setBusy(false); }
  }

  const summary = plan?.summary;
  const invalid = plan?.rows.filter(row => row.status === 'INVALID').length || 0;
  const valid = plan?.rows.filter(row => row.status === 'VALID').length || 0;
  const unknown = batch?.payments.filter(payment => payment.status === 'UNKNOWN' || payment.status === 'PROCESSING').length || 0;
  const failed = batch?.payments.filter(payment => payment.status === 'FAILED').length || 0;
  const confirmedPayments = batch?.payments.filter(payment => payment.status === 'CONFIRMED').length || 0;
  const preflight = preflightReport || batch?.preflight;
  const workflowStep = batch?.status === 'COMPLETED' ? 4 : batch?.status === 'RUNNING' || batch?.status === 'PAUSED' ? 3 : batch ? 2 : 1;
  const validationById = new Map(plan?.rows.map(row => [row.id, row]));
  const opsById = new Map(opsReport?.items.map(item => [item.rowId, item]));
  const displayRows: ValidatedRow[] = rows.map((row, index) => {
    const validation = validationById.get(row.id);
    return { ...row, line: index + 1, status: validation?.status || 'VALID', issues: validation?.issues || [], paymentId: validation?.paymentId };
  });
  const visibleRows = onlyExceptions
    ? displayRows.filter(row => {
      const operation = opsById.get(row.id);
      return row.status === 'INVALID' || Boolean(operation && (operation.historyStatus !== 'NEW' || operation.addressStatus === 'CHANGED'));
    })
    : displayRows;
  const deferredIds = new Set(rows.filter(row => row.deferred).map(row => row.id));
  const historyRiskCount = opsReport?.items.filter(item => item.historyStatus !== 'NEW' && !deferredIds.has(item.rowId)).length || 0;
  const exceptionRowCount = new Set([
    ...(plan?.rows.filter(row => row.status === 'INVALID').map(row => row.id) || []),
    ...(opsReport?.items.filter(item => item.historyStatus !== 'NEW' || item.addressStatus === 'CHANGED').map(item => item.rowId) || []),
  ]).size;
  const aliasesByPayee = new Map<string, string[]>();
  for (const row of displayRows) {
    const aliases = aliasesByPayee.get(row.payeeId) || [];
    if (!aliases.includes(row.payeeName)) aliases.push(row.payeeName);
    aliasesByPayee.set(row.payeeId, aliases);
  }
  const reconciledRows = batch?.plan.rows.filter(row => row.paymentId && batch.payments.find(payment => payment.id === row.paymentId)?.status === 'CONFIRMED').length || 0;
  const resolvedRows = batch?.plan.rows.filter(row => row.paymentId && ['CONFIRMED', 'FAILED'].includes(batch.payments.find(payment => payment.id === row.paymentId)?.status || '')).length || 0;

  return <div className="app">
    <div className="announcement"><span>SEOUL → SEA</span><i />KOL 佣金结算 · GasFree Nile · 默认模拟</div>
    <header className="topbar">
      <a className="brand" href="#top"><span className="brand-icon"><Route size={28} strokeWidth={1.5} /></span><span>SettleMap<small>EVERY DETAIL, ACCOUNTED FOR.</small></span></a>
      <nav><a href="#workspace">核对</a><a href="#execution">支付</a><a href="#pain">痛点</a></nav>
      <div className="nav-actions"><div className={`environment ${settlementMode === 'live' ? 'live' : ''}`}><span />{settlementMode === 'live' ? 'Nile TESTNET' : 'FIXTURE · 本地模拟'}</div><button className="nav-command" aria-label="打开快捷操作面板" onClick={() => setCommandsOpen(true)}><Command size={15} /><span>快捷操作</span><kbd>⌘ K</kbd></button></div>
    </header>

    <main id="top">
      <section className="hero">
        <div className="hero-copy">
          <div className="eyebrow"><Sparkles size={14} /><span>Campaign in. <b>Safe payout out.</b></span><ArrowRight size={13} /></div>
          <h1>From campaign.<br /><em>To payout.</em></h1>
          <p>活动表、Telegram 钱包截图、内容编号。<br />一次变成可核对的 TRON USDT 结算。</p>
          <form className="omni-input" onSubmit={event => { event.preventDefault(); handleOmni(); }}>
            <Search size={19} /><textarea rows={1} aria-label="万能输入：粘贴表格或查找地址与业务单" value={omniText} onChange={event => setOmniText(event.target.value)}
              onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); handleOmni(); } }}
              onPaste={event => { const file = [...event.clipboardData.items].find(item => item.type.startsWith('image/'))?.getAsFile(); if (file) { event.preventDefault(); openScreenshot(file); } }}
              placeholder="粘贴活动表，或查找内容编号…" /><button type="submit" aria-label="读取或查找输入内容" disabled={busy}><ArrowRight size={20} /></button>
          </form>
          <div className="hero-actions"><button className="button primary" disabled={busy} onClick={() => loadSample(true)}><Play size={15} />{scenarioPrepared ? '重置完整演示' : '载入完整演示'}</button><button className="button secondary" onClick={() => openScreenshot()}><FileImage size={15} />读截图</button><button className="hero-text-button" onClick={openPaste}>粘贴表格 <ArrowRight size={14} /></button></div>
          <div className="hero-privacy"><ShieldCheck size={13} />截图仅本机识别 · 付款前始终要授权</div>
          <input ref={fileInput} hidden type="file" accept=".csv,text/csv" onChange={handleFile} />
        </div>
        <div className="hero-story">
          <div className="story-label">CREATOR PAYOUT</div>
          <div className="story-flow"><span><b>{summary?.validRows ?? '—'}</b>条有效账目</span><ArrowRight size={18} /><span><b>{summary?.paymentCount ?? '—'}</b>笔付款</span><ArrowRight size={18} /><span><b>{batch?.status === 'COMPLETED' ? summary?.validRows : '—'}</b>条已对账</span></div>
          <div className="story-safety"><ShieldCheck size={19} /><span><strong>Unknown ≠ Failed</strong><small>状态不明，先查 trace。</small></span></div>
        </div>
      </section>

      <section className="steps" aria-label="结算进度">
        {[
          ['01', '读资料', '表格 + 截图'], ['02', '抓异常', '重复 + 换址'], ['03', '付佣金', 'GasFree'], ['04', '回账', '双语回执'],
        ].map(([number, title, caption], index) => <div className={`step ${workflowStep >= index + 1 ? 'active' : ''}`} key={number}><span>{workflowStep > index + 1 ? <Check size={15} /> : number}</span><p><strong>{title}</strong><small>{caption}</small></p></div>)}
      </section>

      <section className="scene-brief" aria-label="演示场景">
        <div><span>MINA · SEOUL AGENCY</span><strong>30 位东南亚创作者，今天结算。</strong></div>
        <ul><li>重复内容</li><li>双昵称</li><li>上月已付</li><li>新地址</li><li>OCR 错 1 字</li></ul>
        <span className={`scene-state ${scenarioPrepared ? 'ready' : ''}`}>{scenarioPrepared ? '故事已就绪' : '先载入完整演示'}</span>
      </section>

      {recoverableBatch && recoverableBatch.id !== batch?.id && <div className="active-batch"><Clock3 size={18} /><div><strong>有一个付款批次等待核查</strong><p>刷新页面不会丢失 UNKNOWN 状态；先处理原批次，再开始新的付款。</p></div><button onClick={resumeSavedBatch}>继续处理</button></div>}

      <details className="pain-section" id="pain"><summary>为什么不能直接复制地址付款 <ChevronDown size={17} /></summary>
        <div className="pain-heading"><div><span className="section-kicker">REAL OPERATIONS</span><h2>问题在付款之前</h2></div><p>资料散，名字乱，地址会变。</p></div>
        <div className="pain-grid">
          <article><span><ReceiptText size={20} /></span><small>资料散</small><h3>一笔佣金，三个来源</h3><p>活动表、内容链接、Telegram 钱包消息并不在一起。</p><b>一条内容编号，一条可追溯记录。</b></article>
          <article><span><ShieldAlert size={20} /></span><small>会重付</small><h3>双昵称，同一个人</h3><p>@ana.moves 和 Ana Cruz 不该变成两个收款人。</p><b>用稳定 payee ID 归并，保留别名。</b></article>
          <article><span><WalletCards size={20} /></span><small>会付错</small><h3>新地址只差一个字</h3><p>格式像地址，也可能是 OCR 误读或临时换址。</p><b>高亮差异，复制双语核验消息。</b></article>
          <article><span><Network size={20} /></span><small>会再付</small><h3>没回应，不等于失败</h3><p>有 trace 就查原付款。状态不明就暂停。</p><b>UNKNOWN 永远不自动重付。</b></article>
        </div>
        <div className="pain-boundary"><AlertTriangle size={16} /><p><strong>公开文档边界：</strong>如果服务端连 traceId 都没有收到，当前不能承诺自动找回。系统只能保留待核查状态，等待人工或 Provider 支持，不能把未知当作失败。</p><a href="https://docs.gasfree.io/" target="_blank" rel="noreferrer">GasFree 文档 <ArrowRight size={13} /></a></div>
      </details>

      {(error || notice) && <div className={`toast ${error ? 'error' : ''}`} role={error ? 'alert' : 'status'} aria-live={error ? 'assertive' : 'polite'}>{error ? <ShieldAlert size={17} /> : <BadgeCheck size={17} />}<span>{error || notice}</span><button aria-label="关闭" onClick={() => { setError(''); setNotice(''); }}><X size={15} /></button></div>}

      <section className="workspace" id="workspace">
        <div className="section-heading"><div><span className="section-kicker">01 / REVIEW</span><h2>只处理异常。</h2><p>内容编号、金额和 TRON 地址确定性校验。</p></div><div className="heading-buttons"><button className="button secondary" onClick={() => fileInput.current?.click()}><FolderInput size={16} />CSV</button><button className="button primary" disabled={busy || !dirty} onClick={validateRows}>{busy ? <LoaderCircle className="spin" size={16} /> : <RefreshCcw size={16} />}重新校验</button></div></div>
        {undoRows && <div className="undo-import"><span>截图已替换账表。尚未生成付款批次。</span><button disabled={busy || Boolean(batch)} onClick={() => { const previous = undoRows; setUndoRows(null); void applyRows(previous, '已撤销截图导入，恢复之前的账表。'); }}><Undo2 size={14} />撤销导入</button></div>}

        <div className="mode-console">
          <div className="mode-choice" role="group" aria-label="结算执行模式"><span>模式</span><button aria-pressed={settlementMode === 'fixture'} className={settlementMode === 'fixture' ? 'active' : ''} disabled={busy} onClick={() => selectSettlementMode('fixture')}>模拟</button><button aria-pressed={settlementMode === 'live'} className={settlementMode === 'live' ? 'active live' : ''} disabled={busy} onClick={() => selectSettlementMode('live')}>Nile 实时</button></div>
          <div className="wallet-state"><WalletCards size={18} /><span><strong>{walletAddress ? short(walletAddress) : 'TronLink 未连接'}</strong><small>{settlementMode === 'live' ? (health?.liveConfigured ? health.note : '服务端还需 GasFree API Key / Secret') : 'fixture 不会调起钱包或外部支付'}</small></span>{settlementMode === 'live' && <button className="button secondary" disabled={busy} onClick={connectWallet}>{walletAddress ? '重新连接' : '连接钱包'}</button>}</div>
        </div>

        <div className="quick-tools" role="group" aria-label="账表快捷操作">
          <button aria-expanded={pasteOpen} aria-controls={pasteOpen ? 'paste-intake' : undefined} className={pasteOpen ? 'active' : ''} onClick={() => setPasteOpen(value => !value)}><ClipboardPaste size={16} /><span><strong>粘贴活动表</strong><small>Excel / Sheets</small></span></button>
          <button aria-pressed={onlyExceptions} className={onlyExceptions ? 'active' : ''} onClick={() => setOnlyExceptions(value => !value)}><ListFilter size={16} /><span><strong>{onlyExceptions ? '显示全部' : `只看异常 ${invalid}`}</strong><small>正常行自动略过</small></span></button>
          <button onClick={inspectOperations} disabled={busy}><ClipboardCheck size={16} /><span><strong>查旧账与换址</strong><small>逐笔对照本机历史</small></span></button>
          <button onClick={copyExceptions} disabled={dirty}><Copy size={16} /><span><strong>复制交接单</strong><small>只含异常</small></span></button>
        </div>

        {pasteOpen && <div className="paste-panel" id="paste-intake">
          <div><span className="panel-icon"><ClipboardPaste size={20} /></span><div><h3>粘贴活动表</h3><p>带表头的 Excel / Sheets 区域。</p></div></div>
          <textarea aria-label="粘贴表格内容" autoFocus value={pasteText} onChange={event => setPasteText(event.target.value)} placeholder={'内容编号\t收款人\t钱包地址\t金额\t备注\nAURORA-SEP-TT-042\t@ana.moves\tT...\t90\tTikTok TT-042'} />
          <div className="paste-actions"><small>需要内容编号、创作者、地址和金额。</small><button className="button primary" disabled={busy || !pasteText.trim()} onClick={importPastedTable}>{busy ? <LoaderCircle className="spin" size={16} /> : <ArrowRight size={16} />}读取</button></div>
        </div>}

        <div className="metric-grid">
          <div className="metric"><span className="metric-icon"><FileSpreadsheet size={19} /></span><p><small>内容</small><strong>{summary?.inputRows ?? rows.length}<em>条</em></strong></p></div>
          <div className="metric"><span className="metric-icon green"><Route size={19} /></span><p><small>付款</small><strong>{summary?.paymentCount ?? '—'}<em>笔</em></strong></p></div>
          <div className="metric"><span className="metric-icon amber"><AlertTriangle size={19} /></span><p><small>异常</small><strong>{exceptionRowCount}<em>行</em></strong></p></div>
          <div className="metric"><span className="metric-icon violet"><CircleDollarSign size={19} /></span><p><small>{plan?.mode === 'live' ? '实时合并节省' : '演示费率差额'}</small><strong>{money(summary?.feeSavingsMicros)}<em>USDT</em></strong></p></div>
        </div>

        {opsReport && <div className="ops-report">
          <div className="ops-report-head"><div><ClipboardCheck size={19} /><span><strong>旧账与地址</strong><small>本机 fixture 逐笔对照</small></span></div>{historyRiskCount > 0 && <button className="button warning" onClick={deferHistoryRows}>暂缓 {historyRiskCount} 条已付 / 待查</button>}</div>
          <div className="ops-stats"><span><b>{opsReport.summary.settled}</b>历史已结算</span><span><b>{opsReport.summary.unresolved}</b>历史待核查</span><span><b>{opsReport.summary.addressChanged}</b>收款地址变化</span><span><b>{opsReport.summary.newPayees}</b>首次收款人</span></div>
          {(historyRiskCount > 0 || opsReport.summary.addressChanged > 0) && <div className="ops-findings">{opsReport.items.filter(item => item.historyStatus !== 'NEW' || item.addressStatus === 'CHANGED').map(item => <div key={item.rowId}><code>{item.invoiceId}</code><span>{item.historyStatus === 'SETTLED' ? '历史已结算' : item.historyStatus === 'UNRESOLVED' ? '原付款待核查' : '业务单未见历史'}</span>{item.addressStatus === 'CHANGED' && <span>地址已变化：{short(item.previousAddress)}</span>}</div>)}</div>}
        </div>}

        <div className="work-grid">
          <div className="card ledger-card">
            <div className="card-head"><div><h3>佣金明细</h3><p>{valid} 条可付 · {invalid} 条隔离</p></div><span className="small-badge">6 位精度</span></div>
            <div className="table-scroll">
              <table>
                <thead><tr><th>活动·内容 / 创作者</th><th>TRON 地址</th><th>佣金</th><th>来源</th><th>校验</th><th /></tr></thead>
                <tbody>{visibleRows.map(row => {
                  const codes = new Set(row.issues.map(issue => issue.code));
                  const operation = opsById.get(row.id);
                  const aliases = aliasesByPayee.get(row.payeeId) || [];
                  const peerAddress = displayRows.find(candidate => candidate.id !== row.id && candidate.payeeId === row.payeeId
                    && !candidate.issues.some(issue => issue.code === 'INVALID_ADDRESS'))?.address;
                  const referenceAddress = operation?.previousAddress || (codes.has('INVALID_ADDRESS') ? peerAddress : undefined);
                  return <tr key={row.id} id={`business-${row.id}`} className={`${row.status === 'INVALID' ? 'row-invalid' : ''} ${matchedIds.includes(row.id) ? 'row-matched' : ''}`}>
                  <td><input aria-label={`第 ${row.line} 行内容编号`} value={row.invoiceId} onChange={event => editRow(row.id, 'invoiceId', event.target.value)} /><span className="sub-input">{row.payeeName} · {row.payeeId}</span><span className="row-flags">{aliases.length > 1 && <b className="flag violet">{aliases.length} 个别名 · 同一 payee</b>}{operation?.historyStatus === 'SETTLED' && <b className="flag danger">上月已付</b>}{operation?.historyStatus === 'UNRESOLVED' && <b className="flag warning">原付款待查</b>}{operation?.addressStatus === 'CHANGED' && <b className="flag warning">新地址</b>}{operation?.addressStatus === 'MATCH' && <b className="flag good">常用地址</b>}{row.reviewedOverLimit && <b className="flag good">金额已复核</b>}{row.reviewedAddressChange && <b className="flag good">新地址已核对</b>}</span></td>
                  <td><input id={`address-${row.id}`} className="address-input" aria-label={`第 ${row.line} 行地址`} value={row.address} onChange={event => editRow(row.id, 'address', event.target.value)} />{referenceAddress && referenceAddress !== row.address && <AddressDiff previous={referenceAddress} current={row.address} />}</td>
                  <td><label className="amount-input"><input aria-label={`第 ${row.line} 行金额`} value={row.amount} onChange={event => editRow(row.id, 'amount', event.target.value)} /><span>USDT</span></label></td>
                  <td><input aria-label={`第 ${row.line} 行备注`} value={row.note} onChange={event => editRow(row.id, 'note', event.target.value)} /></td>
                  <td><IssuePill row={row} /></td>
                  <td>{row.status === 'INVALID' || Boolean(operation && (operation.historyStatus !== 'NEW' || operation.addressStatus === 'CHANGED')) ? <div className="row-actions">
                    {codes.has('INVALID_ADDRESS') && referenceAddress && <button onClick={() => applyReferenceAddress(row.id, referenceAddress)}>用参考地址修正</button>}
                    {codes.has('INVALID_ADDRESS') && <button onClick={() => { const input = document.getElementById(`address-${row.id}`) as HTMLInputElement | null; input?.focus(); input?.select(); }}>手动修改</button>}
                    {referenceAddress && referenceAddress !== row.address && <button onClick={() => copyAddressCheck(row, referenceAddress)}>复制核址消息</button>}
                    {codes.has('DUPLICATE_INVOICE') && <button onClick={() => deferRow(row.id, '同一内容编号重复申报，本批暂缓')}>暂缓重复内容</button>}
                    {codes.has('DUPLICATE_INVOICE') && <button onClick={() => generateUniqueInvoice(row.id)}>确为独立内容</button>}
                    {codes.has('ANOMALOUS_AMOUNT') && <button onClick={() => approveHighAmount(row.id)}>确认已复核</button>}
                    {operation && operation.historyStatus !== 'NEW' && !row.deferred && <button onClick={() => deferRow(row.id, operation.historyStatus === 'SETTLED' ? '历史批次已结算，本批暂缓' : '历史付款待核查，本批暂缓')}>暂缓本批</button>}
                    {operation?.addressStatus === 'CHANGED' && operation.historyStatus === 'NEW' && !row.deferred && <>{!row.reviewedAddressChange && <button onClick={() => approveAddressChange(row.id)}>核址并应用到该达人</button>}<button onClick={() => deferRow(row.id, '收款地址发生变化，等待人工确认')}>暂缓核址</button></>}
                    {!codes.has('INVALID_ADDRESS') && !codes.has('DUPLICATE_INVOICE') && !codes.has('ANOMALOUS_AMOUNT') && (!operation || (operation.historyStatus === 'NEW' && operation.addressStatus !== 'CHANGED')) && <span className="isolated-row">暂缓结算</span>}
                  </div> : <button className="remove-row" aria-label={`删除第 ${row.line} 行`} title="从本次结算删除" onClick={() => removeRow(row.id)}><X size={15} /></button>}</td>
                </tr>;})}</tbody>
              </table>
            </div>
            {onlyExceptions && visibleRows.length === 0 && <div className="empty-filter"><BadgeCheck size={18} /><strong>当前没有需要人工处理的业务</strong><span>切换“显示全部”后可以核对可结算明细。</span></div>}
            {dirty && <div className="dirty-note"><AlertTriangle size={15} />内容已修改。重新校验后才能生成新批次。</div>}
          </div>

          <aside className="card plan-card">
            <div className="card-head"><div><h3>合并佣金</h3><p>同 payee · 同地址 · 同币种</p></div><Layers3 size={20} /></div>
            <div className="merge-visual"><span><b>{summary?.validRows ?? 0}</b><small>业务行</small></span><div><i /><i /><i /></div><span><b>{summary?.paymentCount ?? 0}</b><small>GasFree 支付</small></span></div>
            <div className="cost-lines">
              <div><span>不合并预计费用</span><del>{money(summary?.unmergedFeeMicros)} USDT</del></div>
              <div><span>合并后预计费用</span><strong>{money(summary?.mergedFeeMicros)} USDT</strong></div>
              <div className="total"><span>本金与预计费用</span><strong>{money(summary?.totalDebitMicros)} USDT</strong></div>
            </div>
            <p className="assumption"><Gauge size={15} />{plan?.feeNote || '演示费率仅用于本地方案比较。'}</p>
            {settlementMode === 'live' && preflight && <div className={`preflight-card ${preflight.ready ? '' : 'blocked'}`}>
              <div><span>GasFree 账户</span><code title={preflight.gasFreeAddress}>{preflight.gasFreeAddress}</code></div>
              <div><span>代币 / 服务商</span><strong>{preflight.selectedToken.symbol} · {preflight.selectedProvider.name}</strong></div>
              <div><span>链上余额</span><strong>{exactMoney(preflight.balanceMicros)} USDT</strong></div>
              <div><span>冻结 / 可用</span><strong>{exactMoney(preflight.frozenMicros)} / {exactMoney(preflight.availableMicros)}</strong></div>
              <div><span>激活 / 转账费</span><strong>{money(preflight.activationFeeMicros)} / {money(preflight.transferFeeMicros)}</strong></div>
              {!preflight.ready && preflight.blockers.map(blocker => <p key={blocker.code}><AlertTriangle size={12} />{blocker.message}</p>)}
              <small>{preflight.active ? '账户已激活' : '首笔将收取激活费'} · nonce {preflight.nonce} · {new Date(preflight.checkedAt).toLocaleTimeString('zh-CN', { hour12: false })}</small>
              <details className="preflight-extra"><summary>完整网络与服务商参数</summary><p>付款人 EOA<code>{preflight.payerAddress}</code></p><p>USDT 合约<code>{preflight.selectedToken.tokenAddress}</code></p><p>代付服务商<code>{preflight.selectedProvider.address}</code></p><p>Nile chainId {preflight.chainId} · 最多 {preflight.selectedProvider.config.maxPendingTransfer} 笔 pending</p><p>授权期限 {preflight.selectedProvider.config.minDeadlineDuration}–{preflight.selectedProvider.config.maxDeadlineDuration} 秒 · {preflight.allowSubmit ? '当前允许提交' : '当前禁止提交'}</p></details>
            </div>}
            <button className="button primary wide" disabled={busy || dirty || !plan || !plan.payments.length || (settlementMode === 'live' && (!walletAddress || !health?.liveConfigured))} onClick={createBatch}><Fingerprint size={17} />{settlementMode === 'live' ? '实时预检' : '生成结算清单'}</button>
            <p className="button-note">地址或金额一变，清单作废。</p>
          </aside>
        </div>
      </section>

      <section className="execution" id="execution">
        <div className="section-heading inverse"><div><span className="section-kicker">02 / PAY</span><h2>状态不明，不重付。</h2><p>{batch?.mode === 'live' ? 'TronLink 逐笔签名。有 trace 只查原付款。' : '模拟第二笔响应丢失，再用原 trace 恢复。'}</p></div>{batch && <span className={`batch-status ${batch.status.toLowerCase()}`}>{statusLabel[batch.status]}</span>}</div>

        {!batch ? <div className="execution-empty"><Network size={30} /><h3>生成结算清单后，这里会出现付款队列</h3><p>{settlementMode === 'live' ? '先读取 GasFree 账户、支持币种、可用余额与动态费用；确认清单后才会逐笔请求钱包签名。' : '故障测试会让第二笔的浏览器响应丢失；服务端已持久化原 trace，恢复时只查询这次尝试。'}</p></div> : <div className="execution-grid">
          <div className="queue-panel">
            <div className="queue-head"><div><span>批次 {short(batch.id)}</span><strong>{batch.payments.length} 笔串行支付</strong></div><div><span>{batch.mode === 'live' ? '本地确定性 manifest' : '清单摘要'}</span><code title={batch.manifestHash || batch.planDigest}>{short(batch.manifestHash || batch.planDigest)}</code></div></div>
            <div className="payments">{batch.plan.payments.map(payment => <PaymentCard key={payment.id} payment={payment} rows={batch.plan.rows} execution={batch.payments.find(item => item.id === payment.id)} onCopyReceipt={copyReceipt} />)}</div>
            <div className="queue-actions">
              {batch.status === 'DRAFT' && <button className="button light" disabled={busy} onClick={confirmBatch}><FileCheck2 size={16} />确认金额与收款人</button>}
              {batch.status === 'CONFIRMED' && (batch.mode === 'live' ? <button className="button danger" disabled={busy} onClick={signAndSubmitNext}>{busy ? <LoaderCircle className="spin" size={16} /> : <Fingerprint size={16} />}在 TronLink 核对并签名下一笔</button> : <button className="button danger" disabled={busy} onClick={runBatch}>{busy ? <LoaderCircle className="spin" size={16} /> : <Play size={16} />}运行浏览器丢包测试</button>)}
              {batch.status === 'PAUSED' && (batch.mode === 'live' && !batch.payments.some(payment => payment.status === 'PROCESSING' || payment.status === 'UNKNOWN')
                ? <button className="button warning" disabled={busy} onClick={signAndSubmitNext}>{busy ? <LoaderCircle className="spin" size={16} /> : <Fingerprint size={16} />}复核失败项后签名下一笔</button>
                : <button className="button warning" disabled={busy} onClick={recoverBatch}>{busy ? <LoaderCircle className="spin" size={16} /> : <RefreshCcw size={16} />}查询原 trace 的结果</button>)}
              {batch.status === 'COMPLETED' && <><button className="button light" onClick={() => downloadUrl(`/batches/${batch.id}/export/business.csv`)}><Download size={16} />业务明细 CSV</button><button className="button ghost" onClick={() => downloadUrl(`/batches/${batch.id}/export/payments.csv`)}><Download size={16} />支付汇总 CSV</button></>}
              {(batch.status === 'PAUSED' || batch.status === 'COMPLETED') && <button className="button ghost" onClick={() => downloadUrl(`/batches/${batch.id}/export/package.zip`)}><PackageOpen size={16} />一键对账包</button>}
              <span className="simulation-note"><ShieldCheck size={14} />{batch.mode === 'live' ? '私钥不离开 TronLink；签名提交给服务端，服务端不读取私钥' : '本地故障注入，不生成真实交易哈希'}</span>
            </div>
          </div>

          <aside className="event-panel">
            <h3>恢复证据</h3>
            <p>付款尝试、状态查询和队列恢复都保留时间线。</p>
            <div className="event-list">{batch.events.slice().reverse().map((event, index) => <div className="event" key={event.id}><span className={index === 0 ? 'latest' : ''}>{event.kind.includes('UNKNOWN') ? <AlertTriangle size={14} /> : event.kind.includes('RECOVER') ? <RefreshCcw size={14} /> : <Check size={14} />}</span><div><strong>{event.title}</strong><p>{event.detail}</p><small>{new Date(event.at).toLocaleTimeString('zh-CN', { hour12: false })}</small></div></div>)}</div>
            {batch.status === 'PAUSED' && <div className="unknown-proof"><Clock3 size={18} /><div><strong>{unknown ? `${unknown} 笔处理中 / 待核查` : `${failed} 笔已失败`}</strong><p>{unknown ? '队列已经暂停。恢复按钮只查询原 trace，不调用第二次 submit。' : '失败结果保留原因。复核后可继续下一笔，失败项需新授权才能重试。'}</p></div></div>}
            {batch.status === 'COMPLETED' && <div className="reconcile-proof"><ClipboardCheck size={18} /><div><strong>{batch.mode === 'live' ? `${confirmedPayments} 笔成功 · ${failed} 笔失败 · 0 笔待确认` : `${reconciledRows}/${batch.plan.summary.inputRows} 条原始业务已有明确去向`}</strong><p>{resolvedRows || reconciledRows} 条业务已回填付款结果，{batch.plan.summary.invalidRows} 条保留为暂缓或异常；本金映射仍与原表一致。</p></div></div>}
          </aside>
        </div>}
      </section>

      <section className="integration" id="integration">
        <div className="section-heading"><div><span className="section-kicker">03 / PROOF</span><h2>真实状态，直接说。</h2><p>没有真实 trace 和 txHash，就不写成链上证据。</p></div></div>
        <div className="integration-grid">
          <div className="integration-card ready"><span><FileCheck2 size={20} /></span><div><small>LOCAL PRODUCT FLOW</small><h3>本地闭环已就绪</h3><p>导入、校验、合并、清单绑定、未知状态恢复和双层对账。</p></div><BadgeCheck size={20} /></div>
          <div className={`integration-card ${health?.liveEnabled ? 'ready' : 'waiting'}`}><span><WalletCards size={20} /></span><div><small>GASFREE NILE</small><h3>{health?.liveEnabled ? '真实提交已显式启用' : health?.gasFree.configured ? '凭据已配置 · submit 尚关闭' : '等待官方 API 凭据'}</h3><p>{health?.note || 'API Key 与 Secret 只保存在服务端。'}</p></div>{health?.liveEnabled ? <BadgeCheck size={20} /> : <Clock3 size={20} />}</div>
          <div className={`integration-card ${batch?.payments.some(payment => payment.status === 'CONFIRMED' && payment.chainVerification?.status === 'VERIFIED') ? 'ready' : 'waiting'}`}><span><Link2 size={20} /></span><div><small>ON-CHAIN EVIDENCE</small><h3>{batch?.payments.some(payment => payment.status === 'CONFIRMED' && payment.chainVerification?.status === 'VERIFIED') ? 'Nile 固化回执已独立核验' : batch?.payments.some(payment => payment.txHash) ? '已有哈希 · 等待完整关联' : '真实交易尚未验证'}</h3><p>{batch?.payments.some(payment => payment.status === 'CONFIRMED' && payment.chainVerification?.status === 'VERIFIED') ? 'RPC 证明精确 Transfer；trace→tx 由 GasFree 返回，本机还检查 tx/log 未被其他付款占用。' : '需取得 GasFree trace→tx 结果，并由 Nile Solidity RPC 找到未被复用的精确 Transfer 日志。'}</p></div>{batch?.payments.some(payment => payment.status === 'CONFIRMED' && payment.chainVerification?.status === 'VERIFIED') ? <BadgeCheck size={20} /> : <Clock3 size={20} />}</div>
        </div>
      </section>
    </main>

    <footer><div><Route size={17} /><strong>SettleMap</strong><span>Campaign work in. Accounted payouts out.</span></div><span>韩国代理商 → 东南亚创作者</span><a href="https://drive.google.com/file/d/1HXLhu1_vCoMD5aN3APEYEjDrh9oVCj7g/view" target="_blank" rel="noreferrer"><ReceiptText size={15} />TRON C</a></footer>
    {screenshotOpen && <ScreenshotImport initialFile={screenshotFile} disabled={busy} onClose={() => { setScreenshotOpen(false); setScreenshotFile(undefined); }} onApply={applyScreenshot} />}
    {commandsOpen && <CommandMenu onClose={() => setCommandsOpen(false)} onPaste={openPaste} onScreenshot={() => openScreenshot()} onExceptions={() => { setOnlyExceptions(true); showWorkspace(); }} onInspect={() => { showWorkspace(); void inspectOperations(); }} onResume={continueUnsettled} canResume={Boolean(recoverableBatch || (batch && batch.status !== 'COMPLETED'))} busy={busy} />}
    {handoffText && <Dialog title="手动复制" onClose={() => setHandoffText('')} className="handoff-dialog"><p className="inline-error">剪贴板不可用。请选中下方内容复制。</p><textarea aria-label="待复制文本" readOnly value={handoffText} onFocus={event => event.target.select()} /><p>分享前请核对收件人和业务范围。</p></Dialog>}
  </div>;
}
