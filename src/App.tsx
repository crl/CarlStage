import { useEffect, useMemo, useState } from 'react';
import { clone, makeDocs, makeProject, mockImage, sectionLabel, uid } from './model';
import type { Asset, AssetType, Character, DocKey, Project, Shot, Store } from './model';
import { listenForUpdates, loadStore, mergeStores, saveStore } from './db';
import { cancelJob, consult, continueJob, createJob, getHealth, getJob, removeProjectRuns } from './codex';
import type { Job } from './codex';
import SettingsPage from './SettingsPage';
import { decodeImportedText } from './textImport';

const EMPTY: Store = { projects: [], library: [] };
type Route = { page: 'dashboard' | 'library' | 'templates' | 'settings' | 'project'; id?: string; tab?: string };
const assetNames: Record<AssetType, string> = { character: '角色', scene: '场景', prop: '道具' };

function parseRoute(): Route {
  const parts = location.pathname.split('/').filter(Boolean);
  if (parts[0] === 'asset-library') return { page: 'library' };
  if (parts[0] === 'creative-templates') return { page: 'templates' };
  if (parts[0] === 'settings') return { page: 'settings' };
  if ((parts[0] === 'p' || parts[0] === 'c') && parts[1]) return { page: 'project', id: parts[1], tab: parts[2] || 'overview' };
  return { page: 'dashboard' };
}

function readFile(file: File): Promise<string> {
  return file.arrayBuffer().then(buffer => {
    const { text } = decodeImportedText(new Uint8Array(buffer), file.name);
    const content = file.name.toLowerCase().endsWith('.html') || file.name.toLowerCase().endsWith('.htm')
      ? new DOMParser().parseFromString(text, 'text/html').body.textContent || '' : text;
    if ((content.match(/\uFFFD/g) || []).length >= 3) throw new Error('原文中包含大量乱码字符，请选择未损坏的原始文件，或先另存为 UTF-8。');
    return content;
  });
}
function readImage(file: File): Promise<string> {
  return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(reader.error); reader.readAsDataURL(file); });
}
function fmt(date: number) { return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(date); }
function excerpt(text: string, count = 72) { return text.length > count ? text.slice(0, count) + '…' : text; }

export default function App() {
  const [state, setState] = useState<Store>(EMPTY);
  const [ready, setReady] = useState(false);
  const [route, setRoute] = useState<Route>(parseRoute);
  const [toast, setToast] = useState('');
  const [novelOpen, setNovelOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [mobileNav, setMobileNav] = useState(false);
  const [saveError, setSaveError] = useState('');

  useEffect(() => { loadStore().then(s => { setState(s); setReady(true); }).catch(() => { setReady(true); setSaveError('无法打开浏览器本地数据库，请检查隐私模式或存储权限。'); }); }, []);
  useEffect(() => { if (ready) saveStore(state).then(() => setSaveError('')).catch(() => setSaveError('保存失败：本地存储空间可能不足。')); }, [state, ready]);
  useEffect(() => listenForUpdates(() => { loadStore().then(remote => setState(current => {
    const merged = mergeStores(current, remote);
    return JSON.stringify(current) === JSON.stringify(merged) ? current : merged;
  })).catch(() => {}); }), []);
  useEffect(() => { const onPop = () => setRoute(parseRoute()); window.addEventListener('popstate', onPop); return () => window.removeEventListener('popstate', onPop); }, []);
  useEffect(() => { if (!toast) return; const timer = window.setTimeout(() => setToast(''), 3500); return () => clearTimeout(timer); }, [toast]);

  function go(path: string) { history.pushState({}, '', path); setRoute(parseRoute()); setMobileNav(false); window.scrollTo(0, 0); }
  function updateProject(id: string, change: (project: Project) => Project) {
    setState(s => ({ ...s, projects: s.projects.map(p => {
      if (p.id !== id) return p;
      const changed = change(clone(p));
      changed.updatedAt = Math.max(Date.now(), p.updatedAt + 1);
      return changed;
    }) }));
  }
  function create(input: Partial<Project> & Pick<Project, 'kind' | 'name' | 'prompt'>) {
    const project = makeProject(input);
    setState(s => ({ ...s, projects: [project, ...s.projects] }));
    setNovelOpen(false);
    go(`/p/${project.id}/${project.kind === 'novel' ? 'overview' : 'outline'}`);
    setToast('项目已创建 · 点击各页面的生成按钮调用 Codex');
  }
  function saveDoc<T extends DocKey>(project: Project, key: T, value: Project['docs'][T], label = '编辑内容') {
    updateProject(project.id, p => {
      p.changes.unshift({ id: uid(), at: Date.now(), section: key, label, before: clone(p.docs[key]), beforeArtifact: p.skillArtifacts?.[key] ? clone(p.skillArtifacts[key]) : undefined, beforeGeneratedSource: key === 'outline' ? p.generatedSource : undefined });
      (p.docs as unknown as Record<DocKey, Project['docs'][DocKey]>)[key] = value;
      p.updatedAt = Date.now();
      return p;
    });
    setToast('已保存，并记录在「变更」中');
  }
  function addToLibrary(asset: Asset, projectId: string) {
    const copy = { ...clone(asset), id: uid(), sourceProjectId: projectId };
    setState(s => ({ ...s, library: [copy, ...s.library] }));
    setToast('已加入全局资产库');
  }
  function importAsset(asset: Asset, projectId: string) {
    updateProject(projectId, p => { p.assets.push({ ...clone(asset), id: uid() }); p.updatedAt = Date.now(); return p; });
    setToast('已复制到项目资产库');
  }
  function deleteProject(id: string) {
    setState(s => ({ ...s, projects: s.projects.filter(p => p.id !== id), deletedProjectIds: [...new Set([...(s.deletedProjectIds || []), id])] }));
    void removeProjectRuns(id).catch(() => setToast('项目已从浏览器删除；本机生成目录未能清理，请检查 Codex 服务。'));
    setConfirmDelete(null); go('/dashboard'); setToast('项目已删除');
  }

  const project = route.page === 'project' ? state.projects.find(p => p.id === route.id) : undefined;
  if (!ready) return <div className="loading">Reelbench <span>正在打开本地工作台…</span></div>;
  return <>
    {saveError && <div className="save-error">{saveError}</div>}
    {route.page === 'dashboard' ? <Dashboard projects={state.projects} go={go} create={create} openNovel={() => setNovelOpen(true)} onDelete={setConfirmDelete}/> :
      <div className="app-shell">
        <Header go={go} project={project} page={route.page} onMenu={() => setMobileNav(v => !v)}/>
        {project && <ProjectNav project={project} tab={route.tab || 'overview'} go={go} mobileNav={mobileNav}/>}
        <main className="main-page">
          {route.page === 'library' && <GlobalLibrary state={state} importAsset={importAsset} go={go}/>}
          {route.page === 'templates' && <div className="empty-page"><div className="eyebrow">CREATIVE TEMPLATES</div><h1>创意模板</h1><p>模板内容正在整理，暂未开放。</p><button className="btn" onClick={() => go('/dashboard')}>返回工作台</button></div>}
          {route.page === 'settings' && <SettingsPage/>}
          {route.page === 'project' && (project ? <ProjectPage project={project} tab={route.tab || 'overview'} go={go} saveDoc={saveDoc} updateProject={updateProject} addToLibrary={addToLibrary} importAsset={importAsset} globalAssets={state.library} notify={setToast}/> : <div className="empty-page"><h1>找不到这个项目</h1><button className="btn" onClick={() => go('/dashboard')}>返回工作台</button></div>)}
        </main>
      </div>}
    {novelOpen && <NovelModal onClose={() => setNovelOpen(false)} onCreate={create}/>}
    {confirmDelete && <Modal title="删除项目" onClose={() => setConfirmDelete(null)}><p>确定删除「{state.projects.find(p => p.id === confirmDelete)?.name}」及其所有内容？此操作不可撤销。</p><div className="modal-actions"><button className="btn" onClick={() => setConfirmDelete(null)}>取消</button><button className="btn danger" onClick={() => deleteProject(confirmDelete)}>删除项目</button></div></Modal>}
    {toast && <div className="toast">{toast}</div>}
  </>;
}

function Header({ go, project, page, onMenu }: { go: (path: string) => void; project?: Project; page: Route['page']; onMenu: () => void }) {
  return <header className="topbar"><button className="mobile-menu" onClick={onMenu}>☰</button><button className="brand-mini" onClick={() => go('/dashboard')}>RB</button><button className="crumb" onClick={() => go('/dashboard')}>工作台</button><span className="crumb-sep">›</span><span className="crumb-current">{project?.name || (page === 'settings' ? '设置' : page === 'templates' ? '创意模板' : '资产库')}</span><div className="top-spacer"/><span className="demo-pill">本机 Codex 版</span><button className="settings-trigger" onClick={() => go('/settings')}>⚙ 设置</button></header>;
}

function Dashboard({ projects, go, create, openNovel, onDelete }: { projects: Project[]; go: (path: string) => void; create: (input: Partial<Project> & Pick<Project, 'kind' | 'name' | 'prompt'>) => void; openNovel: () => void; onDelete: (id: string) => void }) {
  const [prompt, setPrompt] = useState('');
  const [ratio, setRatio] = useState<'16:9' | '9:16'>('16:9');
  const [needCast, setNeedCast] = useState(true);
  const [needArt, setNeedArt] = useState(true);
  const [images, setImages] = useState<string[]>([]);
  const [imageError, setImageError] = useState('');
  async function addImages(files: FileList | null) {
    if (!files) return;
    try { const selected = Array.from(files); if (selected.some(f => !f.type.startsWith('image/') || f.size > 5 * 1024 * 1024)) throw new Error('请选择 5 MB 以内的图片'); const loaded = await Promise.all(selected.map(readImage)); setImages(v => [...v, ...loaded]); setImageError(''); } catch (e) { setImageError((e as Error).message); }
  }
  function submit() { if (!prompt.trim()) return; const name = prompt.trim().split(/[。！？\n]/)[0].slice(0, 28) || '未命名创意'; create({ kind: 'idea', name, prompt: prompt.trim(), ratio, needCast, needArt, referenceImages: images }); }
  return <div className="dashboard">
    <aside className="dash-sidebar"><div className="brand"><span className="logo">RB</span><div><strong>Reelbench</strong><small>AI 影视创作工作台</small></div></div>
      <nav className="dash-nav"><button className="active" onClick={() => go('/dashboard')}>⌂ <span>首页</span></button><button onClick={() => go('/asset-library')}>◇ <span>资产库</span></button><button onClick={() => go('/creative-templates')}>▦ <span>创意模板</span><em>待更新</em></button></nav>
      <div className="recent-title">最近项目</div><div className="recent-list">{projects.length ? projects.map(p => <div className="recent-item" key={p.id}><button className="recent-link" onClick={() => go(`/p/${p.id}/${p.kind === 'novel' ? 'overview' : 'outline'}`)}><span className="recent-icon">{p.kind === 'novel' ? '文' : '创'}</span><span className="recent-copy"><strong>{p.name}</strong><small>{p.kind === 'novel' ? p.genre || '小说项目' : `${p.docs.script.episodes.length} 条剧本`} · {new Date(p.updatedAt).toLocaleDateString('zh-CN')}</small></span></button><button className="recent-delete" title="删除项目" onClick={() => onDelete(p.id)}>×</button></div>) : <p className="sidebar-empty">还没有项目，从一个创意开始吧。</p>}</div>
      <button className="sidebar-create" onClick={openNovel}>＋ 小说项目</button>
    </aside>
    <main className="dash-main"><div className="dash-top"><span>✦ 独立创作，从灵感到分镜</span><div className="dash-top-actions"><span className="demo-pill">本机 Codex 版</span><button className="settings-trigger" onClick={() => go('/settings')}>⚙ 设置</button></div></div><div className="hero-wrap">
      <div className="hero-art"><div className="hero-frame frame-left"><span>SCENE 01</span></div><div className="hero-frame frame-center"><div className="reel-disc"/><span>YOUR STORY</span></div><div className="hero-frame frame-right"><span>TAKE 02</span></div></div>
      <div className="hero-eyebrow">✦ Reelbench · AI 影视创作工作台</div><h1>把脑海里的画面，<br/>交给 Reelbench 拍出来</h1><p className="hero-subtitle">输入一个镜头、一段故事或完整创意。我们会先确认创作方案，再按项目需要生成剧本、角色、美术和分镜。</p>
      <div className="composer"><textarea placeholder="输入你的镜头、画面或故事；也可以粘贴参考图开始创作" value={prompt} onChange={e => setPrompt(e.target.value)} onKeyDown={e => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') submit(); }}/><div className="composer-bottom"><label className="reference-button">＋ <span>参考内容<small>创建后进入项目资产库</small></span><input type="file" accept="image/*" multiple onChange={e => addImages(e.target.files)}/></label><span className="composer-note">创意项目<small>支持单条或多条</small></span><div className="segmented"><button className={ratio === '16:9' ? 'selected' : ''} onClick={() => setRatio('16:9')}>16:9</button><button className={ratio === '9:16' ? 'selected' : ''} onClick={() => setRatio('9:16')}>9:16</button></div><label className="check-pill"><input type="checkbox" checked={needCast} onChange={e => setNeedCast(e.target.checked)}/> 需要角色</label><label className="check-pill"><input type="checkbox" checked={needArt} onChange={e => setNeedArt(e.target.checked)}/> 需要美术</label><button className="send-button" disabled={!prompt.trim()} onClick={submit}>↑</button></div>{images.length > 0 && <div className="image-previews">{images.map((src, i) => <div key={i}><img src={src}/><button onClick={() => setImages(v => v.filter((_, j) => j !== i))}>×</button></div>)}</div>}{imageError && <p className="field-error">{imageError}</p>}</div>
      <p className="key-hint">⌘ / Ctrl + Enter 创建项目 · 内容生成由本机 Codex 提供，出图与出片为模拟</p>
      <div className="creation-choices"><button onClick={openNovel}><span className="choice-icon">文</span><span><strong>创建小说短剧</strong><small>上传小说，基于原文创建短剧项目</small></span><b>选择小说 →</b></button><button className="disabled-choice" disabled><span className="choice-icon">模</span><span><strong>选择创意模板 <i>待更新</i></strong><small>模板内容正在整理，暂未开放</small></span><b>敬请期待</b></button></div>
    </div></main>
  </div>;
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) { return <div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}><div className="modal" role="dialog" aria-modal="true" aria-label={title}><div className="modal-head"><div><span className="eyebrow">NEW PROJECT · SKILL INITIALIZATION</span><h2>{title}</h2></div><button className="icon-button" onClick={onClose}>×</button></div>{children}</div></div>; }

function NovelModal({ onClose, onCreate }: { onClose: () => void; onCreate: (input: Partial<Project> & Pick<Project, 'kind' | 'name' | 'prompt'>) => void }) {
  const [file, setFile] = useState<File | null>(null); const [name, setName] = useState(''); const [genre, setGenre] = useState(''); const [count, setCount] = useState(6); const [min, setMin] = useState(2); const [max, setMax] = useState(5); const [adaptation, setAdaptation] = useState('抽核'); const [ratio, setRatio] = useState<'16:9' | '9:16'>('16:9'); const [style, setStyle] = useState('半写实'); const [keep, setKeep] = useState(''); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  async function submit() {
    if (!file) return setError('请先选择小说文件。');
    if (!/\.(txt|md|markdown|html?)$/i.test(file.name)) return setError('仅支持 TXT、Markdown、HTML 文件。');
    if (file.size > 20 * 1024 * 1024) return setError('文件不得超过 20 MB。');
    if (!name.trim()) return setError('请填写项目名。');
    if (count < 1 || count > 100 || min < 1 || max < min) return setError('请检查集数和时长范围。');
    setBusy(true);
    try { const sourceText = (await readFile(file)).trim(); if (!sourceText) throw new Error('小说文件为空。'); onCreate({ kind: 'novel', name: name.trim(), prompt: sourceText.slice(0, 300), sourceName: file.name, sourceText, genre: genre.trim(), episodeCount: count, minDuration: min, maxDuration: max, adaptation, ratio, style, keep }); } catch (e) { setError((e as Error).message); setBusy(false); }
  }
  function chooseFile(f: File | null) { setFile(f); if (f) setName(v => v || f.name.replace(/\.[^.]+$/, '')); setError(''); }
  return <Modal title="新建小说项目" onClose={onClose}><p className="modal-intro">上传原文并确定改编参数。创建后前往大纲页面启动 Codex，先审阅改编骨架，再生成完整大纲。</p><label className="upload-zone" onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); chooseFile(e.dataTransfer.files[0] || null); }}><input type="file" accept=".txt,.md,.markdown,.html,.htm,text/plain,text/markdown,text/html" onChange={e => chooseFile(e.target.files?.[0] || null)}/><span>＋</span><strong>{file ? file.name : '选择或拖入小说'}</strong><small>TXT · Markdown · HTML，最大 20 MB</small></label>
    <div className="form-grid"><label>项目名<input value={name} onChange={e => setName(e.target.value)} placeholder="给项目起个名字"/></label><label>题材 · 可选<input value={genre} onChange={e => setGenre(e.target.value)} placeholder="如：都市情感"/></label><label>总集数<input type="number" min="1" max="100" value={count} onChange={e => setCount(Number(e.target.value))}/></label><div className="duration-row"><label>最短 · 分钟<input type="number" min="1" value={min} onChange={e => setMin(Number(e.target.value))}/></label><label>最长 · 分钟<input type="number" min="1" value={max} onChange={e => setMax(Number(e.target.value))}/></label></div></div>
    <div className="form-section"><span>改编幅度</span><div className="segmented">{['忠实', '抽核', '借壳'].map(v => <button key={v} className={adaptation === v ? 'selected' : ''} onClick={() => setAdaptation(v)}>{v}</button>)}</div></div><div className="form-section"><span>画面比例</span><div className="segmented">{(['16:9', '9:16'] as const).map(v => <button key={v} className={ratio === v ? 'selected' : ''} onClick={() => setRatio(v)}>{v}</button>)}</div></div><div className="form-section"><span>角色 / 美术画风</span><div className="segmented">{['半写实', '手绘动画'].map(v => <button key={v} className={style === v ? 'selected' : ''} onClick={() => setStyle(v)}>{v}</button>)}</div></div><label className="full-label">必须保留的角色或场戏 · 可选<textarea value={keep} onChange={e => setKeep(e.target.value)} placeholder="逗号或换行分隔"/></label>{error && <p className="field-error">{error}</p>}<div className="modal-actions"><button className="btn" onClick={onClose}>取消</button><button className="btn primary" disabled={busy} onClick={submit}>{busy ? '读取文件中…' : '创建项目'}</button></div>
  </Modal>;
}

function ProjectNav({ project, tab, go, mobileNav }: { project: Project; tab: string; go: (path: string) => void; mobileNav: boolean }) {
  const main = project.kind === 'novel' ? [['overview', '概览'], ['outline', '大纲'], ['script', '剧本'], ['cast', '角色'], ['art', '美术'], ['storyboard', '分镜'], ['history', '变更'], ['library', '素材库']] : [['outline', '大纲'], ['script', '剧本'], ['cast', '角色'], ['art', '美术'], ['storyboard', '分镜'], ['history', '变更'], ['library', '资产库']];
  return <nav className={`project-nav ${mobileNav ? 'open' : ''}`}><div className="project-nav-title"><span className="project-mark">{project.kind === 'novel' ? '文' : '创'}</span><div><strong>{project.name}</strong><small>{project.kind === 'novel' ? '小说项目' : '创意项目'} · {project.ratio}</small></div></div>{main.map(([key, label]) => <button key={key} className={tab === key ? 'active' : ''} onClick={() => go(`/p/${project.id}/${key}`)}>{label}</button>)}<div className="nav-spacer"/><button onClick={() => go('/asset-library')}>◇ 全局资产库</button><button onClick={() => go('/dashboard')}>← 所有项目</button></nav>;
}

function ProjectPage({ project, tab, go, saveDoc, updateProject, addToLibrary, importAsset, globalAssets, notify }: { project: Project; tab: string; go: (path: string) => void; saveDoc: <T extends DocKey>(project: Project, key: T, value: Project['docs'][T], label?: string) => void; updateProject: (id: string, change: (project: Project) => Project) => void; addToLibrary: (asset: Asset, projectId: string) => void; importAsset: (asset: Asset, projectId: string) => void; globalAssets: Asset[]; notify: (message: string) => void }) {
  const storageKey = `reelbench-job-${project.id}`;
  const [job, setJob] = useState<Job | null>(null);
  const [connection, setConnection] = useState('正在连接本机 Codex…');
  const [jobError, setJobError] = useState('');
  useEffect(() => { getHealth().then(() => setConnection('Codex 已连接')).catch(e => setConnection((e as Error).message)); }, []);
  useEffect(() => {
    setJob(null); setJobError('');
    const id = sessionStorage.getItem(storageKey);
    if (id) getJob(id).then(setJob).catch(() => sessionStorage.removeItem(storageKey));
  }, [storageKey]);
  useEffect(() => {
    if (!job || !['queued', 'running'].includes(job.status)) return;
    const timer = window.setInterval(() => getJob(job.id).then(setJob).catch(e => setJob(current => current ? { ...current, status: 'failed', error: (e as Error).message } : null)), 1600);
    return () => clearInterval(timer);
  }, [job?.id, job?.status]);
  async function doRegenerate(key: DocKey) {
    setJobError('');
    try {
      const started = await createJob(project, key);
      setJob(started); sessionStorage.setItem(storageKey, started.id);
    } catch (e) { setJobError((e as Error).message); }
  }
  async function advance() { if (!job) return; try { setJob(await continueJob(job.id)); } catch (e) { setJobError((e as Error).message); } }
  async function cancel() { if (!job) return; try { setJob(await cancelJob(job.id)); } catch (e) { setJobError((e as Error).message); } }
  function accept() {
    if (!job?.result) return;
    const { section, result } = job;
    updateProject(project.id, p => {
      p.changes.unshift({ id: uid(), at: Date.now(), section, label: `Codex 生成${sectionLabel(section)}`, before: clone(p.docs[section]), beforeArtifact: p.skillArtifacts?.[section] ? clone(p.skillArtifacts[section]) : undefined, beforeGeneratedSource: section === 'outline' ? p.generatedSource : undefined });
      (p.docs as unknown as Record<DocKey, Project['docs'][DocKey]>)[section] = result.mapped;
      p.skillArtifacts = { ...p.skillArtifacts, [section]: { raw: result.raw, skillVersion: result.skillVersion, generatedAt: result.generatedAt } };
      if (section === 'outline' && result.sourceExpansion) p.generatedSource = result.sourceExpansion;
      return p;
    });
    sessionStorage.removeItem(storageKey); setJob(null); notify('已写入生成结果，旧版保存在「变更」中。');
  }
  const key = tab === 'characters' ? 'cast' : (tab as DocKey);
  return <>
    <div className="codex-status">{connection} · Skill 版本 ca1c30b</div>
    {['outline', 'script', 'cast', 'art', 'storyboard'].includes(key) && !project.skillArtifacts?.[key] && <div className="codex-draft-note">当前页面内容是创建项目时的占位草稿。点击“重新生成”调用对应 Codex skill。</div>}
    {jobError && <div className="codex-error">{jobError}</div>}
    {job && <section className="panel codex-job"><div className="section-heading"><h2>Codex · {sectionLabel(job.section)}</h2><span className="eyebrow">{job.status}</span></div><p>{job.message || job.error}</p>{job.error && <p className="field-error">{job.error}</p>}
      {job.status === 'awaiting_confirmation' && <><pre className="codex-preview">{job.skeleton}</pre><div className="inline-actions"><button className="btn" onClick={cancel}>取消任务</button><button className="btn primary" onClick={advance}>确认骨架，继续生成大纲</button></div></>}
      {job.status === 'completed' && job.result && <>{job.validationWarning && <p className="field-error">{job.validationWarning}</p>}{job.result.sourceExpansion && <details><summary>查看创意扩写素材</summary><pre className="codex-preview">{job.result.sourceExpansion}</pre></details>}<div className="codex-preview"><strong>生成预览</strong><pre>{JSON.stringify(job.result.mapped, null, 2)}</pre></div><details><summary>质量门结果与完整原生 JSON</summary><pre className="codex-preview">{job.validation}</pre><pre className="codex-preview">{JSON.stringify(job.result.raw, null, 2)}</pre></details><div className="inline-actions"><button className="btn" onClick={() => { sessionStorage.removeItem(storageKey); setJob(null); }}>放弃结果</button><button className="btn primary" onClick={accept}>确认写入{sectionLabel(job.section)}</button></div></>}
      {['queued', 'running'].includes(job.status) && <button className="btn" onClick={cancel}>取消任务</button>}
      {['failed', 'cancelled'].includes(job.status) && <button className="btn" onClick={() => { sessionStorage.removeItem(storageKey); setJob(null); }}>关闭</button>}
    </section>}
    {tab === 'overview' && <><Overview project={project} go={go}/>{project.kind === 'novel' && <ReimportNovel project={project} updateProject={updateProject} notify={notify}/>}</>}
    {key === 'outline' && <OutlinePage project={project} save={value => saveDoc(project, 'outline', value)} regenerate={() => doRegenerate('outline')}/>}
    {key === 'script' && <ScriptPage project={project} save={value => saveDoc(project, 'script', value)} regenerate={() => doRegenerate('script')} notify={notify}/>}
    {key === 'cast' && <CastPage project={project} save={value => saveDoc(project, 'cast', value)} regenerate={() => doRegenerate('cast')} addToLibrary={addToLibrary}/>}
    {key === 'art' && <ArtPage project={project} save={value => saveDoc(project, 'art', value)} regenerate={() => doRegenerate('art')} addToLibrary={addToLibrary}/>}
    {key === 'storyboard' && <StoryboardPage project={project} save={value => saveDoc(project, 'storyboard', value)} regenerate={() => doRegenerate('storyboard')} notify={notify}/>}
    {tab === 'history' && <HistoryPage project={project} updateProject={updateProject} notify={notify}/>}
    {tab === 'library' && <ProjectLibrary project={project} globalAssets={globalAssets} importAsset={importAsset} updateProject={updateProject}/>}
  </>;
}

function PageHeading({ stage, title, subtitle, actions }: { stage: string; title: string; subtitle?: string; actions?: React.ReactNode }) { return <div className="page-heading"><div><div className="eyebrow">{stage}</div><h1>{title}</h1>{subtitle && <p>{subtitle}</p>}</div><div className="heading-actions">{actions}</div></div>; }
function Field({ label, value, onChange, rows = 3 }: { label: string; value: string; onChange: (value: string) => void; rows?: number }) { return <label className="edit-field"><span>{label}</span><textarea rows={rows} value={value} onChange={e => onChange(e.target.value)}/></label>; }
function SimulationBadge() { return <span className="simulation-badge">出图 / 出片模拟</span>; }

function Overview({ project, go }: { project: Project; go: (path: string) => void }) { const metrics = [{ key: 'outline', number: '01', label: '大纲', summary: `${project.docs.outline.episodes.length} 集 · ${project.docs.outline.retain.length} 项保留` }, { key: 'cast', number: '02', label: '角色', summary: `${project.docs.cast.length} 个角色` }, { key: 'art', number: '03', label: '美术', summary: `${project.docs.art.scenes.length} 个场景 · ${project.docs.art.props.length} 个道具` }, { key: 'script', number: '04', label: '剧本', summary: `${project.docs.script.episodes.length} 集 · ${project.docs.script.episodes.reduce((n, e) => n + e.scenes.length, 0)} 场` }, { key: 'storyboard', number: '05', label: '分镜', summary: `${project.docs.storyboard.shots.length} 个镜头` }]; return <><PageHeading stage="工作台 · 项目总览" title={project.name} subtitle="从大纲到分镜，创作内容都可以编辑。每次保存都会留下版本，随时可以在变更里恢复。"/><div className="overview-meta"><span>小说原文：{project.sourceName || '未上传'}</span><span>题材：{project.genre || '未设置'}</span><span>改编幅度：{project.adaptation}</span><span>画面比例：{project.ratio}</span></div><div className="workflow"><div className="workflow-label">创作流程 · FIVE STAGES</div>{metrics.map(m => <button key={m.key} className="workflow-card" onClick={() => go(`/p/${project.id}/${m.key}`)}><b>{m.number}</b><span><strong>{m.label}</strong><small>{m.summary}</small></span><em>进入 →</em></button>)}</div></>; }

function ReimportNovel({ project, updateProject, notify }: { project: Project; updateProject: (id: string, change: (project: Project) => Project) => void; notify: (message: string) => void }) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function reimport(file: File | undefined) {
    if (!file) return;
    setError('');
    if (!/\.(txt|md|markdown|html|htm)$/i.test(file.name)) return setError('仅支持 TXT、Markdown 或 HTML 文件。');
    if (file.size > 20 * 1024 * 1024) return setError('文件不得超过 20 MB。');
    setBusy(true);
    try {
      const sourceText = (await readFile(file)).trim();
      if (!sourceText) throw new Error('小说文件为空。');
      if (!window.confirm('重新导入会根据原文重建大纲、剧本、角色、美术和分镜。当前版本会保存在「变更」中，确定继续吗？')) return;
      updateProject(project.id, p => {
        const nextDocs = makeDocs(sourceText, p.episodeCount, 'novel');
        const keys: DocKey[] = ['outline', 'script', 'cast', 'art', 'storyboard'];
        for (const section of keys) {
          p.changes.unshift({ id: uid(), at: Date.now(), section, label: '重新导入小说原文', before: clone(p.docs[section]), beforeArtifact: p.skillArtifacts?.[section] ? clone(p.skillArtifacts[section]) : undefined, beforeGeneratedSource: section === 'outline' ? p.generatedSource : undefined });
        }
        p.docs = nextDocs;
        p.sourceName = file.name;
        p.sourceText = sourceText;
        p.prompt = sourceText.slice(0, 300);
        p.generatedSource = undefined;
        p.skillArtifacts = {};
        return p;
      });
      notify('原文已重新导入；旧内容可在「变更」中恢复。');
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  return <section className="panel reimport-panel"><h2>重新导入小说原文</h2><p>如原文或占位草稿出现乱码，请选择原始文件重新导入。支持 UTF-8、GB18030 和带编码标记的 UTF-16；当前创作内容会保留在「变更」中。</p><label className="btn small">{busy ? '正在读取…' : '选择原始文件'}<input type="file" disabled={busy} accept=".txt,.md,.markdown,.html,.htm" onChange={e => { void reimport(e.target.files?.[0]); e.target.value = ''; }}/></label>{error && <p className="field-error">{error}</p>}</section>;
}

function OutlinePage({ project, save, regenerate }: { project: Project; save: (value: Project['docs']['outline']) => void; regenerate: () => void }) {
  const [draft, setDraft] = useState(() => clone(project.docs.outline));
  useEffect(() => setDraft(clone(project.docs.outline)), [project.docs.outline]);
  function updateList(key: 'retain' | 'cut' | 'merge' | 'risks', index: number, value: string) { setDraft(d => ({ ...d, [key]: d[key].map((x, i) => i === index ? value : x) })); }
  return <><PageHeading stage="STAGE 01 · 什么 · OUTLINE" title="改编大纲" subtitle="确定故事内核、取舍和分集节奏。" actions={<><SimulationBadge/><button className="btn" onClick={regenerate}>重新生成</button><button className="btn primary" onClick={() => save(draft)}>保存大纲</button></>}/>{project.generatedSource && <details className="panel"><summary>查看创意扩写素材</summary><pre className="codex-preview">{project.generatedSource}</pre></details>}<div className="stat-row"><span>体裁 <b>{project.genre || '未指定'}</b></span><span>规模 <b>{project.episodeCount} 集</b></span><span>改编模式 <b>{project.adaptation}</b></span></div><div className="content-grid"><section className="panel"><h2>故事内核</h2><Field label="一句话概括" value={draft.core} onChange={v => setDraft(d => ({ ...d, core: v }))} rows={4}/></section><section className="panel"><h2>改编取舍</h2>{([['retain', '保留'], ['cut', '砍掉'], ['merge', '合并'], ['risks', '风险']] as const).map(([key, label]) => <div className="list-editor" key={key}><div className="list-editor-head"><h3>{label}</h3><button onClick={() => setDraft(d => ({ ...d, [key]: [...d[key], ''] }))}>＋ 新增</button></div>{draft[key].map((item, i) => <div className="list-row" key={i}><span>{i + 1}</span><input value={item} onChange={e => updateList(key, i, e.target.value)}/><button onClick={() => setDraft(d => ({ ...d, [key]: d[key].filter((_, j) => j !== i) }))}>×</button></div>)}</div>)}</section></div><section className="panel"><div className="section-heading"><h2>分集大纲</h2><button className="btn small" onClick={() => setDraft(d => ({ ...d, episodes: [...d.episodes, { title: `第 ${d.episodes.length + 1} 集`, summary: '', hook: '' }] }))}>＋ 增加一集</button></div><div className="episode-grid">{draft.episodes.map((e, i) => <div className="episode-card" key={i}><div className="episode-number">E{String(i + 1).padStart(2, '0')} <button onClick={() => setDraft(d => ({ ...d, episodes: d.episodes.filter((_, j) => j !== i) }))}>删除</button></div><input className="title-input" value={e.title} onChange={event => setDraft(d => ({ ...d, episodes: d.episodes.map((item, j) => j === i ? { ...item, title: event.target.value } : item) }))}/><Field label="梗概" value={e.summary} onChange={value => setDraft(d => ({ ...d, episodes: d.episodes.map((item, j) => j === i ? { ...item, summary: value } : item) }))}/><Field label="结尾钩子" value={e.hook} onChange={value => setDraft(d => ({ ...d, episodes: d.episodes.map((item, j) => j === i ? { ...item, hook: value } : item) }))} rows={2}/></div>)}</div></section></>;
}

function ScriptPage({ project, save, regenerate, notify }: { project: Project; save: (value: Project['docs']['script']) => void; regenerate: () => void; notify: (message: string) => void }) {
  const [draft, setDraft] = useState(() => clone(project.docs.script)); const [episode, setEpisode] = useState(0);
  useEffect(() => { setDraft(clone(project.docs.script)); setEpisode(0); }, [project.docs.script]);
  const current = draft.episodes[episode];
  function editEpisode(change: (value: typeof current) => typeof current) { setDraft(d => ({ ...d, episodes: d.episodes.map((e, i) => i === episode ? change(e) : e) })); }
  return <><PageHeading stage="STAGE 02 · 剧本 · SCRIPT" title={project.name} subtitle={excerpt(project.prompt, 160)} actions={<><SimulationBadge/><button className="btn" onClick={regenerate}>重新生成剧本</button><button className="btn primary" onClick={() => save(draft)}>保存剧本</button></>}/><div className="editor-layout"><div className="editor-main"><div className="episode-tabs">{draft.episodes.map((_, i) => <button className={episode === i ? 'active' : ''} key={i} onClick={() => setEpisode(i)}>第 {i + 1} 集</button>)}<button onClick={() => { setDraft(d => ({ ...d, episodes: [...d.episodes, { title: `第 ${d.episodes.length + 1} 集`, duration: 60, hook: '', ending: '', scenes: [] }] })); setEpisode(draft.episodes.length); }}>＋</button></div>{current && <><section className="panel"><div className="episode-number">E{String(episode + 1).padStart(2, '0')} · {current.duration}s <button onClick={() => { setDraft(d => ({ ...d, episodes: d.episodes.filter((_, i) => i !== episode) })); setEpisode(Math.max(0, episode - 1)); }}>删除本集</button></div><input className="title-input" value={current.title} onChange={e => editEpisode(v => ({ ...v, title: e.target.value }))}/><div className="two-fields"><Field label="开场钩子" value={current.hook} onChange={v => editEpisode(e => ({ ...e, hook: v }))}/><Field label="结尾断点" value={current.ending} onChange={v => editEpisode(e => ({ ...e, ending: v }))}/></div><label className="compact-field">时长（秒）<input type="number" min="1" value={current.duration} onChange={e => editEpisode(v => ({ ...v, duration: Number(e.target.value) }))}/></label></section>{current.scenes.map((scene, i) => <section className="panel scene-panel" key={i}><div className="section-heading"><span className="eyebrow">S{i + 1} · SCENE</span><button className="text-button" onClick={() => editEpisode(e => ({ ...e, scenes: e.scenes.filter((_, j) => j !== i) }))}>删除场景</button></div><input className="title-input" value={scene.title} onChange={e => editEpisode(v => ({ ...v, scenes: v.scenes.map((s, j) => j === i ? { ...s, title: e.target.value } : s) }))}/><Field label="地点 / 时间" value={scene.location} onChange={v => editEpisode(e => ({ ...e, scenes: e.scenes.map((s, j) => j === i ? { ...s, location: v } : s) }))} rows={1}/><Field label="场景说明" value={scene.description} onChange={v => editEpisode(e => ({ ...e, scenes: e.scenes.map((s, j) => j === i ? { ...s, description: v } : s) }))}/><Field label="动作 / 台词 · 每行一条" value={scene.beats.join('\n')} onChange={v => editEpisode(e => ({ ...e, scenes: e.scenes.map((s, j) => j === i ? { ...s, beats: v.split('\n') } : s) }))} rows={5}/></section>)}<button className="add-block" onClick={() => editEpisode(e => ({ ...e, scenes: [...e.scenes, { title: '新场景', location: '', description: '', beats: [] }] }))}>＋ 新增场景</button></>}</div><Consultant project={project} onApply={scene => { const next = clone(draft); if (!next.episodes[episode]) return; next.episodes[episode].scenes.push(scene); save(next); notify('修改建议已加入剧本，并记录版本'); }}/></div></>;
}

function Consultant({ project, onApply }: { project: Project; onApply: (scene: Project['docs']['script']['episodes'][number]['scenes'][number]) => void }) { const [mode, setMode] = useState<'talk' | 'edit'>('talk'); const [message, setMessage] = useState(''); const [reply, setReply] = useState(''); const [preview, setPreview] = useState<Project['docs']['script']['episodes'][number]['scenes'][number] | null>(null); const [busy, setBusy] = useState(false); const [error, setError] = useState(''); async function send() { if (!message.trim() || busy) return; setBusy(true); setError(''); try { const result = await consult(project, mode, message.trim()); setReply(result.reply); setPreview(mode === 'edit' ? result.scene || null : null); setMessage(''); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } } return <aside className="consultant panel"><div className="eyebrow">CREATIVE CONSULTANT</div><h2>创作顾问</h2><p>可讨论 · 可修改</p><div className="segmented"><button className={mode === 'talk' ? 'selected' : ''} onClick={() => setMode('talk')}>讨论</button><button className={mode === 'edit' ? 'selected' : ''} onClick={() => setMode('edit')}>修改剧本</button></div>{reply && <div className="consultant-reply">{reply}</div>}{preview && <div className="consultant-reply"><strong>修改预览</strong><p>{preview.title} · {preview.location}</p><p>{preview.description}</p><pre>{preview.beats.join('\n')}</pre><div className="inline-actions"><button className="btn small" onClick={() => setPreview(null)}>取消</button><button className="btn primary small" onClick={() => { onApply(preview); setPreview(null); }}>确认写入</button></div></div>}{error && <p className="field-error">{error}</p>}<textarea placeholder="描述你想讨论或修改的内容" value={message} onChange={e => setMessage(e.target.value)} onKeyDown={e => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') send(); }}/><button className="btn primary" disabled={!message.trim() || busy} onClick={send}>{busy ? 'Codex 正在回复…' : mode === 'talk' ? '发送讨论' : '预览修改'}</button></aside>; }

function CastPage({ project, save, regenerate, addToLibrary }: { project: Project; save: (value: Character[]) => void; regenerate: () => void; addToLibrary: (asset: Asset, projectId: string) => void }) { const [draft, setDraft] = useState(() => clone(project.docs.cast)); useEffect(() => setDraft(clone(project.docs.cast)), [project.docs.cast]); function edit(i: number, key: keyof Character, value: string) { setDraft(d => d.map((c, j) => j === i ? { ...c, [key]: value } : c)); } return <><PageHeading stage="STAGE 03 · 谁 · CAST" title="角色" subtitle="定义人物定位、外形与弧光，让角色在镜头里保持一致。" actions={<><SimulationBadge/><button className="btn" onClick={regenerate}>重新生成</button><button className="btn primary" onClick={() => save(draft)}>保存角色</button></>}/><div className="asset-grid">{draft.map((c, i) => <section className="panel asset-edit-card" key={c.id}><div className="asset-placeholder"><span>人</span>{c.image && <img src={c.image}/>}</div><div className="section-heading"><span className="eyebrow">C{String(i + 1).padStart(2, '0')}</span><button className="text-button" onClick={() => setDraft(d => d.filter((_, j) => j !== i))}>删除</button></div><label className="compact-field">角色名<input value={c.name} onChange={e => edit(i, 'name', e.target.value)}/></label><label className="compact-field">定位<input value={c.role} onChange={e => edit(i, 'role', e.target.value)}/></label><Field label="人物设定" value={c.description} onChange={v => edit(i, 'description', v)}/><Field label="人物弧光" value={c.arc} onChange={v => edit(i, 'arc', v)}/><ImagePicker value={c.image} onChange={v => edit(i, 'image', v)}/><button className="btn small" onClick={() => addToLibrary({ id: c.id, type: 'character', name: c.name, description: `${c.role} · ${c.description}`, image: c.image }, project.id)}>加入资产库</button></section>)}<button className="add-card" onClick={() => setDraft(d => [...d, { id: uid(), name: '新角色', role: '', description: '', arc: '' }])}>＋<strong>新增角色</strong></button></div></>; }

function ImagePicker({ value, onChange }: { value?: string; onChange: (value: string) => void }) { const [error, setError] = useState(''); return <div className="image-picker"><label className="btn small">{value ? '更换参考图' : '上传参考图'}<input type="file" accept="image/*" onChange={async e => { const file = e.target.files?.[0]; if (!file) return; if (!file.type.startsWith('image/') || file.size > 5 * 1024 * 1024) return setError('请选择 5 MB 以内的图片'); onChange(await readImage(file)); setError(''); }}/></label><button className="btn small" onClick={() => onChange(mockImage('模拟画面'))}>模拟出图</button>{value && <button className="text-button" onClick={() => onChange('')}>移除图片</button>}{error && <small className="field-error">{error}</small>}</div>; }

function ArtPage({ project, save, regenerate, addToLibrary }: { project: Project; save: (value: Project['docs']['art']) => void; regenerate: () => void; addToLibrary: (asset: Asset, projectId: string) => void }) { const [draft, setDraft] = useState(() => clone(project.docs.art)); useEffect(() => setDraft(clone(project.docs.art)), [project.docs.art]); function edit(type: 'scenes' | 'props', i: number, key: keyof Asset, value: string) { setDraft(d => ({ ...d, [type]: d[type].map((a, j) => j === i ? { ...a, [key]: value } : a) })); } return <><PageHeading stage="STAGE 04 · 在哪 + 拿什么 · ART" title="美术" subtitle="管理项目画风、场景与道具。参考图可随项目保存。" actions={<><SimulationBadge/><button className="btn" onClick={regenerate}>重新生成</button><button className="btn primary" onClick={() => save(draft)}>保存美术</button></>}/><section className="panel"><h2>项目画风</h2><Field label="画风说明" value={draft.style} onChange={v => setDraft(d => ({ ...d, style: v }))}/></section>{([['scenes', '场景', 'scene'], ['props', '道具', 'prop']] as const).map(([key, label, type]) => <section key={key}><div className="section-heading section-title"><h2>{label}</h2><button className="btn small" onClick={() => setDraft(d => ({ ...d, [key]: [...d[key], { id: uid(), type, name: `新${label}`, description: '' }] }))}>＋ 新增{label}</button></div><div className="asset-grid">{draft[key].map((a, i) => <div className="panel asset-edit-card" key={a.id}><div className="asset-placeholder"><span>{type === 'scene' ? '景' : '物'}</span>{a.image && <img src={a.image}/>}</div><div className="section-heading"><span className="eyebrow">{type === 'scene' ? 'S' : 'P'}{String(i + 1).padStart(2, '0')}</span><button className="text-button" onClick={() => setDraft(d => ({ ...d, [key]: d[key].filter((_, j) => j !== i) }))}>删除</button></div><label className="compact-field">名称<input value={a.name} onChange={e => edit(key, i, 'name', e.target.value)}/></label><Field label="视觉描述" value={a.description} onChange={v => edit(key, i, 'description', v)}/><ImagePicker value={a.image} onChange={v => edit(key, i, 'image', v)}/><button className="btn small" onClick={() => addToLibrary(a, project.id)}>加入资产库</button></div>)}</div></section>)}</>; }

function StoryboardPage({ project, save, regenerate, notify }: { project: Project; save: (value: Project['docs']['storyboard']) => void; regenerate: () => void; notify: (message: string) => void }) { const [draft, setDraft] = useState(() => clone(project.docs.storyboard)); useEffect(() => setDraft(clone(project.docs.storyboard)), [project.docs.storyboard]); function edit(i: number, key: keyof Shot, value: string | number) { setDraft(d => ({ shots: d.shots.map((s, j) => j === i ? { ...s, [key]: value } : s) })); } return <><PageHeading stage="STAGE 05 · 怎么拍 · STORYBOARD" title="分镜" subtitle="逐镜调整构图、动作和时长，再预览本地模拟的出片顺序。" actions={<><SimulationBadge/><button className="btn" onClick={regenerate}>重新生成</button><button className="btn primary" onClick={() => save(draft)}>保存分镜</button></>}/><div className="storyboard-grid">{draft.shots.map((shot, i) => <section className="panel shot-card" key={shot.id}><div className="shot-frame"><span>SHOT {String(i + 1).padStart(2, '0')}</span>{shot.image ? <img src={shot.image}/> : <b>▣</b>}</div><div className="shot-info"><div className="section-heading"><span className="eyebrow">镜头 {i + 1}</span><button className="text-button" onClick={() => setDraft(d => ({ shots: d.shots.filter((_, j) => j !== i) }))}>删除</button></div><div className="two-fields"><label className="compact-field">场景<input value={shot.scene} onChange={e => edit(i, 'scene', e.target.value)}/></label><label className="compact-field">景别<input value={shot.framing} onChange={e => edit(i, 'framing', e.target.value)}/></label></div><Field label="画面与动作" value={shot.action} onChange={v => edit(i, 'action', v)}/><label className="compact-field">时长（秒）<input type="number" min="1" value={shot.duration} onChange={e => edit(i, 'duration', Number(e.target.value))}/></label><ImagePicker value={shot.image} onChange={v => edit(i, 'image', v)}/></div></section>)}</div><div className="inline-actions spaced"><button className="btn" onClick={() => setDraft(d => ({ shots: [...d.shots, { id: uid(), scene: '新场景', framing: '中景', action: '', duration: 4 }] }))}>＋ 新增镜头</button><button className="btn" onClick={() => notify(`模拟出片预览：共 ${draft.shots.length} 个镜头，约 ${draft.shots.reduce((n, s) => n + s.duration, 0)} 秒。请保存分镜后继续编辑。`)}>▶ 模拟出片预览</button></div></>; }

function HistoryPage({ project, updateProject, notify }: { project: Project; updateProject: (id: string, change: (project: Project) => Project) => void; notify: (message: string) => void }) {
  const [selected, setSelected] = useState<string | null>(null);
  const change = project.changes.find(c => c.id === selected);
  function restore(id: string) {
    updateProject(project.id, p => {
      const old = p.changes.find(c => c.id === id);
      if (!old) return p;
      p.changes.unshift({ id: uid(), at: Date.now(), section: old.section, label: `恢复版本 · ${old.label}`, before: clone(p.docs[old.section]), beforeArtifact: p.skillArtifacts?.[old.section] ? clone(p.skillArtifacts[old.section]) : undefined, beforeGeneratedSource: old.section === 'outline' ? p.generatedSource : undefined });
      (p.docs as unknown as Record<DocKey, Project['docs'][DocKey]>)[old.section] = clone(old.before);
      p.skillArtifacts = { ...p.skillArtifacts, [old.section]: old.beforeArtifact ? clone(old.beforeArtifact) : undefined };
      if (old.section === 'outline') p.generatedSource = old.beforeGeneratedSource;
      return p;
    });
    setSelected(null); notify('已恢复版本，可再次撤回');
  }
  return <><PageHeading stage="VERSION HISTORY" title="变更" subtitle="编辑、重新生成和恢复操作都会保留上一版本。"/><div className="history-list">{project.changes.length ? project.changes.map(c => <button className="history-item" key={c.id} onClick={() => setSelected(c.id)}><span className="history-dot"/><span><strong>{c.label}</strong><small>{sectionLabel(c.section)} · {fmt(c.at)}</small></span><em>查看旧版 →</em></button>) : <div className="empty-state">暂无变更记录。编辑并保存内容后，这里会显示旧版本。</div>}</div>{change && <Modal title="查看历史版本" onClose={() => setSelected(null)}><div className="eyebrow">{sectionLabel(change.section)} · {fmt(change.at)}</div><p>此版本是“{change.label}”之前保存的内容。</p><pre className="version-preview">{JSON.stringify(change.before, null, 2)}</pre><div className="modal-actions"><button className="btn" onClick={() => setSelected(null)}>关闭</button><button className="btn primary" onClick={() => restore(change.id)}>恢复此版本</button></div></Modal>}</>;
}

function AssetFilter({ value, onChange, counts }: { value: AssetType | 'all'; onChange: (value: AssetType | 'all') => void; counts: Record<AssetType | 'all', number> }) { return <div className="filter-tabs">{([['all', '全部'], ['character', '角色'], ['scene', '场景'], ['prop', '道具']] as const).map(([key, label]) => <button key={key} className={value === key ? 'active' : ''} onClick={() => onChange(key)}>{label} <small>{counts[key]}</small></button>)}</div>; }
function AssetCards({ assets, action, actionLabel }: { assets: Asset[]; action?: (asset: Asset) => void; actionLabel?: string }) { return <div className="asset-grid">{assets.map(a => <article className="panel asset-card" key={a.id}><div className="asset-placeholder"><span>{a.type === 'character' ? '人' : a.type === 'scene' ? '景' : '物'}</span>{a.image && <img src={a.image}/>}</div><div className="asset-card-body"><span className="eyebrow">{assetNames[a.type]}</span><h3>{a.name}</h3><p>{a.description}</p>{action && <button className="btn small" onClick={() => action(a)}>{actionLabel}</button>}</div></article>)}</div>; }
function GlobalLibrary({ state, importAsset, go }: { state: Store; importAsset: (asset: Asset, projectId: string) => void; go: (path: string) => void }) { const [type, setType] = useState<AssetType | 'all'>('all'); const [query, setQuery] = useState(''); const [target, setTarget] = useState(''); const counts = useMemo(() => ({ all: state.library.length, character: state.library.filter(a => a.type === 'character').length, scene: state.library.filter(a => a.type === 'scene').length, prop: state.library.filter(a => a.type === 'prop').length }), [state.library]); const visible = state.library.filter(a => (type === 'all' || a.type === type) && `${a.name} ${a.description}`.toLowerCase().includes(query.toLowerCase())); return <><PageHeading stage="用户级 · 跨项目复用 · ASSET LIBRARY" title="资产库" subtitle="角色、场景和道具保存在项目之外。选择目标项目后，可复制到项目资产库。"/><div className="library-target panel"><div><strong>导入目标</strong><p>这里的选择只决定点击“导入”时复制到哪个项目。</p></div><select value={target} onChange={e => setTarget(e.target.value)}><option value="">暂不选择项目</option>{state.projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></div><div className="library-toolbar"><AssetFilter value={type} onChange={setType} counts={counts}/><input className="search-input" value={query} onChange={e => setQuery(e.target.value)} placeholder="搜索资产…"/></div>{visible.length ? <AssetCards assets={visible} action={target ? a => importAsset(a, target) : undefined} actionLabel="导入到项目"/> : <div className="empty-state"><div className="empty-icon">◇</div><h2>{state.library.length ? '没有找到匹配的资产' : '资产库还是空的'}</h2><p>在项目的角色或美术页面点击“加入资产库”，这里会保存一份全局副本。</p><button className="btn" onClick={() => go('/dashboard')}>返回工作台</button></div>}</>; }
function ProjectLibrary({ project, globalAssets, importAsset, updateProject }: { project: Project; globalAssets: Asset[]; importAsset: (asset: Asset, projectId: string) => void; updateProject: (id: string, change: (project: Project) => Project) => void }) { const [type, setType] = useState<AssetType | 'all'>('all'); const [query, setQuery] = useState(''); const [showGlobal, setShowGlobal] = useState(false); const counts = { all: project.assets.length, character: project.assets.filter(a => a.type === 'character').length, scene: project.assets.filter(a => a.type === 'scene').length, prop: project.assets.filter(a => a.type === 'prop').length }; const visible = project.assets.filter(a => (type === 'all' || a.type === type) && `${a.name} ${a.description}`.toLowerCase().includes(query.toLowerCase())); return <><PageHeading stage="PROJECT ASSETS" title={project.kind === 'novel' ? '素材库' : '项目资产库'} subtitle="集中管理这个项目使用的参考内容与导入资产。" actions={<button className="btn" onClick={() => setShowGlobal(v => !v)}>{showGlobal ? '收起全局资产库' : '从全局资产库导入'}</button>}/>{project.referenceImages.length > 0 && <section className="panel"><h2>创作参考图</h2><div className="reference-grid">{project.referenceImages.map((src, i) => <img key={i} src={src}/>)}</div></section>}{showGlobal && <section className="panel"><h2>全局资产库</h2>{globalAssets.length ? <AssetCards assets={globalAssets} action={a => importAsset(a, project.id)} actionLabel="导入这个项目"/> : <p className="muted">全局资产库暂无内容。</p>}</section>}<div className="library-toolbar"><AssetFilter value={type} onChange={setType} counts={counts}/><input className="search-input" value={query} onChange={e => setQuery(e.target.value)} placeholder="搜索项目资产…"/></div>{visible.length ? <AssetCards assets={visible} action={a => updateProject(project.id, p => { p.assets = p.assets.filter(x => x.id !== a.id); return p; })} actionLabel="从项目移除"/> : <div className="empty-state"><div className="empty-icon">◇</div><h2>暂无项目资产</h2><p>从全局资产库导入角色、场景或道具，或在项目编辑页上传参考图。</p></div>}</>; }
