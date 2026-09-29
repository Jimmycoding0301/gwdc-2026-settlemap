import { useEffect, useRef, useState } from 'react';
import { ArrowRight, FileImage, LoaderCircle, ShieldCheck, Upload } from 'lucide-react';
import type { InputRow } from '../shared/types';
import type { SettlementExtraction } from '../shared/settlement-ocr';
import { post } from './api';
import { Dialog } from './Dialog';

export function validateScreenshotFile(file: Pick<File, 'type' | 'size'>): void {
  if (!['image/png', 'image/jpeg'].includes(file.type)) throw new Error('只接受 PNG 或 JPEG 截图；不会读取外部图片链接。');
  if (!file.size || file.size > 1_048_576) throw new Error('截图需要在 1 MiB 以内，请裁剪后再试。');
}

/** Retain text only; OCR may never grant review flags or a pre-existing payment identity. */
export function editableOcrRows(extraction: SettlementExtraction): InputRow[] {
  if (extraction?.source !== 'local-vision' || !Array.isArray(extraction.drafts) || extraction.drafts.length > 100) throw new Error('本地识别响应格式异常。');
  return extraction.drafts.map((draft, index) => {
    const row = Object.fromEntries(['invoiceId', 'payeeId', 'payeeName', 'address', 'token', 'amount', 'note'].map(field => {
      const value = draft.row?.[field as keyof InputRow];
      if (typeof value !== 'string' || value.length > 2000) throw new Error('识别字段无效，请重新截取表格。');
      return [field, value];
    })) as unknown as InputRow;
    return { ...row, id: `ocr_import_${index + 1}` };
  });
}

export function ScreenshotImport({ initialFile, onClose, onApply, disabled }: {
  initialFile?: File; onClose: () => void; onApply: (rows: InputRow[], mode: 'append' | 'replace') => Promise<void>; disabled: boolean;
}) {
  const [imageDataUrl, setImageDataUrl] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<SettlementExtraction | null>(null);
  const [drafts, setDrafts] = useState<InputRow[]>([]);
  const [confirmed, setConfirmed] = useState(false);
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const alive = useRef(true);
  const selection = useRef(0);
  const readerRef = useRef<FileReader | null>(null);
  useEffect(() => { alive.current = true; return () => { alive.current = false; selection.current++; readerRef.current?.abort(); readerRef.current = null; }; }, []);
  async function choose(file: File) {
    const token = ++selection.current;
    readerRef.current?.abort(); readerRef.current = null;
    setError(''); setResult(null); setDrafts([]); setConfirmed(false); setImageDataUrl(''); setName('');
    try {
      validateScreenshotFile(file);
      const data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader(); readerRef.current = reader;
        reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('无法读取本地图片。'));
        reader.onerror = () => reject(new Error('无法读取本地图片。'));
        reader.onabort = () => reject(new Error('读取已取消。'));
        reader.readAsDataURL(file);
      });
      if (alive.current && selection.current === token) { readerRef.current = null; setImageDataUrl(data); setName(file.name || '粘贴的截图'); }
    } catch (caught) { if (alive.current && selection.current === token) setError((caught as Error).message); }
  }
  useEffect(() => { if (initialFile) void choose(initialFile); }, [initialFile]);
  async function recognize() {
    setBusy(true); setError(''); setConfirmed(false);
    try {
      const extraction = await post<SettlementExtraction>('/intake/screenshot', { imageDataUrl });
      const rows = editableOcrRows(extraction);
      if (alive.current) { setResult(extraction); setDrafts(rows); }
    } catch (caught) { if (alive.current) setError((caught as Error).message); }
    finally { if (alive.current) setBusy(false); }
  }
  function change(index: number, field: keyof InputRow, value: string) {
    setDrafts(rows => rows.map((row, position) => position === index ? { ...row, [field]: value } : row));
    setConfirmed(false);
  }
  function closeDialog() { selection.current++; readerRef.current?.abort(); readerRef.current = null; setImageDataUrl(''); setResult(null); setDrafts([]); onClose(); }
  async function apply(mode: 'append' | 'replace') {
    setBusy(true); setError('');
    try { await onApply(drafts, mode); if (alive.current) closeDialog(); }
    catch (caught) {
      const message = (caught as Error).message || '校验失败。';
      if (alive.current) setError(`未导入：${message} 请修正草稿后重试。`);
    }
    finally { if (alive.current) setBusy(false); }
  }
  return <Dialog title="截图变草稿" onClose={closeDialog} className="screenshot-dialog">
    <p className="dialog-description"><ShieldCheck size={16} />仅本机识别。图片不离开此 Mac。</p>
    <div className={`image-drop ${dragging ? 'dragging' : ''}`} data-autofocus tabIndex={0} role="region" aria-label="粘贴或拖入结算截图"
      onDragOver={event => { event.preventDefault(); if (!busy) setDragging(true); }} onDragLeave={() => setDragging(false)}
      onDrop={event => { event.preventDefault(); setDragging(false); if (!busy && event.dataTransfer.files[0]) void choose(event.dataTransfer.files[0]); }}
      onPaste={event => { const file = [...event.clipboardData.items].find(item => item.type.startsWith('image/'))?.getAsFile(); if (file && !busy) { event.preventDefault(); void choose(file); } }}>
      <input ref={input} type="file" hidden accept="image/png,image/jpeg" onChange={event => { const file = event.target.files?.[0]; if (file) void choose(file); event.target.value = ''; }} />
      {imageDataUrl ? <img src={imageDataUrl} alt="待识别结算截图的本地预览" /> : <><FileImage size={28} /><strong>粘贴或拖入截图</strong><span>活动表格，或带标签的 Telegram 钱包消息</span></>}
      <div className="image-drop-actions"><button className="button secondary" disabled={busy} onClick={() => input.current?.click()}><Upload size={15} />{imageDataUrl ? '更换截图' : '选择 PNG / JPEG'}</button><small>{name || '≤ 1 MiB · ≤ 1200 万像素'}</small></div>
    </div>
    {error && <p className="inline-error" role="alert">{error}</p>}
    {!result && <div className="dialog-actions"><span>点击后才读取。</span><button className="button primary" disabled={!imageDataUrl || busy} onClick={recognize}>{busy ? <LoaderCircle size={16} className="spin" /> : <ArrowRight size={16} />}{busy ? '识别中…' : '识别草稿'}</button></div>}
    {result && <div className="ocr-result">
      <div className="ocr-result-heading"><h3>{drafts.length} 条草稿</h3><span>{result.format === 'labeled-message' ? 'Telegram 消息' : '活动表格'} · 请核对</span></div>
      <ul className="ocr-warnings">{result.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>
      <div className="ocr-drafts">{drafts.map((row, index) => <article key={row.id}>
        <div className="ocr-row-heading"><strong>第 {index + 1} 行</strong><span className={`confidence ${result.drafts[index].confidence}`}>{({ high: '较清晰 · 仍需核对', medium: '部分模糊', low: '重点核对' })[result.drafts[index].confidence]}</span></div>
        <div className="ocr-fields">{([['invoiceId', '活动 / 内容编号'], ['payeeName', '创作者'], ['payeeId', '达人编号'], ['token', '币种'], ['address', 'TRON 地址'], ['amount', '佣金'], ['note', '来源']] as const).map(([field, label]) => <label key={field} className={field === 'address' || field === 'note' ? 'full' : ''}>{label}<input aria-label={`草稿第 ${index + 1} 行${label}`} value={row[field]} onChange={event => change(index, field, event.target.value)} /></label>)}</div>
        {result.drafts[index].warnings.length > 0 && <p className="ocr-row-warning">{result.drafts[index].warnings.join('；')}</p>}
        <details><summary>对照这一行识别原文</summary><pre>{result.drafts[index].original}</pre></details>
      </article>)}</div>
      {drafts.length > 0 && <label className="explicit-confirm"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />已核对地址、金额和币种。</label>}
      <div className="dialog-actions"><span>只改草稿。不付款。</span><div className="ocr-apply-actions"><button className="button secondary" disabled={!drafts.length || !confirmed || busy || disabled} onClick={() => apply('replace')}>替换账表</button><button className="button primary" disabled={!drafts.length || !confirmed || busy || disabled} onClick={() => apply('append')}><ArrowRight size={16} />追加并校验</button></div></div>
    </div>}
  </Dialog>;
}
