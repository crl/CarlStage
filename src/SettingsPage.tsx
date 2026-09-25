import { useEffect, useState } from 'react';
import { checkWorkflow, getSettings, saveSettings, testCodex, testComfy } from './codex';
import type { Settings } from './codex';

type WorkflowKind = 'image' | 'video';
export default function SettingsPage() {
  const [draft, setDraft] = useState<Settings | null>(null);
  const [busy, setBusy] = useState(''); const [message, setMessage] = useState(''); const [error, setError] = useState('');
  useEffect(() => { getSettings().then(setDraft).catch(e => setError((e as Error).message)); }, []);
  function codex<K extends keyof Settings['codex']>(key: K, value: Settings['codex'][K]) { setDraft(s => s ? { ...s, codex: { ...s.codex, [key]: value } } : s); }
  function comfyUrl(value: string) { setDraft(s => s ? { ...s, comfy: { ...s.comfy, baseUrl: value } } : s); }
  function workflow(kind: WorkflowKind, key: string, value: string | number) { setDraft(s => s ? { ...s, comfy: { ...s.comfy, [kind]: { ...s.comfy[kind], [key]: value } } } : s); }
  async function action(name: string, run: () => Promise<string>) { setBusy(name); setError(''); setMessage(''); try { setMessage(await run()); } catch (e) { setError((e as Error).message); } finally { setBusy(''); } }
  if (!draft) return <div className="settings-page"><h1>设置</h1><p className="muted">{error || '正在加载本机设置…'}</p><button className="btn" onClick={() => getSettings().then(setDraft).catch(e => setError((e as Error).message))}>重试</button></div>;
  const field = (kind: WorkflowKind, label: string, id: string, input: string, optional = false) => <div className="settings-fields" key={`${kind}-${id}`}><label>{label}节点 ID{optional ? ' · 可选' : ''}<input value={String(draft.comfy[kind][id as keyof typeof draft.comfy[typeof kind]])} onChange={e => workflow(kind, id, e.target.value)} placeholder="如 6"/></label><label>输入字段<input value={String(draft.comfy[kind][input as keyof typeof draft.comfy[typeof kind]])} onChange={e => workflow(kind, input, e.target.value)}/></label></div>;
  const section = (kind: WorkflowKind) => {
    const config = draft.comfy[kind]; const image = kind === 'image';
    return <section className="panel settings-panel" key={kind}><div className="section-heading"><h2>本地{image ? '生图 · Qwen-Image-2.1' : '生视频 · MiniMax H3'}</h2><span className="eyebrow">{image ? 'IMAGE' : 'VIDEO'} WORKFLOW</span></div><p className="muted">导入 ComfyUI 导出的 API 格式工作流，并填写需要替换的节点。{image ? '可用文字及参考图生成角色、场景、道具和分镜。' : '使用分镜图片作为首帧，逐镜生成视频。'}</p>
      <div className="settings-workflow-head"><h3>工作流 JSON</h3><label className="btn small">导入文件<input type="file" accept=".json,application/json" onChange={async e => { const file = e.target.files?.[0]; if (!file) return; if (file.size > 2_000_000) return setError('工作流 JSON 不得超过 2 MB。'); workflow(kind, 'workflowJson', await file.text()); setMessage(`已导入 ${file.name}，请检查节点映射并保存。`); setError(''); e.target.value = ''; }}/></label></div>
      <textarea className="settings-workflow" value={config.workflowJson} onChange={e => workflow(kind, 'workflowJson', e.target.value)} placeholder="粘贴或导入 ComfyUI API 格式工作流 JSON" spellCheck={false}/>
      {field(kind, '提示词', 'promptNodeId', 'promptInput')}{field(kind, image ? '参考图' : '首帧图片', 'referenceNodeId', 'referenceInput', image)}{!image && field(kind, '时长', 'durationNodeId', 'durationInput')}{field(kind, '随机种子', 'seedNodeId', 'seedInput', true)}
      {image && <>{field(kind, '宽度', 'widthNodeId', 'widthInput', true)}{field(kind, '高度', 'heightNodeId', 'heightInput', true)}{field(kind, '采样步数', 'stepsNodeId', 'stepsInput', true)}{field(kind, 'CFG', 'cfgNodeId', 'cfgInput', true)}</>}
      <button className="btn" disabled={!config.workflowJson || !!busy} onClick={() => action(`check-${kind}`, async () => { const result = await checkWorkflow(config.workflowJson, config.promptNodeId, config.promptInput); return `工作流格式有效，包含 ${result.nodeCount} 个节点；保存设置时会检查全部映射。`; })}>检查工作流</button>
      <h3 className="settings-subtitle">默认参数</h3><div className="settings-fields">{(image ? [['width', '宽度'], ['height', '高度'], ['steps', '采样步数'], ['cfg', 'CFG'], ['seed', '随机种子（-1 为随机）']] : [['duration', '时长（秒，1–15）'], ['seed', '随机种子（-1 为随机）']]).map(([key, label]) => <label key={key}>{label}<input type="number" value={Number(config[key as keyof typeof config])} onChange={e => workflow(kind, key, Number(e.target.value))}/></label>)}</div>
      <p className="hint settings-footnote">模型文件与 API 工作流需先在本机 ComfyUI 准备；网站不会自动下载模型。</p>
    </section>;
  };
  return <div className="settings-page"><div className="page-heading"><div><div className="eyebrow">LOCAL SETTINGS</div><h1>设置</h1><p>配置本机 Codex、Qwen-Image-2.1 生图与 MiniMax H3 生视频。</p></div><button className="btn primary" disabled={!!busy} onClick={() => action('save', async () => { setDraft(await saveSettings(draft)); return '设置已保存。新任务会使用更新后的参数。'; })}>保存设置</button></div>
    {error && <div className="codex-error">{error}</div>}{message && <div className="settings-success">{message}</div>}
    <section className="panel settings-panel"><div className="section-heading"><h2>Codex</h2><span className="eyebrow">本机 CLI</span></div><p className="muted">使用本机已登录的 Codex。模型和推理强度会应用到新建的创作任务及顾问对话。</p><div className="settings-fields"><label>模型<input list="codex-model-list" value={draft.codex.model} onChange={e => codex('model', e.target.value)}/><datalist id="codex-model-list"><option value="gpt-5.5"/><option value="gpt-6-sol"/><option value="gpt-6-luna"/></datalist></label><label>推理强度<select value={draft.codex.reasoningEffort} onChange={e => codex('reasoningEffort', e.target.value as Settings['codex']['reasoningEffort'])}><option value="low">低 · 更快</option><option value="medium">中</option><option value="high">高</option><option value="xhigh">极高</option></select></label><label>单阶段超时（分钟）<input type="number" min="1" max="180" value={draft.codex.timeoutMinutes} onChange={e => codex('timeoutMinutes', Number(e.target.value))}/></label></div><button className="btn" disabled={!!busy} onClick={() => action('codex', async () => { const result = await testCodex(draft.codex); return `Codex 模型 ${result.model} 可用 · ${result.reply}`; })}>测试 Codex 模型</button></section>
    <section className="panel settings-panel"><h2>本机 ComfyUI</h2><div className="settings-url-row"><label>服务地址<input value={draft.comfy.baseUrl} onChange={e => comfyUrl(e.target.value)} placeholder="http://127.0.0.1:8188"/></label><button className="btn" disabled={!!busy} onClick={() => action('connection', async () => { const result = await testComfy(draft.comfy.baseUrl); return `连接成功 · ComfyUI ${result.version || '版本未知'}`; })}>测试连接</button></div></section>
    {section('image')}{section('video')}
  </div>;
}
