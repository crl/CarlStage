import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { clone, makeDocs, makeProject, sectionLabel, uid } from './model';
import type { ArtAsset, Asset, AssetType, Character, Consultation, DocKey, Project, Shot, Store } from './model';
import { listenForUpdates, loadStore, mergeStores, saveStore } from './db';
import { cancelJob, consult, continueJob, createJob, createMediaJob, getMediaJob, cancelMediaJob, discardMediaJob, copyMediaToLibrary, uploadLibraryMedia, deleteMedia, getHealth, getJob, getSettings, removeProjectRuns } from './codex';
import type { Job, MediaJob } from './codex';
import SettingsPage from './SettingsPage';
import { decodeImportedText } from './textImport';
import { imageKey, ownedMediaUrl } from './mediaRefs';
import { ProjectDetail, ProjectMaterialTabs, ProjectOutlineSummary, ProjectStoryboardSummary, ProjectSubnav } from './ProjectDetails';

const EMPTY: Store = { projects: [], library: [] };
type Route = { page: 'dashboard' | 'library' | 'templates' | 'settings' | 'project'; id?: string; tab?: string; detail?: string[] };
const assetNames: Record<AssetType, string> = { character: '角色', scene: '场景', prop: '道具', other: '其它' };
const DeletedImages = createContext<string[]>([]);
const LibraryContext = createContext<Asset[]>([]);
const RegisterMedia = createContext<(projectId: string, asset: Asset) => void>(() => {});
const CurrentProject = createContext<Project | undefined>(undefined);
const OpenImage = createContext<(src: string) => void>(() => {});
const OpenVideo = createContext<(src: string) => void>(() => {});
const DeleteChange = createContext<(projectId: string, changeId: string) => void>(() => {});
const SaveConsultation = createContext<(projectId: string, item: Consultation) => void>(() => {});
const DeleteConsultation = createContext<(projectId: string, itemId: string) => void>(() => {});

function parseRoute(): Route {
  const parts = location.pathname.split('/').filter(Boolean);
  if (parts[0] === 'asset-library') return { page: 'library' };
  if (parts[0] === 'creative-templates') return { page: 'templates' };
  if (parts[0] === 'settings') return { page: 'settings' };
  if ((parts[0] === 'p' || parts[0] === 'c') && parts[1]) return { page: 'project', id: parts[1], tab: parts[2] || 'overview', detail: parts.slice(3).map(decodeURIComponent) };
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
function fmt(date: number) { return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(date); }
function excerpt(text: string, count = 72) { return text.length > count ? text.slice(0, count) + '…' : text; }
function MediaDownload({ src, name, kind }: { src: string; name?: string; kind: 'image' | 'video' }) {
  const extension = src.match(/\.(png|jpe?g|webp|mp4|webm|mov)(?:\?|$)/i)?.[1] || (kind === 'video' ? 'mp4' : src.match(/^data:image\/(png|jpeg|webp)/)?.[1] || 'png');
  const filename = `${(name || (kind === 'video' ? '视频' : '图片')).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')}.${extension === 'jpeg' ? 'jpg' : extension}`;
  return <a className="btn small media-download" href={src} download={filename} onClick={e => e.stopPropagation()}>↓ 下载</a>;
}

export default function App() {
  const [state, setState] = useState<Store>(EMPTY);
  const [ready, setReady] = useState(false);
  const [route, setRoute] = useState<Route>(parseRoute);
  const [toast, setToast] = useState('');
  const [novelOpen, setNovelOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [confirmAsset, setConfirmAsset] = useState<{ asset: Asset; scope: 'global' | 'project'; projectId?: string } | null>(null);
  const [confirmReference, setConfirmReference] = useState<{ source: string; index: number; projectId: string } | null>(null);
  const [renameProject, setRenameProject] = useState<{ id: string; name: string } | null>(null);
  const [mobileNav, setMobileNav] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [zoomImage, setZoomImage] = useState<string | null>(null);
  const [zoomVideo, setZoomVideo] = useState<string | null>(null);
  useEffect(() => { if (!zoomImage && !zoomVideo) return; const close = (event: KeyboardEvent) => { if (event.key === 'Escape') { setZoomImage(null); setZoomVideo(null); } }; window.addEventListener('keydown', close); return () => window.removeEventListener('keydown', close); }, [zoomImage, zoomVideo]);

  useEffect(() => { loadStore().then(s => { setState(s); setReady(true); }).catch(() => { setReady(true); setSaveError('无法读取本机项目文件，请检查本机服务。'); }); }, []);
  useEffect(() => { if (ready) saveStore(state).then(() => setSaveError('')).catch(() => setSaveError('保存失败：无法写入本机项目文件。')); }, [state, ready]);
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
    go(`/p/${project.id}`);
    setToast('项目已创建 · 点击各页面的生成按钮调用 Codex');
  }
  function saveDoc<T extends DocKey>(project: Project, key: T, value: Project['docs'][T], label = '编辑内容', mediaAsset?: Asset) {
    updateProject(project.id, p => {
      p.changes.unshift({ id: uid(), at: Date.now(), section: key, label, before: clone(p.docs[key]), after: clone(value), beforeArtifact: p.skillArtifacts?.[key] ? clone(p.skillArtifacts[key]) : undefined, beforeGeneratedSource: key === 'outline' ? p.generatedSource : undefined });
      (p.docs as unknown as Record<DocKey, Project['docs'][DocKey]>)[key] = value;
      if (mediaAsset) p.assets.push(mediaAsset);
      p.updatedAt = Date.now();
      return p;
    });
    setToast('已保存，并记录在「变更」中');
  }
  async function addToLibrary(asset: Asset, projectId: string) {
    try {
      const image = asset.image?.startsWith('/api/media/') ? (await copyMediaToLibrary(asset.image)).url : asset.image;
      const copy = { ...clone(asset), image, mediaKind: image ? 'image' as const : asset.mediaKind, id: uid(), sourceProjectId: projectId };
      setState(s => ({ ...s, library: [copy, ...s.library] }));
      setToast('已加入全局资产库');
    } catch (e) { setToast(`加入资产库失败：${(e as Error).message}`); }
  }
  function importAsset(asset: Asset, projectId: string) {
    updateProject(projectId, p => { p.assets.push({ ...clone(asset), id: uid() }); p.updatedAt = Date.now(); return p; });
    setToast('已复制到项目资产库');
  }
  function registerMedia(projectId: string, asset: Asset) {
    updateProject(projectId, p => { p.assets.push(asset); return p; });
  }
  function deleteChange(projectId: string, changeId: string) {
    setState(s => ({ ...s, deletedChangeIds: [...new Set([...(s.deletedChangeIds || []), changeId])], projects: s.projects.map(p => p.id === projectId ? { ...p, changes: p.changes.filter(c => c.id !== changeId), updatedAt: Date.now() } : p) }));
    setToast('变更记录已删除');
  }
  function saveConsultation(projectId: string, item: Consultation) {
    updateProject(projectId, project => { project.consultations = [item, ...(project.consultations || [])]; return project; });
  }
  function deleteConsultation(projectId: string, itemId: string) {
    setState(current => ({ ...current, deletedConsultationIds: [...new Set([...(current.deletedConsultationIds || []), itemId])], projects: current.projects.map(project => project.id === projectId ? { ...project, consultations: (project.consultations || []).filter(item => item.id !== itemId), updatedAt: Date.now() } : project) }));
    setToast('顾问记录已删除');
  }
  function deleteProject(id: string) {
    setState(s => ({ ...s, projects: s.projects.filter(p => p.id !== id), deletedProjectIds: [...new Set([...(s.deletedProjectIds || []), id])] }));
    void removeProjectRuns(id).catch(() => setToast('项目已从浏览器删除；本机生成目录未能清理，请检查 Codex 服务。'));
    setConfirmDelete(null); go('/dashboard'); setToast('项目已删除');
  }
  async function deleteAsset() {
    if (!confirmAsset) return;
    const { asset, scope, projectId } = confirmAsset;
    const owner = scope === 'global' ? 'library' : projectId || '';
    const media = asset.image || asset.video;
    const deleteImage = !!media && (media.startsWith('data:image/') || ownedMediaUrl(media, owner));
    try {
      if (deleteImage && media!.startsWith('/api/media/')) await deleteMedia(media!);
      setState(s => ({ ...s,
        deletedAssetIds: [...new Set([...(s.deletedAssetIds || []), asset.id, ...(media && scope === 'project' ? [`legacy-${projectId}-${imageKey(media).replace(/:/g, '-')}`] : [])])],
        deletedImages: deleteImage ? [...new Set([...(s.deletedImages || []), imageKey(media!)])] : s.deletedImages,
        library: scope === 'global' ? s.library.filter(a => a.id !== asset.id) : s.library,
        projects: scope === 'project' ? s.projects.map(p => p.id === projectId ? { ...p, assets: p.assets.filter(a => a.id !== asset.id), updatedAt: Date.now() } : p) : s.projects
      }));
      setConfirmAsset(null); setToast('资产已删除');
    } catch (e) { setToast(`删除失败：${(e as Error).message}`); }
  }
  async function deleteReference() {
    if (!confirmReference) return;
    const { source, index, projectId } = confirmReference;
    try {
      const owned = ownedMediaUrl(source, projectId);
      if (owned) await deleteMedia(source);
      setState(s => ({ ...s,
        deletedImages: owned ? [...new Set([...(s.deletedImages || []), imageKey(source)])] : s.deletedImages,
        deletedReferenceKeys: [...new Set([...(s.deletedReferenceKeys || []), `${projectId}:${imageKey(source)}`])],
        projects: s.projects.map(p => p.id === projectId ? { ...p, referenceImages: p.referenceImages.filter((_, i) => i !== index), updatedAt: Date.now() } : p)
      }));
      setConfirmReference(null); setToast('参考图已删除');
    } catch (e) { setToast(`删除失败：${(e as Error).message}`); }
  }

  const project = route.page === 'project' ? state.projects.find(p => p.id === route.id) : undefined;
  if (!ready) return <div className="loading">CarlStage <span>正在打开本地工作台…</span></div>;
  return <DeletedImages.Provider value={state.deletedImages || []}><LibraryContext.Provider value={state.library}><RegisterMedia.Provider value={registerMedia}><CurrentProject.Provider value={project}><OpenImage.Provider value={setZoomImage}><OpenVideo.Provider value={setZoomVideo}><DeleteChange.Provider value={deleteChange}><SaveConsultation.Provider value={saveConsultation}><DeleteConsultation.Provider value={deleteConsultation}>
    {saveError && <div className="save-error">{saveError}</div>}
    {route.page === 'dashboard' ? <Dashboard projects={state.projects} go={go} create={create} openNovel={() => setNovelOpen(true)} onDelete={setConfirmDelete}/> :
      <div className={`app-shell ${project ? 'project-shell' : ''}`}>
        <Header go={go} project={project} page={route.page} onMenu={() => setMobileNav(v => !v)} rename={() => project && setRenameProject({ id: project.id, name: project.name })}/>
        {project && <ProjectNav project={project} tab={route.tab || 'overview'} go={go} mobileNav={mobileNav}/>}
        <main className={`main-page ${project ? 'project-main' : ''}`}>
          {route.page === 'library' && <GlobalLibrary state={state} importAsset={importAsset} deleteAsset={asset => setConfirmAsset({ asset, scope: 'global' })} addUpload={asset => setState(s => ({ ...s, library: [asset, ...s.library] }))} go={go}/>}
          {route.page === 'templates' && <div className="empty-page"><div className="eyebrow">CREATIVE TEMPLATES</div><h1>创意模板</h1><p>模板内容正在整理，暂未开放。</p><button className="btn" onClick={() => go('/dashboard')}>返回工作台</button></div>}
          {route.page === 'settings' && <SettingsPage/>}
          {route.page === 'project' && (project ? <ProjectPage project={project} tab={route.tab || 'overview'} detail={route.detail || []} go={go} saveDoc={saveDoc} updateProject={updateProject} addToLibrary={addToLibrary} importAsset={importAsset} deleteAsset={asset => setConfirmAsset({ asset, scope: 'project', projectId: project.id })} deleteReference={(source, index) => setConfirmReference({ source, index, projectId: project.id })} globalAssets={state.library} notify={setToast}/> : <div className="empty-page"><h1>找不到这个项目</h1><button className="btn" onClick={() => go('/dashboard')}>返回工作台</button></div>)}
        </main>
      </div>}
    {novelOpen && <NovelModal onClose={() => setNovelOpen(false)} onCreate={create}/>}
    {confirmDelete && <Modal title="删除项目" onClose={() => setConfirmDelete(null)}><p>确定删除「{state.projects.find(p => p.id === confirmDelete)?.name}」及其所有内容？此操作不可撤销。</p><div className="modal-actions"><button className="btn" onClick={() => setConfirmDelete(null)}>取消</button><button className="btn danger" onClick={() => deleteProject(confirmDelete)}>删除项目</button></div></Modal>}
    {confirmAsset && <Modal title="删除资产" onClose={() => setConfirmAsset(null)}><p>确定删除「{confirmAsset.asset.name}」？{confirmAsset.scope === 'global' ? '仍引用其图片或视频的位置会显示“已被删除”。' : '仅删除项目副本；若媒体属于本项目，引用它的位置将显示“已被删除”。'}</p><div className="modal-actions"><button className="btn" onClick={() => setConfirmAsset(null)}>取消</button><button className="btn danger" onClick={() => void deleteAsset()}>删除资产</button></div></Modal>}
    {confirmReference && <Modal title="删除创作参考图" onClose={() => setConfirmReference(null)}><p>确定从此项目移除这张创作参考图？全局资产库中的原件不会删除。</p><div className="modal-actions"><button className="btn" onClick={() => setConfirmReference(null)}>取消</button><button className="btn danger" onClick={() => void deleteReference()}>移除参考图</button></div></Modal>}
    {renameProject && <Modal title="修改项目名称" onClose={() => setRenameProject(null)}><label className="full-label">项目名称<input autoFocus maxLength={80} value={renameProject.name} onChange={e => setRenameProject(v => v ? { ...v, name: e.target.value } : v)} onKeyDown={e => { if (e.key === 'Enter' && renameProject.name.trim()) { updateProject(renameProject.id, p => { p.name = renameProject.name.trim(); return p; }); setRenameProject(null); setToast('项目名称已更新'); } }}/></label><div className="modal-actions"><button className="btn" onClick={() => setRenameProject(null)}>取消</button><button className="btn primary" disabled={!renameProject.name.trim()} onClick={() => { updateProject(renameProject.id, p => { p.name = renameProject.name.trim(); return p; }); setRenameProject(null); setToast('项目名称已更新'); }}>保存名称</button></div></Modal>}
    {toast && <div className="toast">{toast}</div>}
    {zoomImage && <div className="image-lightbox" role="dialog" aria-modal="true" aria-label="放大图片" onMouseDown={e => { if (e.target === e.currentTarget) setZoomImage(null); }}><button className="image-lightbox-close" onClick={() => setZoomImage(null)} aria-label="关闭放大图片">×</button><img src={zoomImage} alt="放大图片"/><MediaDownload src={zoomImage} kind="image"/></div>}
    {zoomVideo && <div className="image-lightbox video-lightbox" role="dialog" aria-modal="true" aria-label="播放视频" onMouseDown={e => { if (e.target === e.currentTarget) setZoomVideo(null); }}><button className="image-lightbox-close" onClick={() => setZoomVideo(null)} aria-label="关闭视频">×</button><video src={zoomVideo} controls autoPlay playsInline/><MediaDownload src={zoomVideo} kind="video"/></div>}
  </DeleteConsultation.Provider></SaveConsultation.Provider></DeleteChange.Provider></OpenVideo.Provider></OpenImage.Provider></CurrentProject.Provider></RegisterMedia.Provider></LibraryContext.Provider></DeletedImages.Provider>;
}

function Header({ go, project, page, onMenu, rename }: { go: (path: string) => void; project?: Project; page: Route['page']; onMenu: () => void; rename: () => void }) {
  return <header className="topbar"><button className="mobile-menu" onClick={onMenu}>☰</button><button className="brand-mini" onClick={() => go('/dashboard')}>{project ? 'RB' : 'CS'}</button><button className="crumb" onClick={() => go('/dashboard')}>工作台</button><span className="crumb-sep">›</span><span className="crumb-current" title={project?.name}>{project?.name || (page === 'settings' ? '设置' : page === 'templates' ? '创意模板' : '资产库')}</span>{project && <button className="rename-trigger" onClick={rename} title="修改项目名称" aria-label="修改项目名称">⌄</button>}<div className="top-spacer"/>{project && <button className="settings-trigger" onClick={() => go(`/p/${project.id}/library`)}>▧ 资产库</button>}<button className="settings-trigger" onClick={() => go('/settings')}>⚙ 设置</button></header>;
}

function Dashboard({ projects, go, create, openNovel, onDelete }: { projects: Project[]; go: (path: string) => void; create: (input: Partial<Project> & Pick<Project, 'kind' | 'name' | 'prompt'>) => void; openNovel: () => void; onDelete: (id: string) => void }) {
  const [prompt, setPrompt] = useState('');
  const [ratio, setRatio] = useState<'16:9' | '9:16'>('16:9');
  const [needCast, setNeedCast] = useState(true);
  const [needArt, setNeedArt] = useState(true);
  const [images, setImages] = useState<string[]>([]);
  const [chooseImage, setChooseImage] = useState(false);
  function submit() { if (!prompt.trim()) return; const name = prompt.trim().split(/[。！？\n]/)[0].slice(0, 28) || '未命名创意'; create({ kind: 'idea', name, prompt: prompt.trim(), ratio, needCast, needArt, referenceImages: images }); }
  return <div className="dashboard">
    <aside className="dash-sidebar"><div className="brand"><span className="logo">CS</span><div><strong>CarlStage</strong><small>AI 影视创作工作台</small></div></div>
      <nav className="dash-nav"><button className="active" onClick={() => go('/dashboard')}>⌂ <span>首页</span></button><button onClick={() => go('/asset-library')}>◇ <span>资产库</span></button><button onClick={() => go('/creative-templates')}>▦ <span>创意模板</span><em>待更新</em></button></nav>
      <div className="recent-title">最近项目</div><div className="recent-list">{projects.length ? projects.map(p => <div className="recent-item" key={p.id}><button className="recent-link" onClick={() => go(`/p/${p.id}`)}><span className="recent-icon">{p.kind === 'novel' ? '文' : '创'}</span><span className="recent-copy"><strong>{p.name}</strong><small>{p.kind === 'novel' ? p.genre || '小说项目' : `${p.docs.script.episodes.length} 条剧本`} · {new Date(p.updatedAt).toLocaleDateString('zh-CN')}</small></span></button><button className="recent-delete" title="删除项目" onClick={() => onDelete(p.id)}>×</button></div>) : <p className="sidebar-empty">还没有项目，从一个创意开始吧。</p>}</div>
      <button className="sidebar-create" onClick={openNovel}>＋ 小说项目</button>
    </aside>
    <main className="dash-main"><div className="dash-top"><span>✦ 独立创作，从灵感到分镜</span><div className="dash-top-actions"><span className="demo-pill">本机 Codex 版</span><button className="settings-trigger" onClick={() => go('/settings')}>⚙ 设置</button></div></div><div className="hero-wrap">
      <div className="hero-art"><div className="hero-frame frame-left"><span>SCENE 01</span></div><div className="hero-frame frame-center"><div className="reel-disc"/><span>YOUR STORY</span></div><div className="hero-frame frame-right"><span>TAKE 02</span></div></div>
      <div className="hero-eyebrow">✦ CarlStage · AI 影视创作工作台</div><h1>把脑海里的画面，<br/>交给 CarlStage 拍出来</h1><p className="hero-subtitle">输入一个镜头、一段故事或完整创意。我们会先确认创作方案，再按项目需要生成剧本、角色、美术和分镜。</p>
      <div className="composer"><textarea placeholder="输入你的镜头、画面或故事；可从资产库选择参考图" value={prompt} onChange={e => setPrompt(e.target.value)} onKeyDown={e => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') submit(); }}/><div className="composer-bottom"><button className="reference-button" onClick={() => setChooseImage(true)}>＋ <span>参考内容<small>从全局资产库选择</small></span></button><span className="composer-note">创意项目<small>支持单条或多条</small></span><div className="segmented"><button className={ratio === '16:9' ? 'selected' : ''} onClick={() => setRatio('16:9')}>16:9</button><button className={ratio === '9:16' ? 'selected' : ''} onClick={() => setRatio('9:16')}>9:16</button></div><label className="check-pill"><input type="checkbox" checked={needCast} onChange={e => setNeedCast(e.target.checked)}/> 需要角色</label><label className="check-pill"><input type="checkbox" checked={needArt} onChange={e => setNeedArt(e.target.checked)}/> 需要美术</label><button className="send-button" disabled={!prompt.trim()} onClick={submit}>↑</button></div>{images.length > 0 && <div className="image-previews">{images.map((src, i) => <div key={i}><MediaPicture src={src}/><button onClick={() => setImages(v => v.filter((_, j) => j !== i))}>×</button></div>)}</div>}</div>
      {chooseImage && <ImageChooser onSelect={url => setImages(v => v.includes(url) ? v : [...v, url])} onClose={() => setChooseImage(false)}/>}
      <p className="key-hint">⌘ / Ctrl + Enter 创建项目 · 内容生成使用本机 Codex，出图与视频使用本机 ComfyUI</p>
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
  const main = [['script', '剧本', '▤'], ['cast', '角色', '♙'], ['art', '美术', '▧'], ['storyboard', '分镜', '▥'], ['overview', '概览', '▦'], ['outline', '大纲', '☷'], ['history', '变更', '◷'], ['library', '素材库', '▧']];
  return <nav className={`project-nav ${mobileNav ? 'open' : ''}`} aria-label="项目导航">{main.map(([key, label, icon], i) => <button key={key} className={`${tab === key ? 'active' : ''} ${i === 4 || i === 7 ? 'nav-group-start' : ''}`} onClick={() => go(`/p/${project.id}${key === 'overview' ? '' : `/${key}`}`)} title={label}><span aria-hidden="true">{icon}</span><small>{label}</small></button>)}</nav>;
}

function ProjectPage({ project, tab, detail, go, saveDoc, updateProject, addToLibrary, importAsset, deleteAsset, deleteReference, globalAssets, notify }: { project: Project; tab: string; detail: string[]; go: (path: string) => void; saveDoc: <T extends DocKey>(project: Project, key: T, value: Project['docs'][T], label?: string) => void; updateProject: (id: string, change: (project: Project) => Project) => void; addToLibrary: (asset: Asset, projectId: string) => void; importAsset: (asset: Asset, projectId: string) => void; deleteAsset: (asset: Asset) => void; deleteReference: (source: string, index: number) => void; globalAssets: Asset[]; notify: (message: string) => void }) {
  const openImage = useContext(OpenImage);
  const openVideo = useContext(OpenVideo);
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
      p.changes.unshift({ id: uid(), at: Date.now(), section, label: `Codex 生成${sectionLabel(section)}`, before: clone(p.docs[section]), after: clone(result.mapped), beforeArtifact: p.skillArtifacts?.[section] ? clone(p.skillArtifacts[section]) : undefined, beforeGeneratedSource: section === 'outline' ? p.generatedSource : undefined });
      (p.docs as unknown as Record<DocKey, Project['docs'][DocKey]>)[section] = result.mapped;
      p.skillArtifacts = { ...p.skillArtifacts, [section]: { raw: result.raw, skillVersion: result.skillVersion, generatedAt: result.generatedAt } };
      if (section === 'outline' && result.sourceExpansion) p.generatedSource = result.sourceExpansion;
      return p;
    });
    sessionStorage.removeItem(storageKey); setJob(null); notify('已写入生成结果，旧版保存在「变更」中。');
  }
  const key = tab === 'characters' ? 'cast' : (tab as DocKey);
  const pageDetail = tab === 'script' && !detail.length ? ['1'] : detail;
  const hasDetail = pageDetail.length > 0 && ['outline', 'script', 'cast', 'art', 'storyboard'].includes(tab);
  function renderDetailMedia(target: Character | Asset | Shot, kind: 'image' | 'video') {
    const prior = project.assets.filter(asset => asset.sourceItemId === target.id && (kind === 'image' ? !!asset.image : !!asset.video));
    const isShot = 'framing' in target;
    const prompt = isShot ? `${target.scene}，${target.framing}，${target.action}` : 'type' in target ? `${target.name}，${target.description}。画风：${project.style}` : target.imagePrompt || `${target.name}，${target.role}，${target.description}。画风：${project.style}`;
    const accept = (url: string) => {
      if (isShot) saveDoc(project, 'storyboard', { ...project.docs.storyboard, shots: project.docs.storyboard.shots.map(shot => shot.id === target.id ? { ...shot, [kind === 'image' ? 'image' : 'video']: url } : shot) }, `保存分镜${kind === 'image' ? '图' : '视频'}`);
      else if ('type' in target) saveDoc(project, 'art', { ...project.docs.art, scenes: project.docs.art.scenes.map(a => a.id === target.id ? { ...a, image: url } : a), props: project.docs.art.props.map(a => a.id === target.id ? { ...a, image: url } : a) }, '保存美术图');
      else saveDoc(project, 'cast', project.docs.cast.map(c => c.id === target.id ? { ...c, image: url } : c), '保存角色图');
    };
    return <div className="detail-media-tools"><MediaGenerator project={project} kind={kind} targetId={target.id} prompt={prompt} source={target.image} duration={isShot ? target.duration : undefined} onAccept={accept}/>{prior.length > 0 && <details><summary>{kind === 'image' ? '图片' : '视频'}历史记录 · {prior.length}</summary><div className="detail-media-history">{prior.map(asset => <button key={asset.id} onClick={() => (kind === 'image' ? openImage : openVideo)(kind === 'image' ? asset.image! : asset.video!)}>{asset.image ? <img src={asset.image} alt={asset.name}/> : <span>▶ {asset.name}</span>}</button>)}</div></details>}</div>;
  }
  return <div className={['outline', 'script', 'storyboard'].includes(tab) ? `project-content-with-subnav ${tab}-workspace` : ''}>
    <ProjectSubnav project={project} tab={tab} detail={pageDetail} go={go}/><div className="project-content">
    <div className="codex-status">{connection} · Skill 版本 ca1c30b</div>
    {['outline', 'script', 'cast', 'art', 'storyboard'].includes(key) && !project.skillArtifacts?.[key] && <div className="codex-draft-note">当前页面内容是创建项目时的占位草稿。点击“重新生成”调用对应 Codex skill。</div>}
    {jobError && <div className="codex-error">{jobError}</div>}
    {job && <section className="panel codex-job"><div className="section-heading"><h2>Codex · {sectionLabel(job.section)}</h2><span className="eyebrow">{job.status}</span></div><p>{job.message || job.error}</p>{job.error && <p className="field-error">{job.error}</p>}
      {job.status === 'awaiting_confirmation' && <><pre className="codex-preview">{job.skeleton}</pre><div className="inline-actions"><button className="btn" onClick={cancel}>取消任务</button><button className="btn primary" onClick={advance}>确认骨架，继续生成大纲</button></div></>}
      {job.status === 'completed' && job.result && <>{job.validationWarning && <p className="field-error">{job.validationWarning}</p>}{job.result.sourceExpansion && <details><summary>查看创意扩写素材</summary><pre className="codex-preview">{job.result.sourceExpansion}</pre></details>}<div className="codex-preview"><strong>生成预览</strong><pre>{JSON.stringify(job.result.mapped, null, 2)}</pre></div><details><summary>质量门结果与完整原生 JSON</summary><pre className="codex-preview">{job.validation}</pre><pre className="codex-preview">{JSON.stringify(job.result.raw, null, 2)}</pre></details><div className="inline-actions"><button className="btn" onClick={() => { sessionStorage.removeItem(storageKey); setJob(null); }}>放弃结果</button><button className="btn primary" onClick={accept}>确认写入{sectionLabel(job.section)}</button></div></>}
      {['queued', 'running'].includes(job.status) && <button className="btn" onClick={cancel}>取消任务</button>}
      {['failed', 'cancelled'].includes(job.status) && <button className="btn" onClick={() => { sessionStorage.removeItem(storageKey); setJob(null); }}>关闭</button>}
    </section>}
    {hasDetail && tab === 'storyboard' && pageDetail[1] ? <SegmentProduction project={project} episode={Number(pageDetail[0])} segment={pageDetail[1]} save={(value, label) => saveDoc(project, 'storyboard', value, label)} openImage={openImage} media={renderDetailMedia}/> : hasDetail && <ProjectDetail project={project} tab={tab} detail={pageDetail} go={go} save={(section, value, label) => saveDoc(project, section, value, label)} openImage={openImage} media={renderDetailMedia}/>}
    {tab === 'overview' && <><Overview project={project} go={go}/>{project.kind === 'novel' && <ReimportNovel project={project} updateProject={updateProject} notify={notify}/>}</>}
    {!hasDetail && key === 'outline' && <><OutlinePage project={project} save={value => saveDoc(project, 'outline', value)} regenerate={() => doRegenerate('outline')}/><ProjectOutlineSummary project={project} go={go}/></>}
    {!hasDetail && key === 'script' && <ScriptPage project={project} save={value => saveDoc(project, 'script', value)} regenerate={() => doRegenerate('script')} notify={notify}/>}
    {!hasDetail && key === 'cast' && <CastGallery project={project} save={value => saveDoc(project, 'cast', value)} regenerate={() => doRegenerate('cast')} addToLibrary={addToLibrary} go={go}/>}
    {!hasDetail && key === 'art' && <ArtGallery project={project} save={value => saveDoc(project, 'art', value)} regenerate={() => doRegenerate('art')} addToLibrary={addToLibrary} go={go}/>}
    {!hasDetail && key === 'storyboard' && <><ProjectStoryboardSummary project={project} go={go}/><StoryboardPage project={project} save={value => saveDoc(project, 'storyboard', value)} regenerate={() => doRegenerate('storyboard')} notify={notify}/></>}
    {tab === 'history' && <HistoryPage project={project} updateProject={updateProject} notify={notify}/>}
    {tab === 'library' && <ProjectMaterialTabs project={project}><ProjectLibrary project={project} globalAssets={globalAssets} importAsset={importAsset} deleteAsset={deleteAsset} deleteReference={deleteReference}/></ProjectMaterialTabs>}
  </div></div>;
}

function PageHeading({ stage, title, subtitle, actions }: { stage: string; title: string; subtitle?: string; actions?: React.ReactNode }) { return <div className="page-heading"><div><div className="eyebrow">{stage}</div><h1>{title}</h1>{subtitle && <p>{subtitle}</p>}</div><div className="heading-actions">{actions}</div></div>; }
function Field({ label, value, onChange, rows = 3 }: { label: string; value: string; onChange: (value: string) => void; rows?: number }) { return <label className="edit-field"><span>{label}</span><textarea rows={rows} value={value} onChange={e => onChange(e.target.value)}/></label>; }

function Overview({ project, go }: { project: Project; go: (path: string) => void }) {
  const shots = project.docs.storyboard.shots;
  const segments = new Set(shots.map(s => s.segmentId).filter(Boolean));
  const metrics = [
    { key: 'outline', number: '01', label: '大纲', caption: '什么', summary: `${project.docs.outline.episodes.length} 集 · ${project.docs.outline.beats?.length || 0} 个爽点` },
    { key: 'cast', number: '02', label: '角色', caption: '谁', summary: `${project.docs.cast.length} 个角色` },
    { key: 'art', number: '03', label: '美术', caption: '在哪 + 拿什么', summary: `${project.docs.art.scenes.length} 个场景 · ${project.docs.art.props.length} 个道具` },
    { key: 'script', number: '04', label: '剧本', caption: '戏', summary: `${project.docs.script.episodes.reduce((n, e) => n + e.scenes.length, 0)} 场 · ${project.docs.script.episodes.reduce((n, e) => n + e.scenes.reduce((sum, s) => sum + s.beats.length, 0), 0)} 节拍` },
    { key: 'storyboard', number: '05', label: '分镜', caption: '怎么拍', summary: `${segments.size} 段 · ${shots.length} 个镜头` }
  ];
  const card = (m: typeof metrics[number]) => <button key={m.key} className="flow-stage" onClick={() => go(`/p/${project.id}/${m.key}`)}><span className="flow-stage-top"><small>{m.number}</small><strong>{m.label}</strong><em>{m.caption}</em></span><span className="flow-stage-summary">{m.summary}</span></button>;
  return <><PageHeading stage="工作台 · 项目总览" title={project.name} subtitle="从大纲到分镜，五个阶段的文案与素材都在这里改。每一次改动都记在变更里，随时可以撤回。"/><div className="flow-diagram"><div className="flow-source">{project.kind === 'novel' ? '小说原文' : '创意原文'}<small>{project.sourceName || '素材来源'}</small></div><span className="flow-arrow">→</span>{card(metrics[0])}<span className="flow-arrow">→</span><div className="flow-cluster"><div className="flow-cluster-head">收敛层 · 三者同步迭代，无先后</div>{metrics.slice(1, 4).map(card)}<div className="flow-cluster-foot">人工过一遍 · 不满意就微调，重新生成</div></div><span className="flow-arrow">→</span>{card(metrics[4])}<span className="flow-arrow">→</span><div className="flow-source">批量生成<small>按镜出片</small></div></div><div className="overview-meta"><span>题材：{project.genre || '未设置'}</span><span>改编幅度：{project.adaptation}</span><span>画面比例：{project.ratio}</span></div></>;
}

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
  return <><PageHeading stage="STAGE 01 · 什么 · OUTLINE" title="改编大纲" subtitle="确定故事内核、取舍和分集节奏。" actions={<><button className="btn" onClick={regenerate}>重新生成</button><button className="btn primary" onClick={() => save(draft)}>保存大纲</button></>}/>{project.generatedSource && <details className="panel"><summary>查看创意扩写素材</summary><pre className="codex-preview">{project.generatedSource}</pre></details>}<div className="stat-row"><span>体裁 <b>{project.genre || '未指定'}</b></span><span>规模 <b>{project.episodeCount} 集</b></span><span>改编模式 <b>{project.adaptation}</b></span></div><div className="content-grid"><section className="panel"><h2>故事内核</h2><Field label="一句话概括" value={draft.core} onChange={v => setDraft(d => ({ ...d, core: v }))} rows={4}/></section><section className="panel"><h2>改编取舍</h2>{([['retain', '保留'], ['cut', '砍掉'], ['merge', '合并'], ['risks', '风险']] as const).map(([key, label]) => <div className="list-editor" key={key}><div className="list-editor-head"><h3>{label}</h3><button onClick={() => setDraft(d => ({ ...d, [key]: [...d[key], ''] }))}>＋ 新增</button></div>{draft[key].map((item, i) => <div className="list-row" key={i}><span>{i + 1}</span><input value={item} onChange={e => updateList(key, i, e.target.value)}/><button onClick={() => setDraft(d => ({ ...d, [key]: d[key].filter((_, j) => j !== i) }))}>×</button></div>)}</div>)}</section></div><section className="panel"><div className="section-heading"><h2>分集大纲</h2><button className="btn small" onClick={() => setDraft(d => ({ ...d, episodes: [...d.episodes, { title: `第 ${d.episodes.length + 1} 集`, summary: '', hook: '' }] }))}>＋ 增加一集</button></div><div className="episode-grid">{draft.episodes.map((e, i) => <div className="episode-card" key={i}><div className="episode-number">E{String(i + 1).padStart(2, '0')} <button onClick={() => setDraft(d => ({ ...d, episodes: d.episodes.filter((_, j) => j !== i) }))}>删除</button></div><input className="title-input" value={e.title} onChange={event => setDraft(d => ({ ...d, episodes: d.episodes.map((item, j) => j === i ? { ...item, title: event.target.value } : item) }))}/><Field label="梗概" value={e.summary} onChange={value => setDraft(d => ({ ...d, episodes: d.episodes.map((item, j) => j === i ? { ...item, summary: value } : item) }))}/><Field label="结尾钩子" value={e.hook} onChange={value => setDraft(d => ({ ...d, episodes: d.episodes.map((item, j) => j === i ? { ...item, hook: value } : item) }))} rows={2}/></div>)}</div></section></>;
}

function ScriptPage({ project, save, regenerate, notify }: { project: Project; save: (value: Project['docs']['script']) => void; regenerate: () => void; notify: (message: string) => void }) {
  const [draft, setDraft] = useState(() => clone(project.docs.script)); const [episode, setEpisode] = useState(0);
  useEffect(() => { setDraft(clone(project.docs.script)); setEpisode(0); }, [project.docs.script]);
  const current = draft.episodes[episode];
  function editEpisode(change: (value: typeof current) => typeof current) { setDraft(d => ({ ...d, episodes: d.episodes.map((e, i) => i === episode ? change(e) : e) })); }
  return <><PageHeading stage="STAGE 02 · 剧本 · SCRIPT" title={project.name} subtitle={excerpt(project.prompt, 160)} actions={<><button className="btn" onClick={regenerate}>重新生成剧本</button><button className="btn primary" onClick={() => save(draft)}>保存剧本</button></>}/><div className="editor-layout"><div className="editor-main"><div className="episode-tabs">{draft.episodes.map((_, i) => <button className={episode === i ? 'active' : ''} key={i} onClick={() => setEpisode(i)}>第 {i + 1} 集</button>)}<button onClick={() => { setDraft(d => ({ ...d, episodes: [...d.episodes, { title: `第 ${d.episodes.length + 1} 集`, duration: 60, hook: '', ending: '', scenes: [] }] })); setEpisode(draft.episodes.length); }}>＋</button></div>{current && <><section className="panel"><div className="episode-number">E{String(episode + 1).padStart(2, '0')} · {current.duration}s <button onClick={() => { setDraft(d => ({ ...d, episodes: d.episodes.filter((_, i) => i !== episode) })); setEpisode(Math.max(0, episode - 1)); }}>删除本集</button></div><input className="title-input" value={current.title} onChange={e => editEpisode(v => ({ ...v, title: e.target.value }))}/><div className="two-fields"><Field label="开场钩子" value={current.hook} onChange={v => editEpisode(e => ({ ...e, hook: v }))}/><Field label="结尾断点" value={current.ending} onChange={v => editEpisode(e => ({ ...e, ending: v }))}/></div><label className="compact-field">时长（秒）<input type="number" min="1" value={current.duration} onChange={e => editEpisode(v => ({ ...v, duration: Number(e.target.value) }))}/></label></section>{current.scenes.map((scene, i) => <section className="panel scene-panel" key={i}><div className="section-heading"><span className="eyebrow">S{i + 1} · SCENE</span><button className="text-button" onClick={() => editEpisode(e => ({ ...e, scenes: e.scenes.filter((_, j) => j !== i) }))}>删除场景</button></div><input className="title-input" value={scene.title} onChange={e => editEpisode(v => ({ ...v, scenes: v.scenes.map((s, j) => j === i ? { ...s, title: e.target.value } : s) }))}/><Field label="地点 / 时间" value={scene.location} onChange={v => editEpisode(e => ({ ...e, scenes: e.scenes.map((s, j) => j === i ? { ...s, location: v } : s) }))} rows={1}/><Field label="场景说明" value={scene.description} onChange={v => editEpisode(e => ({ ...e, scenes: e.scenes.map((s, j) => j === i ? { ...s, description: v } : s) }))}/><Field label="动作 / 台词 · 每行一条" value={scene.beats.join('\n')} onChange={v => editEpisode(e => ({ ...e, scenes: e.scenes.map((s, j) => j === i ? { ...s, beats: v.split('\n') } : s) }))} rows={5}/></section>)}<button className="add-block" onClick={() => editEpisode(e => ({ ...e, scenes: [...e.scenes, { title: '新场景', location: '', description: '', beats: [] }] }))}>＋ 新增场景</button></>}</div><Consultant project={project} onApply={scene => { const next = clone(draft); if (!next.episodes[episode]) return; next.episodes[episode].scenes.push(scene); save(next); notify('修改建议已加入剧本，并记录版本'); }}/></div></>;
}

function Consultant({ project, onApply }: { project: Project; onApply: (scene: Project['docs']['script']['episodes'][number]['scenes'][number]) => void }) {
  const saveConsultation = useContext(SaveConsultation);
  const deleteConsultation = useContext(DeleteConsultation);
  const [mode, setMode] = useState<'talk' | 'edit'>('talk');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [activeProvider, setActiveProvider] = useState<'codex' | 'ollama' | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  async function send() {
    const question = message.trim();
    if (!question || busy) return;
    setBusy(true); setError(''); setActiveProvider(null);
    try {
      const settings = await getSettings();
      setActiveProvider(settings.codex.provider);
      const result = await consult(project, mode, question);
      saveConsultation(project.id, { id: uid(), at: Date.now(), mode, question, reply: result.reply, scene: mode === 'edit' ? result.scene : undefined });
      setMessage('');
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  const entries = (project.consultations || []).filter(item => item.mode === mode);
  const pending = (project.consultations || []).find(item => item.id === confirmId);
  return <aside className="consultant panel">
    <div className="eyebrow">CREATIVE CONSULTANT</div><h2>创作顾问</h2><p>可讨论 · 可修改</p>
    <div className="segmented"><button className={mode === 'talk' ? 'selected' : ''} onClick={() => setMode('talk')}>讨论</button><button className={mode === 'edit' ? 'selected' : ''} onClick={() => setMode('edit')}>修改剧本</button></div>
    {entries.length > 0 && <div className="consultant-history"><h3>{mode === 'talk' ? '讨论历史' : '修改历史'}</h3>{entries.map(item => <div className="consultant-reply consultant-entry" key={item.id}>
      <button className="consultant-entry-delete" type="button" title="删除记录" aria-label="删除这条顾问记录" onClick={() => setConfirmId(item.id)}>×</button>
      <small>{fmt(item.at)}</small><strong>{item.question}</strong><p>{item.reply}</p>
      {item.scene && <div className="consultant-scene"><strong>修改预览</strong><p>{item.scene.title} · {item.scene.location}</p><p>{item.scene.description}</p><pre>{item.scene.beats.join('\n')}</pre><div className="inline-actions"><button className="btn primary small" onClick={() => onApply(item.scene!)}>确认写入</button></div></div>}
    </div>)}</div>}
    {error && <p className="field-error">{error}</p>}
    <textarea placeholder="描述你想讨论或修改的内容" value={message} onChange={e => setMessage(e.target.value)} onKeyDown={e => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') void send(); }}/>
    <button className="btn primary" disabled={!message.trim() || busy} onClick={() => void send()}>{busy ? activeProvider ? (activeProvider === 'ollama' ? 'Ollama' : 'Codex') + ' 正在回复…' : '正在连接模型…' : mode === 'talk' ? '发送讨论' : '预览修改'}</button>
    {pending && <Modal title="删除顾问记录" onClose={() => setConfirmId(null)}><p>确定删除这条{pending.mode === 'talk' ? '讨论' : '修改'}记录？删除后无法恢复，已写入的剧本内容不会改变。</p><div className="modal-actions"><button className="btn" onClick={() => setConfirmId(null)}>取消</button><button className="btn danger" onClick={() => { deleteConsultation(project.id, pending.id); setConfirmId(null); }}>删除记录</button></div></Modal>}
  </aside>;
}

function SegmentPromptEditor({ value, label, save }: { value: string; label: string; save: (value: string) => void }) {
  const [draft, setDraft] = useState(value); useEffect(() => setDraft(value), [value]);
  return <textarea aria-label={label} value={draft} onChange={e => setDraft(e.target.value)} onBlur={() => { if (draft !== value) save(draft); }} onKeyDown={e => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') e.currentTarget.blur(); }}/>
}

function SegmentProduction({ project, episode, segment, save, openImage, media }: { project: Project; episode: number; segment: string; save: (value: Project['docs']['storyboard'], label?: string) => void; openImage: (url: string) => void; media: (target: Character | ArtAsset | Shot, kind: 'image' | 'video') => React.ReactNode }) {
  const [batch, setBatch] = useState(false);
  const [settings, setSettings] = useState<Awaited<ReturnType<typeof getSettings>> | null>(null);
  useEffect(() => { getSettings().then(setSettings).catch(() => setSettings(null)); }, []);
  const shots = project.docs.storyboard.shots.filter(shot => (shot.episode || 1) === episode && (shot.segmentId || '未分段') === segment);
  if (!shots.length) return <div className="empty-page">这一段暂无分镜</div>;
  const duration = Math.round(shots.reduce((sum, shot) => sum + shot.duration, 0) * 100) / 100;
  const starts = shots.map((_, index) => Math.round(shots.slice(0, index).reduce((sum, shot) => sum + shot.duration, 0) * 100) / 100);
  const timeline = shots.map((shot, index) => `[Shot ${index + 1}] At ${starts[index].toFixed(2)}s–${(starts[index] + shot.duration).toFixed(2)}s: ${shot.action}`).join('\n');
  const record = project.docs.storyboard.segments?.find(item => item.episode === episode && item.id === segment);
  const versions = record?.videos || [];
  const active = versions.find(version => version.id === record?.activeVideoId) || versions.at(-1);
  const missing = shots.filter(shot => !shot.image);
  const multi = !missing.length && shots.length > 1 && shots.length <= 8 && !!settings && (settings.comfy.video.referenceSlots?.length || 0) >= shots.length - 1;
  const prompt = multi ? `How the reference pictures align with the target video — ${shots.map((_, index) => `Picture ${index + 1} (from Shot ${index + 1}) aligns with the ${starts[index].toFixed(2)}-second mark`).join('; ')}.\n\nintegrated_multimodal_description:\n${timeline}` : `Use the first shot image as the only visual reference. Follow this segment timeline without assuming additional reference pictures.\n\nintegrated_multimodal_description:\n${timeline}`;
  const videoSources = multi ? shots.map(shot => shot.image!).filter(Boolean) : undefined;
  const segmentKey = `segment-${episode}-${segment}`;
  const changeShot = (id: string, update: (shot: Shot) => Shot, label: string) => save({ ...project.docs.storyboard, shots: project.docs.storyboard.shots.map(shot => shot.id === id ? update(shot) : shot) }, label);
  const saveVersion = (url: string, usedPrompt?: string) => { const next = clone(project.docs.storyboard); const found = next.segments?.find(item => item.episode === episode && item.id === segment); const version = { id: uid(), url, createdAt: Date.now(), prompt: usedPrompt || prompt }; if (found) { found.videos.push(version); found.activeVideoId = version.id; } else next.segments = [...(next.segments || []), { episode, id: segment, videos: [version], activeVideoId: version.id }]; save(next, `保存第 ${episode} 集${segment}分段视频`); setBatch(false); };
return <div className="segment-production"><div className="segment-header"><div><div className="eyebrow">分镜 / 第 {episode} 集 / {segment}</div><h1>第 {episode} 集 / {segment}</h1><p>{shots.length} 镜 · {duration}s / 15s</p></div><button className="btn" onClick={() => setBatch(true)}>一键生成本段图片和视频</button></div><div className="segment-video-layout"><section className="panel segment-prompt"><div className="section-heading"><h2>H3 提示词</h2><button className="btn small" onClick={() => navigator.clipboard.writeText(prompt)}>复制整条</button></div><p className="hint">镜头编号和 cut 秒数由时长实时计算</p><p>{multi ? `How the reference pictures align with the target video — ${shots.map((_, index) => `Picture ${index + 1} at ${starts[index].toFixed(2)}s`).join('; ')}.` : 'Use the first shot image as the only visual reference; follow the timeline below.'}</p><div className="eyebrow">integrated_multimodal_description:</div>{shots.map((shot, index) => <div className="segment-prompt-row" key={shot.id}><small>[Shot {index + 1}] At {starts[index].toFixed(2)}s–{(starts[index] + shot.duration).toFixed(2)}s</small><SegmentPromptEditor label="镜头提示词" value={shot.action} save={value => changeShot(shot.id, item => ({ ...item, action: value }), '修改分段镜头提示词')}/></div>)}{shots[0].videoPrompt && <details><summary>查看生成时的原始 H3 提示词</summary><pre>{shots[0].videoPrompt}</pre></details>}</section><section className="segment-video-side"><div className="segment-video-preview">{active ? <video src={active.url} controls preload="metadata"/> : <div>尚未生成本段视频</div>}</div><div className="segment-version-tabs">这一段的历次　{versions.map((version, index) => <button key={version.id} className={active?.id === version.id ? 'active' : ''} onClick={() => { const next = clone(project.docs.storyboard); const item = next.segments?.find(record => record.episode === episode && record.id === segment); if (item) item.activeVideoId = version.id; save(next, '切换分段视频版本'); }}>第 {index + 1} 版</button>)}</div><div className="panel segment-generation"><b>{multi ? `多图对齐模式 · ${shots.length} 张` : '首镜图模式'}</b><p className="hint">{multi ? '按每镜切点提交参考图。' : '当前视频工作流只使用第一镜图片；可在设置中配置多图节点。'}</p>{duration > 15 && <p className="field-error">本段 {duration}s 超过 MiniMax H3 的 15s 上限，请拆段或缩短镜头。</p>}{batch && missing.length > 0 ? <><h3>先生成镜头图片 · 还缺 {missing.length} 张</h3><MediaGenerator key={missing[0].id} project={project} kind="image" targetId={missing[0].id} prompt={`${missing[0].scene}，${missing[0].framing}，${missing[0].action}。画风：${project.style}`} preferQwen onAccept={url => changeShot(missing[0].id, shot => ({ ...shot, image: url }), '保存分段镜头图片')}/></> : <>{missing.length > 0 && <p className="field-error">首镜图未保存；请先生成或选择图片。</p>}{duration <= 15 && shots[0].image && <MediaGenerator project={project} kind="video" targetId={segmentKey} prompt={prompt} source={shots[0].image} duration={duration} segmentMode videoSources={videoSources} cutPoints={multi ? starts : undefined} onAccept={saveVersion}/>}</>}</div></section></div><h2 className="segment-shot-title">逐镜图片与时长</h2><div className="segment-shot-strip">{shots.map((shot, index) => <div className="panel segment-shot-card" key={shot.id}><div className="segment-shot-picture">{shot.image ? <img src={shot.image} alt={`镜头 ${index + 1}`} onClick={() => openImage(shot.image!)}/> : <span>尚无图片</span>}</div><b>Shot {index + 1} · {starts[index].toFixed(2)}s</b><label>时长 <input type="number" min="0.5" max="15" step="0.1" value={shot.duration} onChange={e => { const value = Number(e.target.value); if (value > 0) changeShot(shot.id, item => ({ ...item, duration: value }), '修改分镜时长'); }}/></label><label>分段 <input defaultValue={shot.segmentId || ""} onBlur={e => { const id = e.target.value.trim(); if (id && id !== shot.segmentId) changeShot(shot.id, item => ({ ...item, segmentId: id }), "调整镜头分段"); }}/></label>{media(shot, 'image')}</div>)}</div></div>;
}

function GalleryText({ value, onChange, className = '' }: { value: string; onChange: (value: string) => void; className?: string }) {
  const [editing, setEditing] = useState(false);
  return editing ? <textarea className={`gallery-text-edit ${className}`} autoFocus value={value} onChange={e => onChange(e.target.value)} onBlur={() => setEditing(false)} onKeyDown={e => { if (e.key === 'Escape' || ((e.ctrlKey || e.metaKey) && e.key === 'Enter')) setEditing(false); }}/> : <div className={className} onDoubleClick={() => setEditing(true)} title="双击编辑">{value || <em>双击填写</em>}</div>;
}

function GalleryImageCard({ project, target, title, subtitle, description, prompt, onName, onDescription, onPrompt, onAccept, onDelete, onDetails, onLibrary }: { project: Project; target: Character | ArtAsset; title: string; subtitle: string; description: string; prompt: string; onName: (value: string) => void; onDescription: (value: string) => void; onPrompt: (value: string) => void; onAccept: (url: string) => void; onDelete: () => void; onDetails: () => void; onLibrary: () => void }) {
  const [editingImage, setEditingImage] = useState(false);
  const history = project.assets.filter(asset => asset.sourceItemId === target.id && asset.image);
  const openImage = useContext(OpenImage);
  return <article className="panel gallery-image-card"><div className="gallery-card-top"><span>设定图</span><div><details><summary title="图片历史">◴ {history.length}</summary><div className="gallery-image-history">{history.map(asset => <button key={asset.id} onClick={() => openImage(asset.image!)}><img src={asset.image} alt={asset.name}/></button>)}</div></details><button className="btn small" onClick={() => setEditingImage(true)}>编辑图片</button><button className="btn small" onClick={() => setEditingImage(true)}>重新生成</button></div></div><div className="gallery-card-image">{target.image ? <MediaPicture src={target.image}/> : <span>尚未生成设定图</span>}</div><div className="gallery-card-actions"><button className="btn small" onClick={onLibrary}>加入资产库</button><ImagePicker value={target.image} onChange={onAccept}/></div><div className="gallery-card-identity"><GalleryText value={title} onChange={onName} className="gallery-card-name"/><span>{subtitle}</span></div><GalleryText value={description} onChange={onDescription} className="gallery-card-description"/><div className="gallery-card-prompt-label">出图提示词 <button onClick={() => navigator.clipboard.writeText(prompt)} title="复制提示词">▣</button></div><GalleryText value={prompt} onChange={onPrompt} className="gallery-card-prompt"/><div className="gallery-card-bottom"><button onClick={onDetails}>详情 · 画像 · 弧光 · 关系 · 原文佐证 →</button><button onClick={onDelete}>删除</button></div>{editingImage && <Modal title={`编辑图片 · ${title}`} onClose={() => setEditingImage(false)}><p className="muted">当前图片已作为参考图；使用本地 Qwen-Image-2.1 编辑，生成后预览并确认保存。</p><MediaGenerator project={project} kind="image" targetId={target.id} prompt={prompt} source={target.image} preferQwen onAccept={url => { onAccept(url); setEditingImage(false); }}/></Modal>}</article>;
}

function CastGallery({ project, save, regenerate, addToLibrary, go }: { project: Project; save: (value: Character[]) => void; regenerate: () => void; addToLibrary: (asset: Asset, projectId: string) => void; go: (path: string) => void }) {
  const [draft, setDraft] = useState(() => clone(project.docs.cast)); useEffect(() => setDraft(clone(project.docs.cast)), [project.docs.cast]);
  const update = (id: string, key: keyof Character, value: string) => setDraft(items => items.map(item => item.id === id ? { ...item, [key]: value } : item));
  return <><PageHeading stage="角色 · CAST" title="角色卡" actions={<><button className="btn" onClick={regenerate}>重新生成</button><button className="btn primary" onClick={() => save(draft)}>保存角色</button></>}/><div className="gallery-grid">{draft.map(character => <GalleryImageCard key={character.id} project={project} target={character} title={character.name} subtitle={character.role} description={character.description} prompt={character.imagePrompt || `${character.name}，${character.role}，${character.description}。画风：${project.style}`} onName={value => update(character.id, 'name', value)} onDescription={value => update(character.id, 'description', value)} onPrompt={value => update(character.id, 'imagePrompt', value)} onAccept={url => save(draft.map(item => item.id === character.id ? { ...item, image: url } : item))} onDelete={() => setDraft(items => items.filter(item => item.id !== character.id))} onDetails={() => go(`/p/${project.id}/cast/${encodeURIComponent(character.id)}`)} onLibrary={() => addToLibrary({ id: character.id, type: 'character', name: character.name, description: character.description, image: character.image }, project.id)}/>)}</div><button className="btn" onClick={() => setDraft(items => [...items, { id: uid(), name: '新角色', role: '', description: '', arc: '' }])}>＋ 新增角色</button></>;
}

function ArtGallery({ project, save, regenerate, addToLibrary, go }: { project: Project; save: (value: Project['docs']['art']) => void; regenerate: () => void; addToLibrary: (asset: Asset, projectId: string) => void; go: (path: string) => void }) {
  const [draft, setDraft] = useState(() => clone(project.docs.art)); const [filter, setFilter] = useState<'all' | 'scenes' | 'props'>('all'); useEffect(() => setDraft(clone(project.docs.art)), [project.docs.art]);
  const update = (kind: 'scenes' | 'props', id: string, key: keyof ArtAsset, value: string) => setDraft(current => ({ ...current, [kind]: current[kind].map(item => item.id === id ? { ...item, [key]: value } : item) }));
  return <><PageHeading stage="美术 · ART" title="美术卡" actions={<><button className="btn" onClick={regenerate}>重新生成</button><button className="btn primary" onClick={() => save(draft)}>保存美术</button></>}/><div className="material-tabs">{(['all', 'scenes', 'props'] as const).map(key => <button key={key} className={filter === key ? 'active' : ''} onClick={() => setFilter(key)}>{key === 'all' ? '全部' : key === 'scenes' ? '场景' : '道具'}</button>)}</div><div className="gallery-grid">{(['scenes', 'props'] as const).filter(key => filter === 'all' || filter === key).flatMap(kind => draft[kind].map(asset => <GalleryImageCard key={asset.id} project={project} target={asset} title={asset.name} subtitle={kind === 'scenes' ? '场景' : '道具'} description={asset.description} prompt={asset.prompt || `${asset.name}，${asset.description}。画风：${draft.style}`} onName={value => update(kind, asset.id, 'name', value)} onDescription={value => update(kind, asset.id, 'description', value)} onPrompt={value => update(kind, asset.id, 'prompt', value)} onAccept={url => save({ ...draft, [kind]: draft[kind].map(item => item.id === asset.id ? { ...item, image: url } : item) })} onDelete={() => setDraft(current => ({ ...current, [kind]: current[kind].filter(item => item.id !== asset.id) }))} onDetails={() => go(`/p/${project.id}/art/${kind}/${encodeURIComponent(asset.id)}`)} onLibrary={() => addToLibrary(asset, project.id)}/>))}</div><div className="inline-actions"><button className="btn" onClick={() => setDraft(current => ({ ...current, scenes: [...current.scenes, { id: uid(), type: 'scene', name: '新场景', description: '' }] }))}>＋ 新增场景</button><button className="btn" onClick={() => setDraft(current => ({ ...current, props: [...current.props, { id: uid(), type: 'prop', name: '新道具', description: '' }] }))}>＋ 新增道具</button></div></>;
}

async function referenceBoard(sources: string[]): Promise<string> {
  const images = await Promise.all(sources.map(src => new Promise<HTMLImageElement>((resolve, reject) => {
    const picture = new Image(); picture.onload = () => resolve(picture); picture.onerror = () => reject(new Error('参考图加载失败，请移除不可用的图片。')); picture.src = src;
  })));
  const canvas = document.createElement('canvas'); canvas.width = 1024; canvas.height = 1024;
  const context = canvas.getContext('2d'); if (!context) throw new Error('无法合成参考图。');
  context.fillStyle = '#202320'; context.fillRect(0, 0, 1024, 1024);
  const columns = 2; const rows = Math.ceil(images.length / columns);
  images.forEach((picture, index) => {
    const width = 1024 / columns; const height = 1024 / rows; const x = index % columns * width; const y = Math.floor(index / columns) * height;
    const scale = Math.min((width - 32) / picture.naturalWidth, (height - 48) / picture.naturalHeight);
    const drawnWidth = picture.naturalWidth * scale; const drawnHeight = picture.naturalHeight * scale;
    context.drawImage(picture, x + (width - drawnWidth) / 2, y + (height - drawnHeight) / 2, drawnWidth, drawnHeight);
    context.fillStyle = '#fff'; context.font = 'bold 24px sans-serif'; context.fillText(String(index + 1), x + 16, y + 30);
  });
  try { return canvas.toDataURL('image/jpeg', 0.88); } catch { throw new Error('无法合成参考图，请检查图片文件。'); }
}

function MediaGenerator({ project, kind, targetId, prompt, source, duration, onAccept, preferQwen = false, videoSources, cutPoints, segmentMode = false }: { project: Project; kind: 'image' | 'video'; targetId: string; prompt: string; source?: string; duration?: number; onAccept: (url: string, usedPrompt?: string) => void; preferQwen?: boolean; videoSources?: string[]; cutPoints?: number[]; segmentMode?: boolean }) {
  const storageKey = `reelbench-media-${project.id}-${kind}-${targetId}`;
  const [job, setJob] = useState<MediaJob | null>(null);
  const [error, setError] = useState('');
  const [references, setReferences] = useState<string[]>(source ? [source] : []);
  const [draftPrompt, setDraftPrompt] = useState(prompt);
  const [promptEdited, setPromptEdited] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [provider, setProvider] = useState<'qwen' | 'gpt'>('qwen');
  const deletedImages = useContext(DeletedImages);
  const registerMedia = useContext(RegisterMedia);
  const [chooseReference, setChooseReference] = useState(false);
  useEffect(() => { if (kind === 'image') { if (preferQwen) setProvider('qwen'); else getSettings().then(s => setProvider(s.imageProvider)).catch(() => {}); } }, [kind, preferQwen]);
  useEffect(() => { setReferences(source ? [source] : []); setDraftPrompt(prompt); setPromptEdited(false); }, [project.id, targetId, kind]);
  useEffect(() => { if (!promptEdited) setDraftPrompt(prompt); }, [prompt, promptEdited]);
  useEffect(() => { const id = sessionStorage.getItem(storageKey); if (id) getMediaJob(id).then(setJob).catch(e => { if (/不存在|重启/.test((e as Error).message)) { sessionStorage.removeItem(storageKey); setJob(null); setError('服务已重启，原任务已失效，请重新提交。'); } else setError((e as Error).message); }); }, [storageKey]);
  useEffect(() => { if (!job || !['queued', 'running'].includes(job.status)) return; const timer = window.setInterval(() => getMediaJob(job.id).then(next => { setJob(current => current?.id === next.id && current.status !== 'cancelled' ? next : current); setError(''); }).catch(e => { if (/不存在|重启/.test((e as Error).message)) { sessionStorage.removeItem(storageKey); setJob(null); setError('服务已重启，原任务已失效，请重新提交。'); } else setError((e as Error).message); }), 1600); return () => clearInterval(timer); }, [job?.id, job?.status, storageKey]);
  async function start() {
    setError('');
    if (kind === 'video' && source && deletedImages.includes(imageKey(source))) return setError('分镜首帧已被删除，请先更换图片。');
    if (kind === 'image' && references.some(reference => deletedImages.includes(imageKey(reference)))) return setError('所选参考图已被删除，请更换参考图。');
    if (kind === 'image' && references.length > 4) return setError('最多选择 4 张参考图。');
    if (kind === 'video' && (!source || (!segmentMode && project.docs.storyboard.shots.find(shot => shot.id === targetId)?.image !== source))) return setError('请先保存分镜图片，再生成视频。');
    if (kind === 'video' && (!duration || duration < 1 || duration > 15)) return setError('MiniMax H3 单镜时长应为 1–15 秒。');
    setPreparing(true);
    try {
      const qwenSource = kind === 'image' && provider === 'qwen' && references.length > 1 ? await referenceBoard(references) : references[0];
      const started = await createMediaJob({ projectId: project.id, kind, provider: kind === 'image' ? provider : undefined, prompt: kind === 'image' ? draftPrompt.trim() : prompt, source: kind === 'video' ? source : provider === 'qwen' ? qwenSource : undefined, sources: kind === 'image' ? references : videoSources, cutPoints: kind === 'video' ? cutPoints : undefined, duration, ratio: project.ratio });
      setJob(started); sessionStorage.setItem(storageKey, started.id);
    }
    catch (e) { setError((e as Error).message); }
    finally { setPreparing(false); }
  }
  function close() { sessionStorage.removeItem(storageKey); setJob(null); }
  async function cancel() { if (!job || cancelling) return; setCancelling(true); setError(''); try { setJob(await cancelMediaJob(job.id)); } catch (e) { setError(`取消失败：${(e as Error).message}`); } finally { setCancelling(false); } }
  async function discard() { if (job?.status === 'completed') { try { await discardMediaJob(job.id); } catch (e) { setError((e as Error).message); return; } } close(); }
  function acceptResult() {
    if (!job?.result) return;
    const url = job.result.url;
    const character = project.docs.cast.find(item => item.id === targetId);
    const art = [...project.docs.art.scenes, ...project.docs.art.props].find(item => item.id === targetId);
    const shot = project.docs.storyboard.shots.find(item => item.id === targetId);
    const type: AssetType = character ? 'character' : art?.type || 'other';
    const name = character?.name || art?.name || (shot ? `分镜 · ${shot.scene}` : '生成媒体');
    onAccept(url, job.result.prompt);
    registerMedia(project.id, { id: uid(), type, name: kind === 'video' ? `${name} · 视频` : name, description: job.result.prompt, mediaKind: kind, sourceItemId: targetId, generatedAt: job.result.generatedAt, provider: kind === 'image' ? provider : 'minimax_h3', ...(kind === 'image' ? { image: url } : { video: url }) });
    close();
  }
  return <div className={kind === 'image' ? 'media-generator image-composer' : 'media-generator'}>{kind === 'image' && <><div className="image-composer-references"><button className="btn small" disabled={references.length >= 4} onClick={() => setChooseReference(true)}>＋ 参考图 {references.length}/4</button><div className="image-composer-thumbnails">{references.map((reference, index) => <div className="reference-preview" key={reference}><MediaPicture src={reference}/><span className="reference-preview-index">{index + 1}</span><button className="reference-preview-remove" onClick={() => setReferences(current => current.filter(item => item !== reference))} title="移除参考图" aria-label={`移除第 ${index + 1} 张参考图`}>×</button></div>)}</div></div><textarea className="image-composer-prompt" aria-label="生图提示词" placeholder="描述想要生成的画面…" maxLength={8000} value={draftPrompt} onChange={e => { setDraftPrompt(e.target.value); setPromptEdited(true); }}/><div className="image-composer-footer"><select aria-label="生图模型" value={provider} onChange={e => setProvider(e.target.value as 'qwen' | 'gpt')}><option value="qwen">Qwen-Image-2.1 · 本机</option><option value="gpt">GPT Image 2.5 · API</option></select><button className="btn primary small" disabled={!!job || preparing || !draftPrompt.trim()} onClick={start}>{preparing ? '准备参考图…' : '↑ 生图'}</button></div></>}
    {kind === 'video' && <button className="btn small" disabled={!!job} onClick={start}>MiniMax H3 生视频</button>}
    {job && (job.status === 'queued'
      ? <div className="media-job media-job-queued" role="status"><span>排队第 {job.queuePosition || 1} 位</span><button className="btn small" disabled={cancelling} onClick={() => void cancel()}>{cancelling ? '正在取消…' : '取消任务'}</button></div>
      : job.status === 'running'
        ? <div className="media-job media-job-loading" role="status" aria-label={job.message || '正在生成'}><span className="media-spinner" aria-hidden="true"/><button className="btn small" disabled={cancelling} onClick={() => void cancel()}>{cancelling ? '正在取消…' : '取消任务'}</button></div>
        : <div className="media-job">{job.status === 'failed' && <><p className="field-error">{job.error || job.message || '生成失败'}</p><button className="btn small" onClick={close}>关闭</button></>}{job.status === 'cancelled' && <><p>{job.message || '任务已取消。'}</p><button className="btn small" onClick={close}>关闭</button></>}{job.status === 'completed' && job.result && <>{kind === 'image' ? <MediaPicture src={job.result.url}/> : <MediaClip src={job.result.url}/>}<div className="inline-actions">{kind === 'image' && <MediaDownload src={job.result.url} kind={kind}/>}<button className="btn small" onClick={() => void discard()}>放弃</button><button className="btn primary small" onClick={acceptResult}>确认保存</button></div></>}</div>)}
    {chooseReference && <ImageChooser project={project} selected={references} onSelectionChange={setReferences} onClose={() => setChooseReference(false)}/>}{error && <small className="field-error">{error}</small>}</div>;
}
function MediaPicture({ src }: { src: string }) { const [missing, setMissing] = useState(false); const deleted = useContext(DeletedImages).includes(imageKey(src)); const open = useContext(OpenImage); useEffect(() => setMissing(false), [src]); return deleted ? <span className="media-missing">已被删除</span> : missing ? <span className="media-missing">本机图片文件不可用</span> : <button className="zoomable-image" onClick={() => open(src)} title="点击放大图片"><img src={src} alt="项目图片" onError={() => setMissing(true)}/></button>; }
function MediaClip({ src }: { src: string }) { const [missing, setMissing] = useState(false); const deleted = useContext(DeletedImages).includes(imageKey(src)); const open = useContext(OpenVideo); useEffect(() => setMissing(false), [src]); return deleted ? <div className="media-missing">已被删除</div> : missing ? <div className="media-missing">本机视频文件不可用</div> : <div className="media-clip"><button className="media-clip-open" onClick={() => open(src)} title="点击按原始比例播放视频"><video className="shot-video" src={src} muted playsInline preload="metadata" onError={() => setMissing(true)}/><span>▶ 点击播放</span></button><MediaDownload src={src} kind="video"/></div>; }
function ImageChooser({ project, onSelect, selected, onSelectionChange, onClose }: { project?: Project; onSelect?: (url: string) => void; selected?: string[]; onSelectionChange?: (urls: string[]) => void; onClose: () => void }) {
  const globalAssets = useContext(LibraryContext); const deleted = useContext(DeletedImages);
  const [tab, setTab] = useState<'project' | 'global'>(project ? 'project' : 'global');
  const [category, setCategory] = useState<AssetType | 'all'>('all');
  const [query, setQuery] = useState('');
  const [unavailable, setUnavailable] = useState<string[]>([]);
  const projectAssets = project ? [...(project.assets || []), ...project.referenceImages.map((image, i) => ({ id: `reference-${i}`, type: 'other' as const, name: `创作参考图 ${i + 1}`, description: '', image }))] : [];
  const available = [...new Map((tab === 'project' ? projectAssets : globalAssets).filter(a => a.image && !deleted.includes(imageKey(a.image)) && !unavailable.includes(a.image)).map(a => [a.image, a])).values()];
  const counts = { all: available.length, character: available.filter(a => a.type === 'character').length, scene: available.filter(a => a.type === 'scene').length, prop: available.filter(a => a.type === 'prop').length, other: available.filter(a => a.type === 'other').length };
  const visible = available.filter(a => (category === 'all' || a.type === category) && `${a.name} ${a.description}`.toLowerCase().includes(query.toLowerCase()));
  return <Modal title="选择图片" onClose={onClose}><div className="filter-tabs image-chooser-tabs">{project && <button className={tab === 'project' ? 'active' : ''} onClick={() => setTab('project')}>项目资产库</button>}<button className={tab === 'global' ? 'active' : ''} onClick={() => setTab('global')}>全局资产库</button></div><div className="image-chooser-filters"><AssetFilter value={category} onChange={setCategory} counts={counts}/><input className="search-input" placeholder="搜索图片…" value={query} onChange={e => setQuery(e.target.value)}/></div><div className="image-chooser-grid">{visible.map(a => { const isSelected = !!selected?.includes(a.image!); return <button key={a.id} className={isSelected ? 'selected' : ''} aria-pressed={selected ? isSelected : undefined} disabled={!!selected && !isSelected && selected.length >= 4} onClick={() => { if (selected && onSelectionChange) onSelectionChange(isSelected ? selected.filter(url => url !== a.image) : [...selected, a.image!]); else { onSelect?.(a.image!); onClose(); } }}><img src={a.image} alt={a.name} onError={() => setUnavailable(v => v.includes(a.image!) ? v : [...v, a.image!])}/><span>{a.name}</span>{isSelected && <b className="image-chooser-selected">✓</b>}</button>; })}</div>{!visible.length && <p className="muted">没有符合条件的图片。</p>}{selected && <p className="image-chooser-count">已选择 {selected.length}/4 张参考图</p>}<div className="modal-actions"><button className="btn" onClick={onClose}>{selected ? '完成' : '关闭'}</button></div></Modal>;
}
function ImagePicker({ value, onChange }: { value?: string; onChange: (value: string) => void }) { const [open, setOpen] = useState(false); const project = useContext(CurrentProject); return <div className="image-picker"><button className="btn small" onClick={() => setOpen(true)}>{value ? '从资产库更换图片' : '从资产库选择图片'}</button>{value && <button className="text-button" onClick={() => onChange('')}>移除图片</button>}{open && <ImageChooser project={project} onSelect={onChange} onClose={() => setOpen(false)}/>}</div>; }

function StoryboardPage({ project, save, regenerate }: { project: Project; save: (value: Project['docs']['storyboard']) => void; regenerate: () => void; notify: (message: string) => void }) { const [draft, setDraft] = useState(() => clone(project.docs.storyboard)); useEffect(() => setDraft(clone(project.docs.storyboard)), [project.docs.storyboard]); function edit(i: number, key: keyof Shot, value: string | number) { setDraft(d => ({ ...d, shots: d.shots.map((s, j) => j === i ? { ...s, [key]: value } : s) })); } return <><PageHeading stage="STAGE 05 · 怎么拍 · STORYBOARD" title="分镜" subtitle="逐镜调整构图、动作和时长，并用本机 MiniMax H3 生成视频片段。" actions={<><button className="btn" onClick={regenerate}>重新生成</button><button className="btn primary" onClick={() => save(draft)}>保存分镜</button></>}/><div className="storyboard-grid">{draft.shots.map((shot, i) => <section className="panel shot-card" key={shot.id}><div className="shot-frame"><span>SHOT {String(i + 1).padStart(2, '0')}</span>{shot.image ? <><MediaPicture src={shot.image}/><MediaDownload src={shot.image} name={`镜头 ${i + 1}`} kind="image"/></> : <b>▣</b>}</div><div className="shot-info"><div className="section-heading"><span className="eyebrow">镜头 {i + 1}</span><button className="text-button" onClick={() => setDraft(d => ({ ...d, shots: d.shots.filter((_, j) => j !== i) }))}>删除</button></div><div className="two-fields"><label className="compact-field">场景<input value={shot.scene} onChange={e => edit(i, 'scene', e.target.value)}/></label><label className="compact-field">景别<input value={shot.framing} onChange={e => edit(i, 'framing', e.target.value)}/></label></div><Field label="画面与动作" value={shot.action} onChange={v => edit(i, 'action', v)}/><label className="compact-field">时长（秒）<input type="number" min="1" value={shot.duration} onChange={e => edit(i, 'duration', Number(e.target.value))}/></label><ImagePicker value={shot.image} onChange={v => edit(i, 'image', v)}/><MediaGenerator project={project} kind="image" targetId={shot.id} prompt={`${shot.scene}，${shot.framing}，${shot.action}。画风：${project.style}`} source={shot.image} onAccept={url => save({ ...draft, shots: draft.shots.map((item, j) => j === i ? { ...item, image: url } : item) })}/><MediaGenerator project={project} kind="video" targetId={shot.id} prompt={`${shot.scene}，${shot.framing}，${shot.action}`} source={shot.image} duration={shot.duration} onAccept={url => save({ ...draft, shots: draft.shots.map((item, j) => j === i ? { ...item, video: url } : item) })}/>{shot.video && <MediaClip src={shot.video}/>}</div></section>)}</div><div className="inline-actions spaced"><button className="btn" onClick={() => setDraft(d => ({ ...d, shots: [...d.shots, { id: uid(), scene: '新场景', framing: '中景', action: '', duration: 4 }] }))}>＋ 新增镜头</button><span className="hint">在每个分镜内使用已保存的图片生成视频片段。</span></div></>; }

function HistoryPage({ project, updateProject, notify }: { project: Project; updateProject: (id: string, change: (project: Project) => Project) => void; notify: (message: string) => void }) {
  const [selected, setSelected] = useState<string | null>(null);
  const [confirmChange, setConfirmChange] = useState<string | null>(null);
  const deleteChange = useContext(DeleteChange);
  const change = project.changes.find(c => c.id === selected);
  function restore(id: string) {
    updateProject(project.id, p => {
      const old = p.changes.find(c => c.id === id);
      if (!old) return p;
      p.changes.unshift({ id: uid(), at: Date.now(), section: old.section, label: `恢复版本 · ${old.label}`, before: clone(p.docs[old.section]), after: clone(old.before), beforeArtifact: p.skillArtifacts?.[old.section] ? clone(p.skillArtifacts[old.section]) : undefined, beforeGeneratedSource: old.section === 'outline' ? p.generatedSource : undefined });
      (p.docs as unknown as Record<DocKey, Project['docs'][DocKey]>)[old.section] = clone(old.before);
      p.skillArtifacts = { ...p.skillArtifacts, [old.section]: old.beforeArtifact ? clone(old.beforeArtifact) : undefined };
      if (old.section === 'outline') p.generatedSource = old.beforeGeneratedSource;
      return p;
    });
    setSelected(null); notify('已恢复版本，可再次撤回');
  }
  return <><PageHeading stage="变更 · HISTORY" title="变更历史" subtitle="每次保存、生成和恢复都记录修改前后；可按批撤销。"/><div className="history-list">{project.changes.length ? project.changes.map(c => <div className="history-row" key={c.id}><button className="history-item" onClick={() => setSelected(c.id)}><span className="history-dot"/><span><strong>{c.label}</strong><small>{sectionLabel(c.section)} · {fmt(c.at)}</small></span><em>查看改前／改后 →</em></button><button className="history-delete" aria-label={`删除${c.label}的变更记录`} title="删除记录" onClick={() => setConfirmChange(c.id)}>×</button></div>) : <div className="empty-state">暂无变更记录。编辑并保存内容后，这里会显示旧版本。</div>}</div>{change && <Modal title="查看变更" onClose={() => setSelected(null)}><div className="eyebrow">{sectionLabel(change.section)} · {fmt(change.at)}</div><p>{change.label}</p><div className="history-comparison"><div><strong>改前</strong><pre className="version-preview">{JSON.stringify(change.before, null, 2)}</pre></div><div><strong>改后{change.after ? '' : ' · 旧记录未保存改后快照'}</strong><pre className="version-preview">{JSON.stringify(change.after || project.docs[change.section], null, 2)}</pre></div></div><div className="modal-actions"><button className="btn" onClick={() => setSelected(null)}>关闭</button><button className="btn primary" onClick={() => restore(change.id)}>撤销这批</button></div></Modal>}{confirmChange && <Modal title="删除变更记录" onClose={() => setConfirmChange(null)}><p>确定删除「{project.changes.find(c => c.id === confirmChange)?.label}」？删除后无法从这条记录恢复，当前文档和媒体不会改变。</p><div className="modal-actions"><button className="btn" onClick={() => setConfirmChange(null)}>取消</button><button className="btn danger" onClick={() => { deleteChange(project.id, confirmChange); setConfirmChange(null); }}>删除记录</button></div></Modal>}</>;
}

function AssetFilter({ value, onChange, counts }: { value: AssetType | 'all'; onChange: (value: AssetType | 'all') => void; counts: Record<AssetType | 'all', number> }) { return <div className="filter-tabs">{([['all', '全部'], ['character', '角色'], ['scene', '场景'], ['prop', '道具'], ['other', '其它']] as const).map(([key, label]) => <button key={key} className={value === key ? 'active' : ''} onClick={() => onChange(key)}>{label} <small>{counts[key]}</small></button>)}</div>; }
function AssetCards({ assets, action, actionLabel, deleteAsset }: { assets: Asset[]; action?: (asset: Asset) => void; actionLabel?: string; deleteAsset?: (asset: Asset) => void }) {
  return <div className="asset-grid">{assets.map(a => <article className="panel asset-card" key={a.id}><div className={`asset-placeholder${a.video ? ' asset-placeholder-video' : ''}`}><span>{a.type === 'character' ? '人' : a.type === 'scene' ? '景' : a.type === 'prop' ? '物' : '◇'}</span>{a.image && <MediaPicture src={a.image}/ >}{a.video && <MediaClip src={a.video}/>}</div><div className="asset-card-body"><span className="eyebrow">{assetNames[a.type] || '其它'} · {a.video ? '视频' : a.image ? '图片' : '内容'}</span><h3>{a.name}</h3><p>{a.description}</p><div className="inline-actions">{a.image && <MediaDownload src={a.image} name={a.name} kind="image"/>}{a.video && <MediaDownload src={a.video} name={a.name} kind="video"/>}{action && <button className="btn small" onClick={() => action(a)}>{actionLabel}</button>}{deleteAsset && <button className="btn small danger" onClick={() => deleteAsset(a)}>删除</button>}</div></div></article>)}</div>;
}
function GlobalLibrary({ state, importAsset, deleteAsset, addUpload, go }: { state: Store; importAsset: (asset: Asset, projectId: string) => void; deleteAsset: (asset: Asset) => void; addUpload: (asset: Asset) => void; go: (path: string) => void }) {
  const [type, setType] = useState<AssetType | 'all'>('all'); const [media, setMedia] = useState<'all' | 'image' | 'video'>('all');
  const [query, setQuery] = useState(''); const [target, setTarget] = useState(''); const [uploadType, setUploadType] = useState<AssetType>('other');
  const [uploadError, setUploadError] = useState(''); const [busy, setBusy] = useState(false);
  const counts = useMemo(() => ({ all: state.library.length, character: state.library.filter(a => a.type === 'character').length, scene: state.library.filter(a => a.type === 'scene').length, prop: state.library.filter(a => a.type === 'prop').length, other: state.library.filter(a => a.type === 'other').length }), [state.library]);
  const visible = state.library.filter(a => (type === 'all' || a.type === type) && (media === 'all' || (media === 'image' ? !!a.image : !!a.video)) && `${a.name} ${a.description}`.toLowerCase().includes(query.toLowerCase()));
  async function upload(file?: File) {
    if (!file) return;
    const kind = file.type.startsWith('image/') || /\.(png|jpe?g|webp)$/i.test(file.name) ? 'image' : file.type.startsWith('video/') || /\.(mp4|webm)$/i.test(file.name) ? 'video' : null;
    if (!kind) return setUploadError('请选择图片或视频文件。');
    if (file.size > (kind === 'image' ? 20 : 250) * 1024 * 1024) return setUploadError(kind === 'image' ? '图片不得超过 20 MB。' : '视频不得超过 250 MB。');
    setBusy(true); setUploadError('');
    try { const { url } = await uploadLibraryMedia(file, kind); addUpload({ id: uid(), type: uploadType, name: file.name.replace(/\.[^.]+$/, ''), description: '本机上传', mediaKind: kind, ...(kind === 'image' ? { image: url } : { video: url }) }); }
    catch (error) { setUploadError((error as Error).message); }
    finally { setBusy(false); }
  }
  return <><PageHeading stage="用户级 · 跨项目复用 · ASSET LIBRARY" title="资产库" subtitle="上传图片和视频，按角色、场景、道具或其它分类，再导入项目使用。"/><div className="library-target panel global-library-row"><div><strong>上传媒体</strong><p>图片支持 PNG、JPEG、WebP，视频支持 MP4、WebM。</p></div><div className="global-library-controls"><select aria-label="上传分类" value={uploadType} onChange={e => setUploadType(e.target.value as AssetType)}>{(Object.keys(assetNames) as AssetType[]).map(key => <option key={key} value={key}>{assetNames[key]}</option>)}</select><label className="btn small library-upload-button">{busy ? '正在上传…' : '上传图片或视频'}<input type="file" accept="image/png,image/jpeg,image/webp,video/mp4,video/webm" disabled={busy} onChange={e => { void upload(e.target.files?.[0]); e.target.value = ''; }}/></label></div></div>{uploadError && <p className="field-error">{uploadError}</p>}<div className="library-target panel global-library-row"><div><strong>导入目标</strong><p>选择项目后，可将资产复制到项目库。</p></div><select value={target} onChange={e => setTarget(e.target.value)}><option value="">暂不选择项目</option>{state.projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></div><div className="library-toolbar global-library-toolbar"><AssetFilter value={type} onChange={setType} counts={counts}/><div className="global-library-controls"><select className="media-filter" value={media} onChange={e => setMedia(e.target.value as typeof media)}><option value="all">所有媒体</option><option value="image">图片</option><option value="video">视频</option></select><input className="search-input" value={query} onChange={e => setQuery(e.target.value)} placeholder="搜索资产…"/></div></div>{visible.length ? <AssetCards assets={visible} action={target ? a => importAsset(a, target) : undefined} actionLabel="导入到项目" deleteAsset={deleteAsset}/> : <div className="empty-state"><div className="empty-icon">◇</div><h2>{state.library.length ? '没有找到匹配的资产' : '资产库还是空的'}</h2><p>可以在这里上传图片或视频，也可以从项目编辑页将角色和美术加入全局库。</p><button className="btn" onClick={() => go('/dashboard')}>返回工作台</button></div>}</>;
}
function ProjectLibrary({ project, globalAssets, importAsset, deleteAsset, deleteReference }: { project: Project; globalAssets: Asset[]; importAsset: (asset: Asset, projectId: string) => void; deleteAsset: (asset: Asset) => void; deleteReference: (source: string, index: number) => void }) {
  const [type, setType] = useState<AssetType | 'all'>('all'); const [media, setMedia] = useState<'all' | 'image' | 'video'>('all'); const [query, setQuery] = useState(''); const [showGlobal, setShowGlobal] = useState(false);
  const assets = project.assets || [];
  const counts = { all: assets.length, character: assets.filter(a => a.type === 'character').length, scene: assets.filter(a => a.type === 'scene').length, prop: assets.filter(a => a.type === 'prop').length, other: assets.filter(a => a.type === 'other').length };
  const visible = assets.filter(a => (type === 'all' || a.type === type) && (media === 'all' || (media === 'image' ? !!a.image : !!a.video)) && `${a.name} ${a.description}`.toLowerCase().includes(query.toLowerCase()));
  return <><PageHeading stage="PROJECT ASSETS" title={project.kind === 'novel' ? '素材库' : '项目资产库'} subtitle="查看已确认的生成结果与导入资产。" actions={<button className="btn" onClick={() => setShowGlobal(v => !v)}>{showGlobal ? '收起全局资产库' : '从全局资产库导入'}</button>}/>{project.referenceImages.length > 0 && <section className="panel"><h2>创作参考图</h2><div className="reference-grid">{project.referenceImages.map((src, i) => <div className="reference-card" key={i}><MediaPicture src={src}/><MediaDownload src={src} name={`创作参考图 ${i + 1}`} kind="image"/><button className="btn small danger" onClick={() => deleteReference(src, i)}>删除</button></div>)}</div></section>}{showGlobal && <section className="panel"><h2>全局资产库</h2>{globalAssets.length ? <AssetCards assets={globalAssets} action={a => importAsset(a, project.id)} actionLabel="导入这个项目"/> : <p className="muted">全局资产库暂无内容。</p>}</section>}<div className="library-toolbar project-library-toolbar"><AssetFilter value={type} onChange={setType} counts={counts}/><div className="project-library-controls"><select className="media-filter" value={media} onChange={e => setMedia(e.target.value as typeof media)}><option value="all">所有媒体</option><option value="image">图片</option><option value="video">视频</option></select><input className="search-input" value={query} onChange={e => setQuery(e.target.value)} placeholder="搜索项目资产…"/></div></div>{visible.length ? <AssetCards assets={visible} deleteAsset={deleteAsset}/> : <div className="empty-state"><div className="empty-icon">◇</div><h2>暂无项目资产</h2><p>确认生成图片或视频后会自动出现在这里，也可以从全局资产库导入。</p></div>}</>;
}
