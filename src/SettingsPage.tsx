import { useEffect, useState } from 'react';
import { checkWorkflow, getSettings, saveSettings, testCodex, testComfy } from './codex';
import type { Settings } from './codex';

export default function SettingsPage() {
  const [draft, setDraft] = useState<Settings | null>(null);
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  useEffect(() => { getSettings().then(setDraft).catch(e => setError((e as Error).message)); }, []);
  function codex<K extends keyof Settings['codex']>(key: K, value: Settings['codex'][K]) {
    setDraft(s => s ? { ...s, codex: { ...s.codex, [key]: value } } : s);
  }
  function comfy<K extends keyof Settings['comfy']>(key: K, value: Settings['comfy'][K]) {
    setDraft(s => s ? { ...s, comfy: { ...s.comfy, [key]: value } } : s);
  }
  async function action(name: string, run: () => Promise<string>) {
    setBusy(name); setError(''); setMessage('');
    try { setMessage(await run()); } catch (e) { setError((e as Error).message); }
    finally { setBusy(''); }
  }
  if (!draft) return <div className="settings-page"><div className="eyebrow">LOCAL SETTINGS</div><h1>设置</h1><p className="muted">{error || '正在加载本机设置…'}</p><button className="btn" onClick={() => getSettings().then(setDraft).catch(e => setError((e as Error).message))}>重试</button></div>;
  return <div className="settings-page">
    <div className="page-heading"><div><div className="eyebrow">LOCAL SETTINGS</div><h1>设置</h1><p>配置本机 Codex 与 ComfyUI。设置只保存在当前电脑，新任务会使用更新后的参数。</p></div><button className="btn primary" disabled={!!busy} onClick={() => action('save', async () => { setDraft(await saveSettings(draft)); return '设置已保存。新启动的任务会使用这些参数。'; })}>{busy === 'save' ? '保存中…' : '保存设置'}</button></div>
    {error && <div className="codex-error">{error}</div>}{message && <div className="settings-success">{message}</div>}
    <section className="panel settings-panel"><div className="section-heading"><h2>Codex</h2><span className="eyebrow">本机 CLI</span></div><p className="muted">使用本机已登录的 Codex。模型和推理强度会应用到新建的创作任务及顾问对话。</p>
      <div className="settings-fields"><label>模型<input list="codex-model-list" value={draft.codex.model} onChange={e => codex('model', e.target.value)} placeholder="例如 gpt-5.5"/><datalist id="codex-model-list"><option value="gpt-5.5"/><option value="gpt-6-sol"/><option value="gpt-6-luna"/></datalist><small>模型必须已对当前 Codex 账号开放；默认 gpt-5.5。</small></label>
      <label>推理强度<select value={draft.codex.reasoningEffort} onChange={e => codex('reasoningEffort', e.target.value as Settings['codex']['reasoningEffort'])}><option value="low">低 · 更快</option><option value="medium">中</option><option value="high">高</option><option value="xhigh">极高</option></select></label>
      <label>单阶段超时（分钟）<input type="number" min="1" max="180" value={draft.codex.timeoutMinutes} onChange={e => codex('timeoutMinutes', Number(e.target.value))}/></label></div><button className="btn" disabled={!!busy} onClick={() => action('codex', async () => { const result = await testCodex(draft.codex); return `Codex 模型 ${result.model} 可用 · ${result.reply}`; })}>{busy === 'codex' ? '测试中…' : '测试 Codex 模型'}</button>
    </section>
    <section className="panel settings-panel"><div className="section-heading"><h2>本地 ComfyUI</h2><span className="eyebrow">IMAGE WORKFLOW</span></div><p className="muted">填写本机地址并导入 ComfyUI 导出的 API 格式工作流。连接测试只读取系统信息，不会排队生成图片。</p>
      <div className="settings-url-row"><label>服务地址<input value={draft.comfy.baseUrl} onChange={e => comfy('baseUrl', e.target.value)} placeholder="http://127.0.0.1:8188"/></label><button className="btn" disabled={!!busy} onClick={() => action('connection', async () => { const result = await testComfy(draft.comfy.baseUrl); return `连接成功 · ComfyUI ${result.version || '版本未知'}${result.devices.length ? ` · ${result.devices.join('、')}` : ''}`; })}>{busy === 'connection' ? '连接中…' : '测试连接'}</button></div>
      <div className="settings-workflow-head"><h3>工作流 JSON</h3><label className="btn small">导入文件<input type="file" accept=".json,application/json" onChange={async e => { const file = e.target.files?.[0]; if (!file) return; if (file.size > 2_000_000) return setError('工作流 JSON 不得超过 2 MB。'); comfy('workflowJson', await file.text()); setMessage(`已导入 ${file.name}，请检查节点映射并保存。`); setError(''); }}/></label></div>
      <textarea className="settings-workflow" value={draft.comfy.workflowJson} onChange={e => comfy('workflowJson', e.target.value)} placeholder="粘贴或导入 ComfyUI API 格式工作流 JSON" spellCheck={false}/>
      <div className="settings-fields"><label>正向提示词节点 ID<input value={draft.comfy.promptNodeId} onChange={e => comfy('promptNodeId', e.target.value)} placeholder="如 6"/></label><label>提示词输入字段<input value={draft.comfy.promptInput} onChange={e => comfy('promptInput', e.target.value)} placeholder="text"/></label><label>种子节点 ID · 可选<input value={draft.comfy.seedNodeId} onChange={e => comfy('seedNodeId', e.target.value)}/></label><label>种子输入字段<input value={draft.comfy.seedInput} onChange={e => comfy('seedInput', e.target.value)}/></label></div>
      <button className="btn" disabled={!draft.comfy.workflowJson || !!busy} onClick={() => action('workflow', async () => { const result = await checkWorkflow(draft.comfy.workflowJson, draft.comfy.promptNodeId, draft.comfy.promptInput); return `工作流格式有效，包含 ${result.nodeCount} 个节点。`; })}>{busy === 'workflow' ? '检查中…' : '检查工作流'}</button>
      <h3 className="settings-subtitle">默认生成参数</h3><div className="settings-fields">{([['width', '宽度'], ['height', '高度'], ['steps', '采样步数'], ['cfg', 'CFG'], ['seed', '随机种子（-1 为随机）']] as const).map(([key, label]) => <label key={key}>{label}<input type="number" value={draft.comfy[key]} onChange={e => comfy(key, Number(e.target.value))}/></label>)}</div>
      <p className="hint settings-footnote">工作流和参数会保存供 ComfyUI 出图使用；当前图片按钮仍显示模拟结果。</p>
    </section>
  </div>;
}
