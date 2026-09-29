import { useState } from 'react';
import { ArrowRight, ClipboardPaste, Clock3, FileImage, ListFilter, Search, ShieldCheck } from 'lucide-react';
import { Dialog } from './Dialog';

export function CommandMenu({ onClose, onPaste, onScreenshot, onExceptions, onInspect, onResume, canResume, busy }: {
  onClose: () => void; onPaste: () => void; onScreenshot: () => void; onExceptions: () => void; onInspect: () => void; onResume: () => void; canResume: boolean; busy: boolean;
}) {
  const [query, setQuery] = useState('');
  const actions = [
    { title: '粘贴结算表', detail: '打开 TSV / CSV 文本导入', icon: ClipboardPaste, run: onPaste, disabled: busy },
    { title: '从截图整理账表', detail: '本机识别，人工确认后导入', icon: FileImage, run: onScreenshot, disabled: busy },
    { title: '只看异常与待处理', detail: '聚焦当前工作台，不修改业务', icon: ListFilter, run: onExceptions, disabled: false },
    { title: '检查历史与收款地址', detail: '查询本机账本，避免重复付款', icon: ShieldCheck, run: onInspect, disabled: busy },
    { title: '继续未结算批次', detail: '跳到原批次，不自动签名或重付', icon: Clock3, run: onResume, disabled: busy || !canResume },
  ].filter(action => `${action.title}${action.detail}`.includes(query.trim()));
  return <Dialog title="接下来，做什么？" onClose={onClose} className="command-dialog">
    <label className="command-search"><Search size={18} /><input data-autofocus value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索快捷操作" aria-label="搜索快捷操作" /></label>
    <div className="command-list">{actions.map(({ title, detail, icon: Icon, run, disabled }) => <button key={title} disabled={disabled} onClick={() => { onClose(); run(); }}><Icon size={19} /><span><strong>{title}</strong><small>{detail}</small></span><ArrowRight size={16} /></button>)}</div>
    {!actions.length && <p className="command-empty">没有匹配操作，试试“粘贴”或“历史”。</p>}
    <p className="command-foot">⌘ / Ctrl K 打开 · Tab 选择 · Esc 关闭</p>
  </Dialog>;
}
