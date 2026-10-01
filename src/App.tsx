import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { clone, IMAGE_RATIOS, makeDocs, makeProject, sectionLabel, uid } from './model';
import type { ArtAsset, Asset, AssetType, Character, Consultation, DocKey, ImageRatio, Outline, Project, ProjectSummary, Shot, Store } from './model';
import { listenForUpdates, loadProjectParts, loadStoreSummary, saveProjectMutation, createProject as persistProject, saveStoreIndex } from './db';
import { consult, continueJob, createJob, createMediaJob, getMediaJob, cancelMediaJob, discardMediaJob, copyMediaToLibrary, uploadLibraryMedia, deleteMedia, getSettings, getJob, removeProjectRuns, startProjectImport, uploadProjectImportFile, finishProjectImport } from './codex';
import type { Job, MediaJob } from './codex';
import SettingsPage from './SettingsPage';
import { decodeImportedText } from './textImport';
import { imageKey, ownedMediaUrl } from './mediaRefs';
import { copyText } from './clipboard';
import { CopyPromptIcon } from './CopyPromptIcon';
import { DeleteIcon } from './DeleteIcon';
import { ProjectDetail, ProjectMaterialTabs, ProjectStoryboardSummary, ProjectSubnav } from './ProjectDetails';
import { useScriptDialogueReport, voiceoverDialogueGroup } from './scriptReport';

const EMPTY: Store = { projects: [], library: [] };
const DOC_PARTS: Record<string, string[]> = {
  overview: [],
  outline: ['doc-outline', 'doc-cast', 'doc-art', 'artifacts', 'source'],
  script: ['doc-script', 'doc-outline', 'doc-cast', 'doc-art', 'artifacts', 'consultations'],
  cast: ['doc-cast', 'doc-outline', 'assets', 'artifacts'],
  art: ['doc-art', 'doc-outline', 'doc-cast', 'doc-script', 'doc-storyboard', 'assets', 'artifacts'],
  storyboard: ['doc-storyboard', 'doc-outline', 'doc-script', 'doc-cast', 'doc-art', 'assets', 'artifacts'],
  library: ['assets', 'references'],
  history: ['changes']
};
const IMAGE_STYLES = ['写实人像', '电影剧照', '日系动漫', '赛博霓虹', '产品棚拍', '等距 3D', '水彩', '水墨', '扁平插画', '黏土', '像素', '油画'];
type Route = { page: 'dashboard' | 'library' | 'templates' | 'settings' | 'project'; id?: string; tab?: string; detail?: string[] };
const assetNames: Record<AssetType, string> = { character: '角色', scene: '场景', prop: '道具', storyboard: '分镜图', other: '其它' };
const DeletedImages = createContext<string[]>([]);
const Notify = createContext<(message: string) => void>(() => {});
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
function projectStub(summary: ProjectSummary): Project {
  const { referenceImageCount: _referenceImageCount, ...projectSummary } = summary;
  return { ...projectSummary, referenceImages: [], docs: makeDocs(summary.prompt || summary.name, Math.max(1, summary.docStats?.outlineEpisodes || summary.episodeCount || 1), summary.kind), assets: [], changes: [], consultations: [], skillArtifacts: {}, loadedParts: [], revisions: summary.revisions || {}, partRevisions: { meta: summary.revisions?.meta ?? null } };
}
function MediaDownload({ src, name, kind }: { src: string; name?: string; kind: 'image' | 'video' }) {
  const extension = src.match(/\.(png|jpe?g|webp|mp4|webm|mov)(?:\?|$)/i)?.[1] || (kind === 'video' ? 'mp4' : src.match(/^data:image\/(png|jpeg|webp)/)?.[1] || 'png');
  const filename = `${(name || (kind === 'video' ? '视频' : '图片')).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')}.${extension === 'jpeg' ? 'jpg' : extension}`;
  return <a className="btn small media-download" href={src} download={filename} onClick={e => e.stopPropagation()}>↓ 下载</a>;
}

export default function App() {
  const [state, setState] = useState<Store>(EMPTY);
  const stateRef = useRef(state);
  stateRef.current = state;
  const mutationQueue = useRef(new Map<string, Promise<void>>());
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
  const [zoomMode, setZoomMode] = useState<'fit' | 'actual'>('fit');
  const [zoomDimensions, setZoomDimensions] = useState<{ width: number; height: number } | null>(null);
  const zoomViewport = useRef<HTMLDivElement>(null);
  const zoomedImage = useRef<HTMLImageElement>(null);
  const [zoomVideo, setZoomVideo] = useState<string | null>(null);
  const [zoomVideoDimensions, setZoomVideoDimensions] = useState<{ width: number; height: number } | null>(null);
  const zoomVideoViewport = useRef<HTMLDivElement>(null);
  const zoomedVideo = useRef<HTMLVideoElement>(null);
  function showImage(src: string) { setZoomImage(src); setZoomVideo(null); setZoomMode('fit'); setZoomDimensions(null); }
  function showVideo(src: string) { setZoomVideo(src); setZoomImage(null); setZoomMode('fit'); setZoomVideoDimensions(null); }
  useLayoutEffect(() => {
    const viewport = zoomImage ? zoomViewport.current : zoomVideo ? zoomVideoViewport.current : null;
    const media = zoomImage ? zoomedImage.current : zoomVideo ? zoomedVideo.current : null;
    if (!viewport || !media) return;
    viewport.scrollTo({ left: 0, top: 0, behavior: 'instant' });
    if (zoomMode === 'actual') {
      const viewportRect = viewport.getBoundingClientRect(); const mediaRect = media.getBoundingClientRect();
      viewport.scrollTo({ left: mediaRect.left + mediaRect.width / 2 - viewportRect.left - viewport.clientWidth / 2, top: mediaRect.top + mediaRect.height / 2 - viewportRect.top - viewport.clientHeight / 2, behavior: 'instant' });
    }
  }, [zoomMode, zoomImage, zoomDimensions, zoomVideo, zoomVideoDimensions]);
  useEffect(() => { if (!zoomImage && !zoomVideo) return; const close = (event: KeyboardEvent) => { if (event.key === 'Escape') { setZoomImage(null); setZoomVideo(null); } }; window.addEventListener('keydown', close); return () => window.removeEventListener('keydown', close); }, [zoomImage, zoomVideo]);

  useEffect(() => { loadStoreSummary().then(summary => {
    const next = { ...EMPTY, ...summary, projects: summary.projects.map(projectStub) } as Store;
    setState(next); setReady(true);
  }).catch(() => { setReady(true); setSaveError('无法读取本机项目文件，请检查本机服务。'); }); }, []);
  useEffect(() => listenForUpdates(() => { loadStoreSummary().then(remote => setState(current => {
    const byId = new Map(current.projects.map(project => [project.id, project]));
    const projects = remote.projects.map(summary => {
      const existing = byId.get(summary.id);
      const stub = projectStub(summary);
      if (!existing) return stub;
      return { ...stub, ...existing, ...summary, docs: existing.docs, assets: existing.assets, changes: existing.changes, consultations: existing.consultations, skillArtifacts: existing.skillArtifacts, sourceText: existing.sourceText, generatedSource: existing.generatedSource, loadedParts: existing.loadedParts || [], revisions: summary.revisions || {}, partRevisions: { ...(existing.partRevisions || {}), meta: summary.revisions?.meta ?? null } } as Project;
    });
    return { ...current, ...remote, projects } as Store;
  })).catch(() => {}); }), []);
  useEffect(() => {
    if (!ready || route.page !== 'project' || !route.id) return;
    const project = state.projects.find(item => item.id === route.id);
    if (!project) return;
    const parts = DOC_PARTS[route.tab || 'overview'] || [];
    const loaded = new Set(project.loadedParts || []);
    const wantedRevision = project.revisions || {};
    const missing = parts.filter(part => !loaded.has(part) || (project.partRevisions?.[part] ?? null) !== (wantedRevision[part] ?? null));
    if (!missing.length) return;
    let active = true;
    loadProjectParts(project.id, missing).then(result => {
      if (!active) return;
      setState(current => ({ ...current, projects: current.projects.map(item => item.id !== project.id ? item : {
        ...item, ...result, docs: { ...item.docs, ...result.docs }, assets: missing.includes('assets') ? result.assets : item.assets,
        changes: missing.includes('changes') ? result.changes : item.changes, consultations: missing.includes('consultations') ? result.consultations : item.consultations,
        referenceImages: missing.includes('references') ? result.referenceImages : item.referenceImages,
        skillArtifacts: missing.includes('artifacts') ? result.skillArtifacts : item.skillArtifacts,
        loadedParts: [...new Set([...(item.loadedParts || []), ...parts])], partRevisions: { ...(item.partRevisions || {}), ...result.revisions }, revisions: { ...(item.revisions || {}), ...result.revisions }
      }) }));
    }).catch(error => { if (active) setSaveError((error as Error).message); });
    return () => { active = false; };
  }, [ready, route.page, route.id, route.tab, state.projects]);
  useEffect(() => { const onPop = () => setRoute(parseRoute()); window.addEventListener('popstate', onPop); return () => window.removeEventListener('popstate', onPop); }, []);
  useEffect(() => {
    const onToast = (event: Event) => {
      const message = (event as CustomEvent<string>).detail;
      setToast('');
      window.setTimeout(() => setToast(message), 0);
    };
    window.addEventListener('carlstage:toast', onToast);
    return () => window.removeEventListener('carlstage:toast', onToast);
  }, []);
  useEffect(() => { if (!toast) return; const timer = window.setTimeout(() => setToast(''), 3500); return () => clearTimeout(timer); }, [toast]);

  function go(path: string) { history.pushState({}, '', path); setRoute(parseRoute()); setMobileNav(false); window.scrollTo(0, 0); }
  function updateProject(id: string, change: (project: Project) => Project) {
    const before = stateRef.current.projects.find(project => project.id === id);
    if (!before) return;
    const changed = change(clone(before));
    changed.updatedAt = Math.max(Date.now(), before.updatedAt + 1);
    const meta = (project: Project) => { const { docs, assets, changes, consultations, skillArtifacts, sourceText, generatedSource, loadedParts, revisions, partRevisions, docStats, updatedAt, ...value } = project as Project & { partRevisions?: Record<string, string | null> }; return value; };
    const updates: Record<string, unknown> = {};
    if (JSON.stringify(meta(before)) !== JSON.stringify(meta(changed))) updates.meta = meta(changed);
    for (const key of ['outline', 'script', 'cast', 'art', 'storyboard'] as DocKey[]) if ((changed.loadedParts || []).includes(`doc-${key}`) && JSON.stringify(before.docs[key]) !== JSON.stringify(changed.docs[key])) updates[`doc-${key}`] = changed.docs[key];
    if ((changed.loadedParts || []).includes('assets') && JSON.stringify(before.assets) !== JSON.stringify(changed.assets)) updates.assets = changed.assets;
    if ((changed.loadedParts || []).includes('references') && JSON.stringify(before.referenceImages) !== JSON.stringify(changed.referenceImages)) updates.references = changed.referenceImages;
    // History snapshots are stored individually; mutations below only send new/deleted IDs.
    if ((changed.loadedParts || []).includes('consultations') && JSON.stringify(before.consultations) !== JSON.stringify(changed.consultations)) updates.consultations = changed.consultations;
    if (JSON.stringify(before.skillArtifacts) !== JSON.stringify(changed.skillArtifacts)) updates.artifacts = changed.skillArtifacts || {};
    if (before.sourceText !== changed.sourceText || before.generatedSource !== changed.generatedSource) updates.source = { sourceText: changed.sourceText, generatedSource: changed.generatedSource };
    const beforeIds = new Set(before.changes.map(item => item.id));
    const changedIds = new Set(changed.changes.map(item => item.id));
    const addChanges = changed.changes.filter(item => !beforeIds.has(item.id) && item.before);
    const deleteChanges = before.changes.filter(item => !changedIds.has(item.id)).map(item => item.id);
    stateRef.current = { ...stateRef.current, projects: stateRef.current.projects.map(project => project.id === id ? changed : project) };
    setState(current => ({ ...current, projects: current.projects.map(project => project.id === id ? changed : project) }));
    const previous = mutationQueue.current.get(id) || Promise.resolve();
    const saving = previous.catch(() => {}).then(async () => {
      if (!Object.keys(updates).length && !addChanges.length && !deleteChanges.length) return;
      const current = stateRef.current.projects.find(project => project.id === id) || before;
      const expectedRevisions: Record<string, string | null> = Object.fromEntries(Object.keys(updates).map(part => [part, current.partRevisions?.[part] ?? null]));
      if (deleteChanges.length) expectedRevisions.changes = current.partRevisions?.changes ?? current.revisions?.changes ?? null;
      const result = await saveProjectMutation(id, { expectedRevisions, updates, addChanges, deleteChanges });
      if (result.conflict) {
        const refreshParts = [...Object.keys(updates), ...(addChanges.length || deleteChanges.length ? ['changes'] : [])];
        const refresh = await loadProjectParts(id, refreshParts);
        const projects = stateRef.current.projects.map(project => project.id !== id ? project : ({
          ...project, ...refresh, docs: { ...project.docs, ...refresh.docs },
          loadedParts: [...new Set([...(project.loadedParts || []), ...refreshParts])],
          revisions: { ...project.revisions, ...refresh.revisions },
          partRevisions: { ...project.partRevisions, ...refresh.revisions },
        } as Project));
        stateRef.current = { ...stateRef.current, projects };
        setState(current => ({
          ...current,
          projects,
        }));
        setToast('此内容已在另一个窗口修改，已重新载入最新版本。');
      } else {
        const writtenParts = [...Object.keys(updates), ...(addChanges.length || deleteChanges.length ? ['changes'] : [])];
        const projects = stateRef.current.projects.map(project => project.id === id ? { ...project, revisions: { ...project.revisions, ...result.revisions }, partRevisions: { ...project.partRevisions, ...Object.fromEntries(writtenParts.map(part => [part, result.revisions[part]])) } as Record<string, string | null> } as Project : project);
        stateRef.current = { ...stateRef.current, projects };
        setState(current => ({ ...current, projects }));
        setSaveError('');
      }
    }).catch(error => setSaveError(`保存失败：${(error as Error).message}`));
    mutationQueue.current.set(id, saving);
  }
  async function ensureProjectParts(id: string, parts: string[]): Promise<Project> {
    const current = stateRef.current.projects.find(project => project.id === id);
    if (!current) throw new Error('项目不存在。');
    const loaded = new Set(current.loadedParts || []);
    const currentRevisions = current.partRevisions || {};
    const wantedRevisions = current.revisions || {};
    const missing = parts.filter(part => !loaded.has(part) || (currentRevisions[part] ?? null) !== (wantedRevisions[part] ?? null));
    if (!missing.length) return current;
    const result = await loadProjectParts(id, missing);
    const next = { ...current, ...result, docs: { ...current.docs, ...result.docs }, assets: missing.includes('assets') ? result.assets : current.assets, referenceImages: missing.includes('references') ? result.referenceImages : current.referenceImages, changes: missing.includes('changes') ? result.changes : current.changes, consultations: missing.includes('consultations') ? result.consultations : current.consultations, skillArtifacts: missing.includes('artifacts') ? result.skillArtifacts : current.skillArtifacts, loadedParts: [...new Set([...(current.loadedParts || []), ...missing])], partRevisions: { ...current.partRevisions, ...result.revisions }, revisions: { ...current.revisions, ...result.revisions } } as Project;
    stateRef.current = { ...stateRef.current, projects: stateRef.current.projects.map(project => project.id === id ? next : project) };
    setState(state => ({ ...state, projects: state.projects.map(project => project.id === id ? next : project) }));
    return next;
  }
  function create(input: Partial<Project> & Pick<Project, 'kind' | 'name' | 'prompt'>) {
    const project = makeProject(input);
    project.loadedParts = ['doc-outline', 'doc-script', 'doc-cast', 'doc-art', 'doc-storyboard', 'assets', 'references', 'changes', 'source', 'consultations', 'artifacts'];
    stateRef.current = { ...stateRef.current, projects: [project, ...stateRef.current.projects] };
    setState(s => ({ ...s, projects: [project, ...s.projects] }));
    void persistProject(project).then(async () => {
      const fresh = await loadProjectParts(project.id, project.loadedParts || []);
      const projects = stateRef.current.projects.map(item => item.id === project.id ? { ...item, ...fresh, loadedParts: project.loadedParts, partRevisions: fresh.revisions } as Project : item);
      stateRef.current = { ...stateRef.current, projects };
      setState(current => ({ ...current, projects }));
    }).catch(error => setSaveError(`创建项目失败：${(error as Error).message}`));
    setNovelOpen(false);
    go(`/p/${project.id}`);
    setToast('项目已创建 · 点击各页面的生成按钮调用 Codex');
  }
  function saveDoc<T extends DocKey>(project: Project, key: T, value: Project['docs'][T], label = '编辑内容', mediaAsset?: Asset) {
    if (!mediaAsset && JSON.stringify(project.docs[key]) === JSON.stringify(value)) { setToast('内容没有变化，未新增变更记录'); return; }
    updateProject(project.id, p => {
      if (JSON.stringify(p.docs[key]) !== JSON.stringify(value)) p.changes.unshift({ id: uid(), at: Date.now(), section: key, label, before: clone(p.docs[key]), after: clone(value), beforeArtifact: p.skillArtifacts?.[key] ? clone(p.skillArtifacts[key]) : undefined, beforeGeneratedSource: key === 'outline' ? p.generatedSource : undefined });
      (p.docs as unknown as Record<DocKey, Project['docs'][DocKey]>)[key] = value;
      if (mediaAsset) p.assets.push(mediaAsset);
      p.updatedAt = Date.now();
      return p;
    });
    setToast(JSON.stringify(project.docs[key]) === JSON.stringify(value) ? '已保存媒体，没有新增内容变更' : '已保存，并记录在「变更」中');
  }
  async function addToLibrary(asset: Asset, projectId: string) {
    try {
      const image = asset.image?.startsWith('/api/media/') ? (await copyMediaToLibrary(asset.image)).url : asset.image;
      const copy = { ...clone(asset), image, mediaKind: image ? 'image' as const : asset.mediaKind, id: uid(), sourceProjectId: projectId, sourceItemId: asset.id };
      const library = [copy, ...stateRef.current.library];
      setState(s => ({ ...s, library }));
      await saveStoreIndex({ library });
      setToast('已加入全局资产库');
    } catch (e) { setToast(`加入资产库失败：${(e as Error).message}`); }
  }
  function importAsset(asset: Asset, projectId: string) {
    void (async () => {
      const existing = stateRef.current.projects.find(project => project.id === projectId);
      if (!existing) return;
      await ensureProjectParts(projectId, ['assets']);
      updateProject(projectId, p => { p.assets.push({ ...clone(asset), id: uid() }); return p; });
    })().catch(error => setSaveError(`导入资产失败：${(error as Error).message}`));
    setToast('已复制到项目资产库');
  }
  function registerMedia(projectId: string, asset: Asset) {
    updateProject(projectId, p => { p.assets.push(asset); return p; });
  }
  function deleteChange(projectId: string, changeId: string) {
    updateProject(projectId, project => { project.changes = project.changes.filter(change => change.id !== changeId); return project; });
    void saveStoreIndex({ deletedChangeIds: [changeId] }).catch(error => setSaveError((error as Error).message));
    setToast('变更记录已删除');
  }
  function saveConsultation(projectId: string, item: Consultation) {
    updateProject(projectId, project => { project.consultations = [item, ...(project.consultations || [])]; return project; });
  }
  function deleteConsultation(projectId: string, itemId: string) {
    updateProject(projectId, project => { project.consultations = (project.consultations || []).filter(item => item.id !== itemId); return project; });
    void saveStoreIndex({ deletedConsultationIds: [itemId] }).catch(error => setSaveError((error as Error).message));
    setToast('顾问记录已删除');
  }
  function deleteProject(id: string) {
    setState(s => ({ ...s, projects: s.projects.filter(p => p.id !== id), deletedProjectIds: [...new Set([...(s.deletedProjectIds || []), id])] }));
    void saveStoreIndex({ deletedProjectIds: [id] }).catch(error => setSaveError((error as Error).message));
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
      const deletedAssetIds = [...new Set([...(stateRef.current.deletedAssetIds || []), asset.id, ...(media && scope === 'project' ? [`legacy-${projectId}-${imageKey(media).replace(/:/g, '-')}`] : [])])];
      const deletedImages = deleteImage ? [...new Set([...(stateRef.current.deletedImages || []), imageKey(media!)])] : stateRef.current.deletedImages;
      const library = scope === 'global' ? stateRef.current.library.filter(item => item.id !== asset.id) : stateRef.current.library;
      setState(current => ({ ...current, deletedAssetIds, deletedImages, library }));
      await saveStoreIndex({ deletedAssetIds, deletedImages, library });
      if (scope === 'project' && projectId) {
        await ensureProjectParts(projectId, ['assets']);
        updateProject(projectId, project => { project.assets = project.assets.filter(item => item.id !== asset.id); return project; });
      }
      setConfirmAsset(null); setToast('资产已删除');
    } catch (e) { setToast(`删除失败：${(e as Error).message}`); }
  }
  async function deleteReference() {
    if (!confirmReference) return;
    const { source, index, projectId } = confirmReference;
    try {
      const owned = ownedMediaUrl(source, projectId);
      if (owned) await deleteMedia(source);
      const deletedImages = owned ? [...new Set([...(stateRef.current.deletedImages || []), imageKey(source)])] : stateRef.current.deletedImages;
      const deletedReferenceKeys = [...new Set([...(stateRef.current.deletedReferenceKeys || []), `${projectId}:${imageKey(source)}`])];
      setState(s => ({ ...s, deletedImages, deletedReferenceKeys }));
      await saveStoreIndex({ deletedImages, deletedReferenceKeys });
      updateProject(projectId, project => { project.referenceImages = project.referenceImages.filter((_, i) => i !== index); return project; });
      setConfirmReference(null); setToast('参考图已删除');
    } catch (e) { setToast(`删除失败：${(e as Error).message}`); }
  }

  const project = route.page === 'project' ? state.projects.find(p => p.id === route.id) : undefined;
  const projectParts = route.page === 'project' ? DOC_PARTS[route.tab || 'overview'] || [] : [];
  const projectReady = !!project && projectParts.every(part => (project.loadedParts || []).includes(part) && (project.partRevisions?.[part] ?? null) === (project.revisions?.[part] ?? null));
  if (!ready) return <div className="loading">CarlStage <span>正在打开本地工作台…</span></div>;
  return <DeletedImages.Provider value={state.deletedImages || []}><Notify.Provider value={setToast}><LibraryContext.Provider value={state.library}><RegisterMedia.Provider value={registerMedia}><CurrentProject.Provider value={project}><OpenImage.Provider value={showImage}><OpenVideo.Provider value={showVideo}><DeleteChange.Provider value={deleteChange}><SaveConsultation.Provider value={saveConsultation}><DeleteConsultation.Provider value={deleteConsultation}>
    {saveError && <div className="save-error">{saveError}</div>}
    {route.page === 'dashboard' ? <Dashboard projects={state.projects} go={go} create={create} openNovel={() => setNovelOpen(true)} onDelete={setConfirmDelete}/> :
      <div className={`app-shell ${project ? 'project-shell' : ''}`}>
        <Header go={go} project={project} page={route.page} onMenu={() => setMobileNav(v => !v)} rename={() => project && setRenameProject({ id: project.id, name: project.name })}/>
        {project && <ProjectNav project={project} tab={route.tab || 'overview'} go={go} mobileNav={mobileNav}/>}
        <main className={`main-page ${project ? 'project-main' : ''}`}>
          {route.page === 'library' && <GlobalLibrary state={state} importAsset={importAsset} deleteAsset={asset => setConfirmAsset({ asset, scope: 'global' })} renameAsset={(asset, name) => { const library = stateRef.current.library.map(item => item.id === asset.id ? { ...item, name } : item); setState(s => ({ ...s, library })); void saveStoreIndex({ library }).catch(error => setSaveError((error as Error).message)); setToast('图片名称已更新'); }} addUpload={asset => { const library = [asset, ...stateRef.current.library]; setState(s => ({ ...s, library })); void saveStoreIndex({ library }).catch(error => setSaveError((error as Error).message)); }} go={go}/>}
          {route.page === 'templates' && <div className="empty-page"><div className="eyebrow">CREATIVE TEMPLATES</div><h1>创意模板</h1><p>模板内容正在整理，暂未开放。</p><button className="btn" onClick={() => go('/dashboard')}>返回工作台</button></div>}
          {route.page === 'settings' && <SettingsPage/>}
          {route.page === 'project' && (project ? projectReady ? <ProjectPage project={project} tab={route.tab || 'overview'} detail={route.detail || []} go={go} saveDoc={saveDoc} updateProject={updateProject} ensureProjectParts={ensureProjectParts} addToLibrary={addToLibrary} importAsset={importAsset} deleteAsset={asset => setConfirmAsset({ asset, scope: 'project', projectId: project.id })} deleteReference={(source, index) => setConfirmReference({ source, index, projectId: project.id })} globalAssets={state.library} notify={setToast}/> : <div className="loading">CarlStage <span>正在读取项目内容…</span></div> : <div className="empty-page"><h1>找不到这个项目</h1><button className="btn" onClick={() => go('/dashboard')}>返回工作台</button></div>)}
        </main>
      </div>}
    {novelOpen && <NovelModal onClose={() => setNovelOpen(false)} onCreate={create}/>}
    {confirmDelete && <Modal title="删除项目" onClose={() => setConfirmDelete(null)}><p>确定删除「{state.projects.find(p => p.id === confirmDelete)?.name}」及其所有内容？此操作不可撤销。</p><div className="modal-actions"><button className="btn" onClick={() => setConfirmDelete(null)}>取消</button><button className="btn danger" onClick={() => deleteProject(confirmDelete)}>删除项目</button></div></Modal>}
    {confirmAsset && <Modal title="删除资产" onClose={() => setConfirmAsset(null)}><p>确定删除「{confirmAsset.asset.name}」？{confirmAsset.scope === 'global' ? '仍引用其图片或视频的位置会显示“已被删除”。' : '仅删除项目副本；若媒体属于本项目，引用它的位置将显示“已被删除”。'}</p><div className="modal-actions"><button className="btn" onClick={() => setConfirmAsset(null)}>取消</button><button className="btn danger" onClick={() => void deleteAsset()}>删除资产</button></div></Modal>}
    {confirmReference && <Modal title="删除创作参考图" onClose={() => setConfirmReference(null)}><p>确定从此项目移除这张创作参考图？全局资产库中的原件不会删除。</p><div className="modal-actions"><button className="btn" onClick={() => setConfirmReference(null)}>取消</button><button className="btn danger" onClick={() => void deleteReference()}>移除参考图</button></div></Modal>}
    {renameProject && <Modal title="修改项目名称" onClose={() => setRenameProject(null)}><label className="full-label">项目名称<input autoFocus maxLength={80} value={renameProject.name} onChange={e => setRenameProject(v => v ? { ...v, name: e.target.value } : v)} onKeyDown={e => { if (e.key === 'Enter' && renameProject.name.trim()) { updateProject(renameProject.id, p => { p.name = renameProject.name.trim(); return p; }); setRenameProject(null); setToast('项目名称已更新'); } }}/></label><div className="modal-actions"><button className="btn" onClick={() => setRenameProject(null)}>取消</button><button className="btn primary" disabled={!renameProject.name.trim()} onClick={() => { updateProject(renameProject.id, p => { p.name = renameProject.name.trim(); return p; }); setRenameProject(null); setToast('项目名称已更新'); }}>保存名称</button></div></Modal>}
    {toast && <div className="toast">{toast}</div>}
    {zoomImage && <div className="image-lightbox" role="dialog" aria-modal="true" aria-label="放大图片" onMouseDown={e => { if (e.target === e.currentTarget) setZoomImage(null); }}><div className="image-lightbox-toolbar"><span>{zoomDimensions ? `${zoomDimensions.width} × ${zoomDimensions.height} px` : '读取图片尺寸…'}</span><div className="segmented"><button className={zoomMode === 'fit' ? 'selected' : ''} onClick={() => setZoomMode('fit')}>自适应</button><button className={zoomMode === 'actual' ? 'selected' : ''} onClick={() => setZoomMode('actual')}>1:1 显示</button></div></div><button className="image-lightbox-close" onClick={() => setZoomImage(null)} aria-label="关闭放大图片">×</button><div ref={zoomViewport} className={`image-lightbox-viewport image-lightbox-${zoomMode}`} onMouseDown={e => { if (e.target === e.currentTarget) setZoomImage(null); }}><img ref={zoomedImage} src={zoomImage} alt="放大图片" onLoad={event => setZoomDimensions({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}/></div><MediaDownload src={zoomImage} kind="image"/></div>}
    {zoomVideo && <div className="image-lightbox video-lightbox" role="dialog" aria-modal="true" aria-label="播放视频" onMouseDown={e => { if (e.target === e.currentTarget) setZoomVideo(null); }}><div className="image-lightbox-toolbar"><span>{zoomVideoDimensions ? `${zoomVideoDimensions.width} × ${zoomVideoDimensions.height} px` : '读取视频尺寸…'}</span><div className="segmented"><button className={zoomMode === 'fit' ? 'selected' : ''} onClick={() => setZoomMode('fit')}>自适应</button><button className={zoomMode === 'actual' ? 'selected' : ''} onClick={() => setZoomMode('actual')}>1:1 显示</button></div></div><button className="image-lightbox-close" onClick={() => setZoomVideo(null)} aria-label="关闭视频">×</button><div ref={zoomVideoViewport} className={`image-lightbox-viewport video-lightbox-viewport image-lightbox-${zoomMode}`}><video ref={zoomedVideo} src={zoomVideo} controls autoPlay playsInline onLoadedMetadata={event => setZoomVideoDimensions({ width: event.currentTarget.videoWidth, height: event.currentTarget.videoHeight })}/></div><MediaDownload src={zoomVideo} kind="video"/></div>}
  </DeleteConsultation.Provider></SaveConsultation.Provider></DeleteChange.Provider></OpenVideo.Provider></OpenImage.Provider></CurrentProject.Provider></RegisterMedia.Provider></LibraryContext.Provider></Notify.Provider></DeletedImages.Provider>;
}

function Header({ go, project, page, onMenu, rename }: { go: (path: string) => void; project?: Project; page: Route['page']; onMenu: () => void; rename: () => void }) {
  return <header className="topbar"><button className="mobile-menu" onClick={onMenu}>☰</button><button className="brand-mini" onClick={() => go('/dashboard')}>CS</button><button className="crumb" onClick={() => go('/dashboard')}>工作台</button><span className="crumb-sep">›</span><span className="crumb-current" title={project?.name}>{project?.name || (page === 'settings' ? '设置' : page === 'templates' ? '创意模板' : '资产库')}</span>{project && <button className="rename-trigger" onClick={rename} title="修改项目名称" aria-label="修改项目名称"><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L8 18l-4 1 1-4Z"/></svg></button>}<div className="top-spacer"/>{project && <button className="settings-trigger" onClick={() => go('/asset-library')}>▧ 资产库</button>}<button className="settings-trigger" onClick={() => go('/settings')}>⚙ 设置</button></header>;
}

function Dashboard({ projects, go, create, openNovel, onDelete }: { projects: Project[]; go: (path: string) => void; create: (input: Partial<Project> & Pick<Project, 'kind' | 'name' | 'prompt'>) => void; openNovel: () => void; onDelete: (id: string) => void }) {
  const [showCreativeTemplates, setShowCreativeTemplates] = useState<boolean | null>(null);
  const [prompt, setPrompt] = useState('');
  const [ratio, setRatio] = useState<ImageRatio>('16:9');
  const [needCast, setNeedCast] = useState(true);
  const [needArt, setNeedArt] = useState(true);
  const [images, setImages] = useState<string[]>([]);
  const [chooseImage, setChooseImage] = useState(false);
  useEffect(() => { let mounted = true; getSettings().then(settings => { if (mounted) setShowCreativeTemplates(typeof settings.showCreativeTemplates === 'boolean' ? settings.showCreativeTemplates : true); }).catch(() => { if (mounted) setShowCreativeTemplates(true); }); return () => { mounted = false; }; }, []);
  function submit() { if (!prompt.trim()) return; const name = prompt.trim().split(/[。！？\n]/)[0].slice(0, 28) || '未命名创意'; create({ kind: 'idea', name, prompt: prompt.trim(), ratio, needCast, needArt, referenceImages: images }); }
  return <div className="dashboard">
    <aside className="dash-sidebar"><div className="brand"><span className="logo">CS</span><div><strong>CarlStage</strong><small>AI 影视创作工作台</small></div></div>
      <nav className="dash-nav"><button className="active" onClick={() => go('/dashboard')}>⌂ <span>首页</span></button><button onClick={() => go('/asset-library')}>◇ <span>资产库</span></button>{showCreativeTemplates && <button onClick={() => go('/creative-templates')}>▦ <span>创意模板</span><em>待更新</em></button>}</nav>
      <div className="recent-title">最近项目</div><div className="recent-list">{projects.length ? projects.map(p => <div className="recent-item" key={p.id}><button className="recent-link" onClick={() => go(`/p/${p.id}`)}><span className="recent-icon">{p.kind === 'novel' ? '文' : '创'}</span><span className="recent-copy"><strong>{p.name}</strong><small>{p.kind === 'novel' ? p.genre || '小说项目' : `${p.docStats?.scriptScenes || 0} 场剧本`} · {new Date(p.updatedAt).toLocaleDateString('zh-CN')}</small></span></button><button className="recent-delete delete-icon-button" title="删除项目" onClick={() => onDelete(p.id)}><DeleteIcon/></button></div>) : <p className="sidebar-empty">还没有项目，从一个创意开始吧。</p>}</div>
      <button className="sidebar-create" onClick={openNovel}>＋ 小说项目</button>
    </aside>
    <main className="dash-main"><div className="dash-top"><span>✦ 独立创作，从灵感到分镜</span><div className="dash-top-actions"><span className="demo-pill">本机 Codex 版</span><button className="settings-trigger" onClick={() => go('/settings')}>⚙ 设置</button></div></div><div className="hero-wrap">
      <div className="hero-art"><div className="hero-frame frame-left"><span>SCENE 01</span></div><div className="hero-frame frame-center"><div className="reel-disc"/><span>YOUR STORY</span></div><div className="hero-frame frame-right"><span>TAKE 02</span></div></div>
      <div className="hero-eyebrow">✦ CarlStage · AI 影视创作工作台</div><h1>把脑海里的画面，<br/>交给 CarlStage 拍出来</h1><p className="hero-subtitle">输入一个镜头、一段故事或完整创意。我们会先确认创作方案，再按项目需要生成剧本、角色、美术和分镜。</p>
      <div className="composer"><textarea placeholder="输入你的镜头、画面或故事；可从资产库选择参考图" value={prompt} onChange={e => setPrompt(e.target.value)} onKeyDown={e => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') submit(); }}/><div className="composer-bottom"><button className="reference-button" onClick={() => setChooseImage(true)}>＋ <span>参考内容<small>从全局资产库选择</small></span></button><span className="composer-note">创意项目<small>支持单条或多条</small></span><select aria-label="画面比例" value={ratio} onChange={e => setRatio(e.target.value as ImageRatio)}>{IMAGE_RATIOS.map(value => <option key={value} value={value}>{value}</option>)}</select><label className="check-pill"><input type="checkbox" checked={needCast} onChange={e => setNeedCast(e.target.checked)}/> 需要角色</label><label className="check-pill"><input type="checkbox" checked={needArt} onChange={e => setNeedArt(e.target.checked)}/> 需要美术</label><button className="send-button" disabled={!prompt.trim()} onClick={submit}>↑</button></div>{images.length > 0 && <div className="image-previews">{images.map((src, i) => <div key={i}><MediaPicture src={src}/><button onClick={() => setImages(v => v.filter((_, j) => j !== i))}>×</button></div>)}</div>}</div>
      {chooseImage && <ImageChooser onSelect={url => setImages(v => v.includes(url) ? v : [...v, url])} onClose={() => setChooseImage(false)}/>}
      <p className="key-hint">⌘ / Ctrl + Enter 创建项目 · 内容生成使用本机 Codex，出图与视频使用本机 ComfyUI</p>
      <div className={`creation-choices${showCreativeTemplates ? '' : ' single-choice'}`}><button onClick={openNovel}><span className="choice-icon">文</span><span><strong>创建小说短剧</strong><small>上传小说，基于原文创建短剧项目</small></span><b>选择小说 →</b></button>{showCreativeTemplates && <button className="disabled-choice" disabled><span className="choice-icon">模</span><span><strong>选择创意模板 <i>待更新</i></strong><small>模板内容正在整理，暂未开放</small></span><b>敬请期待</b></button>}</div>
    </div></main>
  </div>;
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) { return <div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}><div className="modal" role="dialog" aria-modal="true" aria-label={title}><div className="modal-head"><div><span className="eyebrow">NEW PROJECT · SKILL INITIALIZATION</span><h2>{title}</h2></div><button className="icon-button" onClick={onClose}>×</button></div>{children}</div></div>; }

function NovelModal({ onClose, onCreate }: { onClose: () => void; onCreate: (input: Partial<Project> & Pick<Project, 'kind' | 'name' | 'prompt'>) => void }) {
  const [file, setFile] = useState<File | null>(null); const [name, setName] = useState(''); const [genre, setGenre] = useState(''); const [count, setCount] = useState(6); const [min, setMin] = useState(2); const [max, setMax] = useState(5); const [adaptation, setAdaptation] = useState('抽核'); const [ratio, setRatio] = useState<ImageRatio>('16:9'); const [style, setStyle] = useState('半写实'); const [keep, setKeep] = useState(''); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
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
    <div className="form-section"><span>改编幅度</span><div className="segmented">{['忠实', '抽核', '借壳'].map(v => <button key={v} className={adaptation === v ? 'selected' : ''} onClick={() => setAdaptation(v)}>{v}</button>)}</div></div><div className="form-section"><span>画面比例</span><select value={ratio} onChange={e => setRatio(e.target.value as ImageRatio)}>{IMAGE_RATIOS.map(value => <option key={value} value={value}>{value}</option>)}</select></div><div className="form-section"><span>角色 / 美术画风</span><div className="segmented">{['半写实', '手绘动画'].map(v => <button key={v} className={style === v ? 'selected' : ''} onClick={() => setStyle(v)}>{v}</button>)}</div></div><label className="full-label">必须保留的角色或场戏 · 可选<textarea value={keep} onChange={e => setKeep(e.target.value)} placeholder="逗号或换行分隔"/></label>{error && <p className="field-error">{error}</p>}<div className="modal-actions"><button className="btn" onClick={onClose}>取消</button><button className="btn primary" disabled={busy} onClick={submit}>{busy ? '读取文件中…' : '创建项目'}</button></div>
  </Modal>;
}

function ProjectNav({ project, tab, go, mobileNav }: { project: Project; tab: string; go: (path: string) => void; mobileNav: boolean }) {
  const main = [['cast', '角色', '♙'], ['art', '美术', '▧'], ['script', '剧本', '▤'], ['storyboard', '分镜', '▥'], ['overview', '概览', '▦'], ['outline', '大纲', '☷'], ['reports', '报告', '▤'], ['library', '素材库', '▧'], ['history', '变更', '◷']];
  return <nav className={`project-nav ${mobileNav ? 'open' : ''}`} aria-label="项目导航">{main.filter(([key]) => key !== 'reports' || project.skillProjectImported).map(([key, label, icon]) => <button key={key} className={`${tab === key ? 'active' : ''} ${key === 'overview' || key === 'reports' || key === 'library' ? 'nav-group-start' : ''} ${key === 'history' ? 'nav-bottom' : ''}`} onClick={() => key === 'reports' ? window.open(`/api/projects/${project.id}/proj/index.html`, '_blank', 'noopener') : go(`/p/${project.id}${key === 'overview' ? '' : `/${key}`}`)} title={label}><span aria-hidden="true">{icon}</span><small>{label}</small></button>)}</nav>;
}

function ProjectPage({ project, tab, detail, go, saveDoc, updateProject, ensureProjectParts, addToLibrary, importAsset, deleteAsset, deleteReference, globalAssets, notify }: { project: Project; tab: string; detail: string[]; go: (path: string) => void; saveDoc: <T extends DocKey>(project: Project, key: T, value: Project['docs'][T], label?: string) => void; updateProject: (id: string, change: (project: Project) => Project) => void; ensureProjectParts: (id: string, parts: string[]) => Promise<Project>; addToLibrary: (asset: Asset, projectId: string) => void; importAsset: (asset: Asset, projectId: string) => void; deleteAsset: (asset: Asset) => void; deleteReference: (source: string, index: number) => void; globalAssets: Asset[]; notify: (message: string) => void }) {
  const openImage = useContext(OpenImage);
  const openVideo = useContext(OpenVideo);
  const storageKey = `reelbench-job-${project.id}`;
  const [job, setJob] = useState<Job | null>(null);
  const [batchBusy, setBatchBusy] = useState(false);
  const [batchProgress, setBatchProgress] = useState('');
  const [jobError, setJobError] = useState('');
  useEffect(() => { setJob(null); const id = sessionStorage.getItem(storageKey); if (id) getJob(id).then(setJob).catch(() => sessionStorage.removeItem(storageKey)); }, [storageKey]);
  useEffect(() => { if (!job || batchBusy || !['queued', 'running'].includes(job.status)) return; const timer = window.setInterval(() => getJob(job.id).then(setJob), 1600); return () => clearInterval(timer); }, [job?.id, job?.status, batchBusy]);
  async function regenerateAll() {
    if (batchBusy || job) return;
    const sections: DocKey[] = ['outline', 'cast', 'script', 'art', 'storyboard'];
    let currentProject = clone(await ensureProjectParts(project.id, ['doc-outline', 'doc-cast', 'doc-script', 'doc-art', 'doc-storyboard', 'artifacts', 'assets', 'changes', 'source']));
    setBatchBusy(true); setJobError('');
    try {
      for (const [index, section] of sections.entries()) {
        setBatchProgress(`正在生成第 ${index + 1}/${sections.length} 步：${sectionLabel(section)}`);
        let current = await createJob(currentProject, section);
        setJob(current); sessionStorage.setItem(storageKey, current.id);
        while (true) {
          if (current.status === 'awaiting_confirmation') { current = await continueJob(current.id); setJob(current); continue; }
          if (current.status === 'completed' && current.result) break;
          if (current.status === 'failed' || current.status === 'cancelled') throw new Error(current.error || current.message || `${sectionLabel(section)}生成失败。`);
          await new Promise(resolve => window.setTimeout(resolve, 1400));
          current = await getJob(current.id); setJob(current);
        }
        currentProject = applyGeneratedJob(currentProject, current);
        updateProject(project.id, () => clone(currentProject));
        sessionStorage.removeItem(storageKey); setJob(null);
      }
      setBatchProgress('全部五个阶段已重新生成，旧版本可在「变更」中查看或撤销。');
      notify('大纲、角色、剧本、美术和分镜已全部重新生成。');
    } catch (error) { const message = (error as Error).message; setBatchProgress(`流程已停止：${message}`); setJobError(message); }
    finally { setBatchBusy(false); }
  }
  const key = tab === 'characters' ? 'cast' : (tab as DocKey);
  const pageDetail = tab === 'script' && !detail.length ? ['1'] : detail;
  const hasDetail = pageDetail.length > 0 && ['outline', 'script', 'cast', 'art', 'storyboard'].includes(tab);
  function renderDetailMedia(target: Character | Asset | Shot, kind: 'image' | 'video', compact = false, slot?: 'appearance' | 'turnaround' | 'main' | 'setting' | 'state', referenceImage?: string, stateIndex?: number) {
    const isShot = 'framing' in target;
    const stateId = slot === 'state' && stateIndex !== undefined ? 'type' in target ? (target as ArtAsset).states?.[stateIndex]?.id : !isShot ? target.states?.[stateIndex]?.id : undefined : undefined;
    const historyId = slot === 'turnaround' ? `${target.id}:turnaround` : slot === 'setting' ? `${target.id}:setting` : slot === 'state' ? `${target.id}:state:${stateId || stateIndex || 0}` : target.id;
    const prior = project.assets.filter(asset => asset.sourceItemId === historyId && (kind === 'image' ? !!asset.image : !!asset.video));
    const prompt = isShot ? `${target.scene}，${target.framing}，${target.action}` : 'type' in target ? slot === 'state' ? (target as ArtAsset).states?.[stateIndex ?? -1]?.prompt || '' : (target as ArtAsset).prompt || '' : target.imagePrompt || `${target.name}，${target.role}，${target.description}`;
    const negativePrompt = kind === 'image' && !isShot ? 'type' in target ? (target as ArtAsset).negativePrompt || '' : target.imageNegativePrompt || '' : undefined;
    const accept = (url: string) => {
      if (isShot) saveDoc(project, 'storyboard', { ...project.docs.storyboard, shots: project.docs.storyboard.shots.map(shot => shot.id === target.id ? { ...shot, [kind === 'image' ? 'image' : 'video']: url } : shot) }, `保存分镜${kind === 'image' ? '图' : '视频'}`);
      else if ('type' in target) {
        const next = clone(project.docs.art);
        const updateAsset = (asset: ArtAsset) => {
          if (asset.id !== target.id) return asset;
          if (slot === 'state' && stateIndex !== undefined) {
            const states = [...(asset.states || [])];
            states[stateIndex] = { ...states[stateIndex], image: url };
            return { ...asset, states };
          }
          const imageField = slot === 'setting' ? 'settingImage' : 'image';
          return { ...asset, [imageField]: url };
        };
        if (target.type === 'scene') next.scenes = next.scenes.map(updateAsset);
        else next.props = next.props.map(updateAsset);
        const label = slot === 'state' ? `保存${target.name}状态图片` : target.type === 'scene' && slot === 'setting' ? '保存场景设定图' : target.type === 'scene' ? '保存场景主视角图' : '保存道具图';
        saveDoc(project, 'art', next, label);
      }
      else saveDoc(project, 'cast', project.docs.cast.map(c => {
        if (c.id !== target.id) return c;
        if (slot === 'state' && stateIndex !== undefined) {
          const states = [...(c.states || [])];
          if (states[stateIndex]) states[stateIndex] = { ...states[stateIndex], image: url };
          return { ...c, states };
        }
        return slot === 'turnaround' ? { ...c, turnaroundImage: url } : { ...c, image: url };
      }), slot === 'state' ? `保存${target.name}状态图片` : slot === 'turnaround' ? '保存角色三视图' : '保存角色形象图');
    };
    const referenceImages = slot === 'state'
      ? 'type' in target ? (target as ArtAsset).states?.[stateIndex ?? -1]?.referenceImages !== undefined ? ((target as ArtAsset).states?.[stateIndex ?? -1]?.referenceImages || []).map(reference => reference.image) : [referenceImage].filter((image): image is string => !!image) : !isShot ? (target as Character).states?.[stateIndex ?? -1]?.referenceImages?.map(reference => reference.image) || [] : []
      : slot === 'setting' && 'type' in target
      ? [referenceImage].filter((image): image is string => !!image)
      : slot === 'turnaround' && !isShot && !('type' in target) && target.turnaroundImage ? [target.turnaroundImage] : undefined;
    if (compact && kind === 'image' && !('framing' in target)) return <CompactDetailImageTools project={project} target={target} prompt={prompt} negativePrompt={negativePrompt} referenceImages={referenceImages} source={slot === 'setting' || slot === 'state' ? undefined : target.image} history={prior.filter(asset => asset.image)} historyId={historyId} viewName={slot === 'state' ? '状态' : slot === 'setting' ? '设定图' : slot === 'main' ? '主视角' : slot === 'turnaround' ? '三视图' : slot === 'appearance' ? '形象' : '道具图'} onAccept={accept} onDeleteHistory={asset => deleteAsset(asset)} openImage={openImage}/>;
    return <div className="detail-media-tools"><MediaGenerator project={project} kind={kind} targetId={target.id} prompt={prompt} negativePrompt={negativePrompt} source={target.image} duration={isShot ? target.duration : undefined} onAccept={accept}/>{prior.length > 0 && <details><summary>{kind === 'image' ? '图片' : '视频'}历史记录 · {prior.length}</summary><div className="detail-media-history">{prior.map(asset => <button key={asset.id} onClick={() => (kind === 'image' ? openImage : openVideo)(kind === 'image' ? asset.image! : asset.video!)}>{asset.image ? <img src={asset.image} alt={asset.name}/> : <span>▶ {asset.name}</span>}</button>)}</div></details>}</div>;
  }
  return <div className={['outline', 'script', 'storyboard'].includes(tab) ? `project-content-with-subnav ${tab}-workspace` : ''}>
    <ProjectSubnav project={project} tab={tab} detail={pageDetail} go={go}/><div className="project-content">
    {jobError && tab === 'overview' && <div className="codex-error">{jobError}</div>}
    {batchProgress && tab === 'overview' && <div className="panel overview-batch-progress" role="status">{batchProgress}</div>}
    {hasDetail && tab === 'storyboard' && pageDetail[1] ? <SegmentProduction project={project} episode={Number(pageDetail[0])} segment={pageDetail[1]} save={(value, label) => saveDoc(project, 'storyboard', value, label)} openImage={openImage} go={go}/> : hasDetail && <ProjectDetail project={project} tab={tab} detail={pageDetail} go={go} save={(section, value, label) => saveDoc(project, section, value, label)} openImage={openImage} media={renderDetailMedia} addToLibrary={asset => addToLibrary(asset, project.id)} renderImagePicker={(value, onChange) => <ImagePicker value={value} onChange={onChange} allowRemove={false}/>} renderReferencePicker={(selected, onSelectionChange, onClose) => <ImageChooser project={project} selected={selected} onSelectionChange={() => {}} onAssetSelectionChange={assets => onSelectionChange(assets.map(asset => asset.image!).filter(Boolean), assets)} onClose={onClose}/>}/>}
    {tab === 'overview' && <><Overview project={project} go={go} onStyleChange={style => updateProject(project.id, current => ({ ...current, style }))} onRegenerateAll={() => void regenerateAll()} regenerateDisabled={batchBusy || !!job} onImportPackage={async files => {
      setJobError('');
      try {
        await ensureProjectParts(project.id, ['doc-outline', 'doc-script', 'doc-cast', 'doc-art', 'doc-storyboard', 'artifacts', 'source', 'changes']);
        const start = await startProjectImport(project.id);
        const normalized = files.map(file => ({ file, path: file.webkitRelativePath.split('/').slice(1).join('/') || file.name }));
        for (let i = 0; i < normalized.length; i += 4) await Promise.all(normalized.slice(i, i + 4).map(({ file, path }) => uploadProjectImportFile(project.id, start.importId, path, file)));
        const imported = await finishProjectImport(project.id, start.importId);
        updateProject(project.id, p => {
          for (const key of Object.keys(imported.docs) as DocKey[]) {
            if (JSON.stringify(p.docs[key]) !== JSON.stringify(imported.docs[key])) p.changes.unshift({ id: uid(), at: Date.now(), section: key, label: '导入 shuohao-skills 项目', before: clone(p.docs[key]), after: clone(imported.docs[key]), beforeArtifact: p.skillArtifacts?.[key] ? clone(p.skillArtifacts[key]) : undefined });
          }
          p.docs = imported.docs; p.skillArtifacts = imported.skillArtifacts; p.skillProjectImported = true;
          const outlineRaw = imported.skillArtifacts?.outline?.raw as { params?: { episodes?: number; minutesPerEpisode?: number; genre?: string; adaptMode?: string; ratio?: string; aspectRatio?: string } } | undefined;
          if (outlineRaw?.params) applyOutlineProjectSettings(p, outlineRaw);
          if (imported.sourceText) { p.sourceText = imported.sourceText; p.sourceName = imported.sourceName; p.prompt = imported.sourceText.slice(0, 300); }
          return p;
        });
        notify('项目目录已导入到当前项目的 proj 文件夹。');
      } catch (error) { setJobError(`导入失败：${(error as Error).message}`); }
    }}/>{project.kind === 'novel' && <ReimportNovel project={project} updateProject={updateProject} ensureProjectParts={ensureProjectParts} notify={notify}/>}</>}
    {!hasDetail && key === 'outline' && <OutlinePage project={project} save={value => saveDoc(project, 'outline', value)} go={go}/>}
    {!hasDetail && key === 'script' && <ScriptPage project={project} save={value => saveDoc(project, 'script', value)} notify={notify}/>}
    {!hasDetail && key === 'cast' && <CastGallery project={project} save={value => saveDoc(project, 'cast', value)} addToLibrary={addToLibrary} go={go}/>}
    {!hasDetail && key === 'art' && <ArtGallery project={project} save={value => saveDoc(project, 'art', value)} addToLibrary={addToLibrary} go={go}/>}
    {!hasDetail && key === 'storyboard' && <><ProjectStoryboardSummary project={project} go={go}/><StoryboardPage project={project} save={value => saveDoc(project, 'storyboard', value)} go={go}/></>}
    {tab === 'history' && <HistoryPage project={project} updateProject={updateProject} notify={notify} loadChange={async id => {
      const summary = project.changes.find(item => item.id === id);
      if (!summary) return null;
      const result = await loadProjectParts(project.id, [`change:${id}`]);
      return result.changeDetails?.[id] || null;
    }} ensureProjectParts={ensureProjectParts}/>}
    {tab === 'library' && <ProjectMaterialTabs project={project} onPrompts={() => ensureProjectParts(project.id, ['doc-cast', 'doc-art', 'doc-storyboard'])} updateProject={updateProject}><ProjectLibrary project={project} globalAssets={globalAssets} importAsset={importAsset} deleteAsset={deleteAsset} deleteReference={deleteReference} updateProject={updateProject} addProjectAsset={asset => updateProject(project.id, p => { p.assets.push(asset); return p; })} notify={notify} go={go}/></ProjectMaterialTabs>}
  </div></div>;
}

function PageHeading({ stage, title, subtitle, actions }: { stage: string; title: string; subtitle?: string; actions?: React.ReactNode }) { return <div className="page-heading"><div><div className="eyebrow">{stage}</div><h1>{title}</h1>{subtitle && <p>{subtitle}</p>}</div><div className="heading-actions">{actions}</div></div>; }
function Field({ label, value, onChange, rows = 3 }: { label: string; value: string; onChange: (value: string) => void; rows?: number }) { return <label className="edit-field"><span>{label}</span><textarea rows={rows} value={value} onChange={e => onChange(e.target.value)}/></label>; }

function applyGeneratedJob(project: Project, job: Job): Project {
  if (!job.result) return project;
  const { section, result } = job;
  if (JSON.stringify(project.docs[section]) !== JSON.stringify(result.mapped)) project.changes.unshift({ id: uid(), at: Date.now(), section, label: `Codex 生成${sectionLabel(section)}`, before: clone(project.docs[section]), after: clone(result.mapped), beforeArtifact: project.skillArtifacts?.[section] ? clone(project.skillArtifacts[section]) : undefined, beforeGeneratedSource: section === 'outline' ? project.generatedSource : undefined });
  (project.docs as unknown as Record<DocKey, Project['docs'][DocKey]>)[section] = clone(result.mapped);
  project.skillArtifacts = { ...project.skillArtifacts, [section]: { raw: result.raw, skillVersion: result.skillVersion, generatedAt: result.generatedAt } };
  if (section === 'outline') applyOutlineProjectSettings(project, result.raw);
  if (section === 'outline' && result.sourceExpansion) project.generatedSource = result.sourceExpansion;
  project.updatedAt = Date.now();
  return project;
}

function applyOutlineProjectSettings(project: Project, raw: unknown) {
  const params = (raw as { params?: { episodes?: number; minutesPerEpisode?: number; genre?: string; adaptMode?: string; ratio?: string; aspectRatio?: string } })?.params;
  if (!params) return;
  if (Number.isInteger(params.episodes) && Number(params.episodes) > 0) project.episodeCount = Number(params.episodes);
  if (Number.isFinite(params.minutesPerEpisode) && Number(params.minutesPerEpisode) > 0) project.minDuration = project.maxDuration = Number(params.minutesPerEpisode);
  if (typeof params.genre === 'string') project.genre = params.genre;
  if (typeof params.adaptMode === 'string') project.adaptation = params.adaptMode;
  const ratios = ['1:1', '9:16', '16:9', '3:4', '4:3', '3:2', '2:3', '4:5', '5:4', '21:9'];
  const ratio = params.ratio || params.aspectRatio;
  if (ratio && ratios.includes(ratio)) project.ratio = ratio as Project['ratio'];
}

function Overview({ project, go, onStyleChange, onRegenerateAll, regenerateDisabled, onImportPackage }: { project: Project; go: (path: string) => void; onStyleChange: (style: string) => void; onRegenerateAll: () => void; regenerateDisabled: boolean; onImportPackage: (files: File[]) => void }) {
  const [confirmRegenerateAll, setConfirmRegenerateAll] = useState(false);
  const packagePicker = useRef<HTMLInputElement>(null);
  const stats = project.docStats || { outlineEpisodes: 0, outlineBeats: 0, cast: 0, scenes: 0, props: 0, scriptScenes: 0, scriptBeats: 0, shots: 0, segments: 0, storyboardEpisodes: 0 };
  const metrics = [
    { key: 'outline', number: '01', label: '大纲', caption: '什么', summary: `${stats.outlineEpisodes} 集 · ${stats.outlineBeats} 个爽点` },
    { key: 'cast', number: '02', label: '角色', caption: '谁', summary: `${stats.cast} 个角色` },
    { key: 'art', number: '03', label: '美术', caption: '在哪 + 拿什么', summary: `${stats.scenes} 个场景 · ${stats.props} 个道具` },
    { key: 'script', number: '04', label: '剧本', caption: '戏', summary: `${stats.scriptScenes} 场 · ${stats.scriptBeats} 节拍` },
    { key: 'storyboard', number: '05', label: '分镜', caption: '怎么拍', summary: `${stats.segments} 段 · ${stats.shots} 个镜头` }
  ];
  const card = (m: typeof metrics[number]) => <button key={m.key} className="flow-stage" onClick={() => go(`/p/${project.id}/${m.key}`)}><span className="flow-stage-top"><small>{m.number}</small><strong>{m.label}</strong><em>{m.caption}</em></span><span className="flow-stage-summary">{m.summary}</span></button>;
  return <><PageHeading stage="工作台 · 项目总览" title={project.name} subtitle="从大纲到分镜，五个阶段的文案与素材都在这里改。每一次改动都记在变更里，随时可以撤回。" actions={<><button className="btn" onClick={() => packagePicker.current?.click()}>{project.skillProjectImported ? '重新导入项目目录' : '导入 shuohao-skills 项目'}</button><input ref={packagePicker} type="file" multiple hidden onChange={event => { const files = Array.from(event.target.files || []); if (files.length) onImportPackage(files); event.target.value = ''; }} {...({ webkitdirectory: '', directory: '' } as Record<string, string>)}/><button className="btn primary" disabled={regenerateDisabled} onClick={() => setConfirmRegenerateAll(true)}>{regenerateDisabled ? '正在逐步生成…' : '一键重新生成全部'}</button></>}/><div className="flow-diagram"><div className="flow-source">{project.kind === 'novel' ? '小说原文' : '创意原文'}<small>{project.sourceName || '素材来源'}</small></div><span className="flow-arrow">→</span>{card(metrics[0])}<span className="flow-arrow">→</span><div className="flow-cluster"><div className="flow-cluster-head">收敛层 · 三者同步迭代，无先后</div>{metrics.slice(1, 4).map(card)}<div className="flow-cluster-foot">人工过一遍 · 不满意就微调，重新生成</div></div><span className="flow-arrow">→</span>{card(metrics[4])}<span className="flow-arrow">→</span><div className="flow-source">批量生成<small>按镜出片</small></div></div><div className="overview-meta"><span>题材：{project.genre || '未设置'}</span><span>改编幅度：{project.adaptation}</span><span>画面比例：{project.ratio}</span><div className="overview-style"><span>统一画风</span><ImageStylePicker value={project.style} onChange={onStyleChange}/></div></div>{confirmRegenerateAll && <Modal title="确认重新生成全部" onClose={() => setConfirmRegenerateAll(false)}><p>将依次重新生成大纲、角色、剧本、美术和分镜。此流程会多次调用创作模型，可能消耗较多用量；已有内容会记录到变更历史。确认继续吗？</p><div className="modal-actions"><button className="btn" onClick={() => setConfirmRegenerateAll(false)}>取消</button><button className="btn primary" onClick={() => { setConfirmRegenerateAll(false); onRegenerateAll(); }}>确认重新生成</button></div></Modal>}</>;
}

function ImageStylePicker({ value, onChange }: { value: string; onChange: (style: string) => void }) {
  const [open, setOpen] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const closeOnOutsideClick = (event: PointerEvent) => { if (!pickerRef.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', closeOnOutsideClick);
    return () => document.removeEventListener('pointerdown', closeOnOutsideClick);
  }, [open]);
  return <div className="image-style-picker" ref={pickerRef} onKeyDown={event => { if (event.key === 'Escape') setOpen(false); }}><button type="button" className="image-style-trigger" aria-label={`画风：${value}`} aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen(current => !current)}><span>{value}</span></button>{open && <div className="image-style-menu" role="listbox" aria-label="画风选项">{!IMAGE_STYLES.includes(value) && <button type="button" role="option" aria-selected="true" className="image-style-option selected" onClick={() => setOpen(false)}><span className="image-style-glyph image-style-glyph-custom" aria-hidden="true"></span><span>{value}</span></button>}{IMAGE_STYLES.map((style, index) => <button type="button" role="option" aria-selected={value === style} className={`image-style-option${value === style ? ' selected' : ''}`} key={style} onClick={() => { onChange(style); setOpen(false); }}><span className={`image-style-glyph image-style-glyph-${index}`} aria-hidden="true"></span><span>{style}</span></button>)}</div>}</div>;
}

function ReimportNovel({ project, updateProject, ensureProjectParts, notify }: { project: Project; updateProject: (id: string, change: (project: Project) => Project) => void; ensureProjectParts: (id: string, parts: string[]) => Promise<Project>; notify: (message: string) => void }) {
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
      await ensureProjectParts(project.id, ['doc-outline', 'doc-script', 'doc-cast', 'doc-art', 'doc-storyboard', 'artifacts', 'source', 'changes']);
      updateProject(project.id, p => {
        const nextDocs = makeDocs(sourceText, p.episodeCount, 'novel');
        const keys: DocKey[] = ['outline', 'script', 'cast', 'art', 'storyboard'];
        for (const section of keys) {
          if (JSON.stringify(p.docs[section]) !== JSON.stringify(nextDocs[section])) p.changes.unshift({ id: uid(), at: Date.now(), section, label: '重新导入小说原文', before: clone(p.docs[section]), after: clone(nextDocs[section]), beforeArtifact: p.skillArtifacts?.[section] ? clone(p.skillArtifacts[section]) : undefined, beforeGeneratedSource: section === 'outline' ? p.generatedSource : undefined });
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

function hydrateOutlineSceneRefs(outline: Outline, raw: unknown, rawCast: unknown): Outline {
  if ((!outline.sceneRefsHydrated && (!raw || typeof raw !== 'object')) || ((!raw || typeof raw !== 'object') && (!rawCast || typeof rawCast !== 'object'))) return outline;
  const source = raw && typeof raw === 'object' ? raw as { episodes?: { ep?: number; sceneIds?: unknown[]; characterIds?: unknown[]; propIds?: unknown[] }[]; scenes?: { id?: string; reusePlan?: string }[]; characters?: { id?: string; name?: string; tier?: string; from?: unknown }[]; props?: { id?: string; name?: string; function?: string; beatIds?: unknown[] }[] } : {};
  const castSource = rawCast && typeof rawCast === 'object' ? rawCast as { characters?: { name?: string; importance?: string; persona?: { arc?: string } }[] } : {};
  const hydrateSceneRefs = !outline.sceneRefsHydrated;
  const hydrateInventoryData = !outline.inventoryDataHydrated;
  const rawEpisodes = source.episodes || [];
  const rawScenes = source.scenes || [];
  return {
    ...outline,
    episodes: hydrateSceneRefs ? outline.episodes.map((episode, index) => {
      const rawEpisode = rawEpisodes.find(item => Number(item.ep) === index + 1) || rawEpisodes[index];
      const sceneIds = episode.sceneIds?.length ? episode.sceneIds : (rawEpisode?.sceneIds || []).filter((id): id is string => typeof id === 'string');
      const characterIds = episode.characterIds?.length ? episode.characterIds : (rawEpisode?.characterIds || []).filter((id): id is string => typeof id === 'string');
      const propIds = episode.propIds?.length ? episode.propIds : (rawEpisode?.propIds || []).filter((id): id is string => typeof id === 'string');
      return { ...episode, sceneIds, characterIds, propIds };
    }) : outline.episodes,
    scenes: hydrateSceneRefs ? outline.scenes?.map(scene => {
      const rawScene = rawScenes.find(item => item.id === scene.id);
      return { ...scene, reusePlan: scene.reusePlan || rawScene?.reusePlan || '' };
    }) : outline.scenes,
    characters: hydrateInventoryData ? outline.characters?.map(character => {
      const rawCharacter = source.characters?.find(item => item.id === character.id || item.name === character.name);
      const castCharacter = castSource.characters?.find(item => item.name === character.name);
      const sourceText = Array.isArray(rawCharacter?.from) ? rawCharacter.from.filter((item): item is string => typeof item === 'string').join('、') : typeof rawCharacter?.from === 'string' ? rawCharacter.from : '';
      const castTier = castCharacter?.importance === 'protagonist' ? 'lead' : castCharacter?.importance === 'minor' ? 'functional' : castCharacter?.importance ? 'support' : undefined;
      return {
        ...character,
        tier: rawCharacter?.tier || castTier || character.tier,
        source: character.source || sourceText,
        arc: character.arc || castCharacter?.persona?.arc || ''
      };
    }) : outline.characters,
    props: hydrateInventoryData && !outline.props?.length && source.props?.length ? source.props.map((item, index) => ({ id: item.id || `P${String(index + 1).padStart(2, '0')}`, name: item.name || '', function: item.function || '', beatIds: (item.beatIds || []).filter((id): id is string => typeof id === 'string') })) : outline.props,
    sceneRefsHydrated: true,
    characterInfoHydrated: true,
    inventoryDataHydrated: true
  };
}

function OutlinePage({ project, save, go }: { project: Project; save: (value: Project['docs']['outline']) => void; go: (path: string) => void }) {
  const [draft, setDraft] = useState(() => hydrateOutlineSceneRefs(clone(project.docs.outline), project.skillArtifacts?.outline?.raw, project.skillArtifacts?.cast?.raw));
  const [beatView, setBeatView] = useState<'timeline' | 'table'>('timeline');
  useEffect(() => setDraft(hydrateOutlineSceneRefs(clone(project.docs.outline), project.skillArtifacts?.outline?.raw, project.skillArtifacts?.cast?.raw)), [project.docs.outline, project.skillArtifacts?.outline?.raw, project.skillArtifacts?.cast?.raw]);
  const characters: NonNullable<Outline['characters']> = draft.characters || project.docs.cast.map((item, index) => ({ id: `C${String(index + 1).padStart(2, '0')}`, name: item.name, role: item.role, tier: 'support', arc: item.arc, source: '' }));
  const scenes: NonNullable<Outline['scenes']> = draft.scenes || project.docs.art.scenes.map((item, index) => ({ id: `S${String(index + 1).padStart(2, '0')}`, name: item.name, primary: !!item.primary, reusePlan: '' }));
  const props = draft.props || [];
  const beats = draft.beats || [];
  const cutDetails: NonNullable<Outline['cutDetails']> = draft.cutDetails || draft.cut.map(what => ({ what, why: '', evidence: '' }));
  const mergeDetails: NonNullable<Outline['mergeDetails']> = draft.mergeDetails || draft.merge.map(what => ({ what, why: '' }));
  const leads = characters.filter(item => item.tier === 'lead');
  const supporting = characters.filter(item => item.tier === 'support');
  const functional = characters.filter(item => item.tier === 'functional');
  const primaryScenes = scenes.filter(item => item.primary);
  const totalMinutes = (project.episodeCount * (project.minDuration + project.maxDuration) / 2).toFixed(0);
  const warningEpisodes = new Map<string, number[]>();
  draft.episodes.forEach((episode, index) => (episode.warnings || []).forEach(warning => warningEpisodes.set(warning, [...(warningEpisodes.get(warning) || []), index + 1])));
  const warningSummary = [...warningEpisodes].map(([warning, episodes]) => `${warning} ×${episodes.length}（第 ${[...new Set(episodes)].join('、')} 集）`).join('\n');
  const warningCount = draft.episodes.reduce((sum, episode) => sum + (episode.warnings?.length || 0), 0);
  const majorBeats = beats.filter(item => item.weight === 'major');
  const sceneAppearances = (sceneId: string) => draft.episodes.flatMap((episode, index) => episode.sceneIds?.includes(sceneId) ? [index + 1] : []);
  const changeCharacter = (index: number, key: 'id' | 'name' | 'role' | 'tier' | 'arc' | 'source', value: string) => setDraft(d => ({ ...d, characters: (d.characters || characters).map((item, i) => i === index ? { ...item, [key]: value } : item) }));
  const changeScene = (index: number, key: 'id' | 'name' | 'reusePlan' | 'primary', value: string | boolean) => setDraft(d => ({ ...d, scenes: (d.scenes || scenes).map((item, i) => i === index ? { ...item, [key]: value } : item) }));
  const changeProp = (index: number, key: 'id' | 'name' | 'function', value: string) => setDraft(d => ({ ...d, props: (d.props || props).map((item, i) => i === index ? { ...item, [key]: value } : item) }));
  const changeBeat = (index: number, key: 'id' | 'type' | 'weight' | 'episode' | 'setup' | 'payoff', value: string | number) => setDraft(d => ({ ...d, beats: (d.beats || beats).map((item, i) => i === index ? { ...item, [key]: value } : item) }));
  const changeEpisode = (index: number, key: 'title' | 'summary' | 'hook' | 'suspense' | 'crowdPlan', value: string) => setDraft(d => ({ ...d, episodes: d.episodes.map((item, i) => i === index ? { ...item, [key]: value } : item) }));
  const resourceRows = [
    ...characters.map(item => ({ kind: 'character' as const, id: item.id, name: item.name, tier: item.tier === 'lead' ? '主角组' : item.tier === 'functional' ? '功能性角色' : '重要配角', episodes: draft.episodes.flatMap((episode, index) => episode.characterIds?.includes(item.id) ? [index + 1] : []) })),
    ...scenes.map(item => ({ kind: 'scene' as const, id: item.id, name: item.name, tier: item.primary ? '主场景' : '一次性场景', episodes: sceneAppearances(item.id) })),
    ...props.map(item => ({ kind: 'prop' as const, id: item.id, name: item.name, tier: item.beatIds.map(id => beats.find(beat => beat.id === id)?.type).filter(Boolean).join('、') || '叙事道具', episodes: draft.episodes.flatMap((episode, index) => episode.propIds?.includes(item.id) ? [index + 1] : []) }))
  ];
  return <div className="outline-report-page">
    <PageHeading stage="STAGE 01 · OUTLINE" title={project.name} subtitle="改编报告 · 大纲总表" actions={<button className="btn primary" onClick={() => save(draft)}>保存大纲</button>}/>
    <div className="outline-report-meta"><span>{project.genre || '未设置题材'}</span><span>{project.episodeCount} 集 × {project.minDuration === project.maxDuration ? project.minDuration : `${project.minDuration}–${project.maxDuration}`} 分钟</span><span>{project.adaptation || '未设置改编模式'}</span></div>
    <div className="outline-report-kpis"><div><small>总集数</small><strong>{project.episodeCount}<em>集</em></strong><span>正片约 {totalMinutes} 分钟</span></div><div><small>爽点</small><strong>{beats.length}</strong><span>{majorBeats.length} 个大爆点</span></div><div><small>角色</small><strong>{characters.length}</strong><span>主角 {leads.length} · 配角 {supporting.length} · 功能 {functional.length}</span></div><div><small>主场景</small><strong>{primaryScenes.length}</strong><span>共 {scenes.length} 个场景</span></div><div><small>生成难点</small><strong>{warningCount}</strong><span className="outline-report-difficulties" title={warningSummary || '暂无生成难点'}>{warningSummary || '暂无生成难点'}</span></div><div><small>改编幅度</small><strong className="outline-report-mode">{project.adaptation || '未指定'}</strong><span>{draft.cut.length} 条删减 · {draft.merge.length} 组整合</span></div></div>
    {project.generatedSource && <details className="panel outline-source"><summary>查看创意扩写素材</summary><pre className="codex-preview">{project.generatedSource}</pre></details>}
    <section className="outline-report-section"><div className="outline-report-section-title"><span>01</span><h2>爽点节奏</h2><small>铺垫与兑现</small></div><div className="outline-beat-tabs" role="tablist" aria-label="爽点展示方式"><button role="tab" aria-selected={beatView === 'timeline'} className={beatView === 'timeline' ? 'active' : ''} onClick={() => setBeatView('timeline')}>时间轴</button><button role="tab" aria-selected={beatView === 'table'} className={beatView === 'table' ? 'active' : ''} onClick={() => setBeatView('table')}>明细表</button></div>{beatView === 'timeline' ? <div className="panel outline-beat-timeline"><div className="outline-beat-legend"><span><i className="major"/>大爆点</span><span><i/>常规爽点</span></div><div className="outline-beat-axis" style={{ gridTemplateColumns: `repeat(${Math.max(1, draft.episodes.length)}, minmax(0, 1fr))` }}>{draft.episodes.map((_, episodeIndex) => { const episodeBeats = beats.map((beat, beatIndex) => ({ beat, beatIndex })).filter(({ beat }) => beat.episode === episodeIndex + 1); return <div className="outline-beat-episode" key={episodeIndex}><div className="outline-beat-events">{episodeBeats.map(({ beat, beatIndex }, eventIndex) => <div className={`outline-beat-event ${beat.weight === 'major' ? 'major' : ''} ${(episodeIndex + eventIndex) % 2 ? 'below' : 'above'}`} key={`${beat.id}-${beatIndex}`} title="双击文字编辑"><GalleryText className="outline-inline-edit" value={beat.setup} onChange={value => changeBeat(beatIndex, 'setup', value)}/><GalleryText className="outline-inline-edit" value={beat.type} onChange={value => changeBeat(beatIndex, 'type', value)}/><i/></div>)}</div><small className={(episodeIndex % 2) ? 'above' : 'below'}>{episodeIndex + 1}</small></div>; })}</div></div> : <div id="outline-beats-table" className="panel outline-report-table"><table className="detail-table"><thead><tr><th>ID</th><th>类型</th><th>等级</th><th>集</th><th>铺垫</th><th>兑现</th></tr></thead><tbody>{beats.map((beat, index) => <tr key={`${beat.id}-${index}`}><td><GalleryText className="outline-inline-edit" value={beat.id} onChange={value => changeBeat(index, 'id', value)}/></td><td><GalleryText className="outline-inline-edit" value={beat.type} onChange={value => changeBeat(index, 'type', value)}/></td><td><GalleryChoice className="outline-inline-edit" value={beat.weight || 'minor'} options={[{ value: 'minor', label: '常规' }, { value: 'major', label: '大爆点' }]} onChange={value => changeBeat(index, 'weight', value)}/></td><td><GalleryText className="outline-inline-edit" value={String(beat.episode)} onChange={value => changeBeat(index, 'episode', Number(value) || 1)}/></td><td><GalleryText className="outline-inline-edit multiline" value={beat.setup} onChange={value => changeBeat(index, 'setup', value)}/></td><td><GalleryText className="outline-inline-edit multiline" value={beat.payoff} onChange={value => changeBeat(index, 'payoff', value)}/></td></tr>)}</tbody></table>{!beats.length && <p className="outline-table-empty">暂无爽点数据</p>}</div>}</section>
    <section className="outline-report-section"><OutlineSectionTitle n="02" title="分集概览" note="梗概 · 钩子 · 悬念"/><div className="outline-report-episodes">{draft.episodes.map((episode, index) => { const episodeBeats = beats.map((beat, beatIndex) => ({ beat, beatIndex })).filter(({ beat }) => beat.episode === index + 1); const primaryBeat = episodeBeats[0]; return <article className="panel outline-report-episode outline-report-episode-compact" key={index}><header><GalleryText className="outline-episode-title" value={episode.title || `第 ${index + 1} 集`} onChange={value => changeEpisode(index, 'title', value)}/>{primaryBeat ? <GalleryChoice className="outline-episode-type" value={primaryBeat.beat.type} options={episodeBeats.map(({ beat }) => ({ value: beat.type, label: beat.type }))} onChange={value => changeBeat(primaryBeat.beatIndex, 'type', value)}/> : <span className="outline-episode-type empty">暂无爽点</span>}</header><GalleryText className="outline-episode-summary" value={episode.summary} onChange={value => changeEpisode(index, 'summary', value)}/><div className="outline-episode-lines"><div><b>钩子</b><GalleryText className="outline-episode-line-text" value={episode.hook} onChange={value => changeEpisode(index, 'hook', value)}/></div><div><b>悬念</b><GalleryText className="outline-episode-line-text" placeholder="暂无悬念，双击添加" value={episode.suspense || ''} onChange={value => changeEpisode(index, 'suspense', value)}/></div></div><div className="outline-episode-refs">{(episode.sceneIds || []).map((id, refIndex) => { const outlineScene = scenes.find(item => item.id === id); const asset = project.docs.art.scenes.find(item => item.id === id) || project.docs.art.scenes.find(item => item.name === outlineScene?.name); const name = outlineScene?.name || asset?.name || id; return asset ? <button type="button" key={`s-${refIndex}`} className="outline-episode-ref outline-episode-ref-link outline-episode-ref-scene" onClick={() => go(`/p/${project.id}/art/scenes/${encodeURIComponent(asset.id)}`)}>{name}</button> : <span key={`s-${refIndex}`} className="outline-episode-ref outline-episode-ref-scene">{name}</span>; })}{(episode.characterIds || []).map((id, refIndex) => { const outlineCharacter = characters.find(item => item.id === id); const asset = project.docs.cast.find(item => item.id === id) || project.docs.cast.find(item => item.name === outlineCharacter?.name); const name = outlineCharacter?.name || asset?.name || id; return asset ? <button type="button" key={`c-${refIndex}`} className="outline-episode-ref outline-episode-ref-link outline-episode-ref-character" onClick={() => go(`/p/${project.id}/cast/${encodeURIComponent(asset.id)}`)}>{name}</button> : <span key={`c-${refIndex}`} className="outline-episode-ref outline-episode-ref-character">{name}</span>; })}{(episode.propIds || []).map((id, refIndex) => { const outlineProp = props.find(item => item.id === id); const asset = project.docs.art.props.find(item => item.id === id) || project.docs.art.props.find(item => item.name === outlineProp?.name); const name = outlineProp?.name || asset?.name || id; return asset ? <button type="button" key={`p-${refIndex}`} className="outline-episode-ref outline-episode-ref-link outline-episode-ref-prop" onClick={() => go(`/p/${project.id}/art/props/${encodeURIComponent(asset.id)}`)}>{name}</button> : <span key={`p-${refIndex}`} className="outline-episode-ref outline-episode-ref-prop">{name}</span>; })}{episode.crowdPlan && <details className="outline-episode-crowd"><summary>同框拆解 ✓</summary><GalleryText className="outline-episode-line-text" value={episode.crowdPlan} onChange={value => changeEpisode(index, 'crowdPlan', value)}/></details>}</div>{episode.warnings?.length ? <div className="outline-report-warnings">{episode.warnings.map((warning, i) => <span key={i}>{warning}</span>)}</div> : null}</article>; })}</div></section>
    <section className="outline-report-section"><OutlineSectionTitle n="03" title="场景概览" note="出场集与复用计划"/><div className="outline-report-scene-grid">{scenes.map((scene, index) => { const episodeNumbers = sceneAppearances(scene.id); const firstEpisode = episodeNumbers.length ? Math.min(...episodeNumbers) : null; const lastEpisode = episodeNumbers.length ? Math.max(...episodeNumbers) : null; const episodeRange = firstEpisode ? firstEpisode === lastEpisode ? firstEpisode : `${firstEpisode}–${lastEpisode}` : '—'; const carryingBeats = beats.filter(beat => episodeNumbers.includes(beat.episode)); const characterIds = [...new Set(draft.episodes.flatMap(episode => episode.sceneIds?.includes(scene.id) ? episode.characterIds || [] : []))]; return <article className="panel outline-report-scene" key={`${scene.id}-${index}`}><header className="outline-scene-head"><GalleryText className="outline-scene-id outline-inline-edit" value={scene.id} onChange={value => changeScene(index, 'id', value)}/><button type="button" className="outline-scene-name outline-scene-detail-link" onClick={() => { const artScene = project.docs.art.scenes.find(item => item.id === scene.id) || project.docs.art.scenes.find(item => item.name === scene.name); if (artScene) go(`/p/${project.id}/art/scenes/${encodeURIComponent(artScene.id)}`); }}>{scene.name}</button><GalleryChoice className={`outline-scene-primary outline-inline-edit ${scene.primary ? 'is-primary' : ''}`} value={scene.primary ? 'yes' : 'no'} options={[{ value: 'yes', label: '主场景' }, { value: 'no', label: '次场景' }]} onChange={value => changeScene(index, 'primary', value === 'yes')}/><span className="outline-scene-range">{episodeRange}</span></header><div className="outline-report-appearance" aria-label="出场集">{draft.episodes.map((_, ep) => <i key={ep} className={episodeNumbers.includes(ep + 1) ? 'on' : ''} title={`第 ${ep + 1} 集`}/>)}</div><div className="outline-scene-detail"><span>承载爽点</span><b>{carryingBeats.map(beat => beat.type).join(' · ') || '—'}</b></div><div className="outline-scene-detail"><span>复用方案</span><GalleryText className="outline-inline-edit outline-scene-reuse" value={scene.reusePlan || ''} onChange={value => changeScene(index, 'reusePlan', value)}/></div><div className="outline-scene-detail outline-scene-cast"><span>出场角色</span>{characterIds.length ? <div>{characterIds.map(id => { const outlineCharacter = characters.find(item => item.id === id); const castCharacter = project.docs.cast.find(item => item.id === id) || project.docs.cast.find(item => item.name === outlineCharacter?.name); const name = outlineCharacter?.name || castCharacter?.name || id; return castCharacter ? <button type="button" key={id} onClick={() => go(`/p/${project.id}/cast/${encodeURIComponent(castCharacter.id)}`)}>{name}</button> : <i key={id}>{name}</i>; })}</div> : <b>—</b>}</div></article>; })}</div></section>
    <section className="outline-report-section"><OutlineSectionTitle n="04" title="关键决策" note="拍板过的三件事，落进纸面"/><div className="outline-report-decision-grid outline-decision-summary"><article className="panel"><h3>砍了哪条线</h3>{cutDetails.map((item, index) => <div className="outline-decision-cut" key={index}><p className="outline-decision-cut-title">{item.what || '—'}</p>{item.why && <p className="outline-decision-why">{item.why}</p>}{item.evidence && <p className="outline-decision-evidence">原文依据：{item.evidence}</p>}</div>)}{draft.cutNote && <p className="outline-report-cut-note">{draft.cutNote}</p>}</article><article className="panel"><h3>合了哪些人</h3><p className="outline-decision-count">{characters.length} 个角色位（主角组 {leads.length} · 重要配角 {supporting.length} · 功能性 {functional.length}）</p><p className="outline-decision-leads">主角组：{leads.map(item => item.name).join('、') || '—'}</p>{mergeDetails.map((item, index) => <div className="outline-decision-merge" key={index}><p className="outline-decision-merge-title">{item.what}</p>{item.why && <p className="outline-decision-why">{item.why}</p>}</div>)}</article><article className="panel"><h3>大爆点落在第几集</h3>{majorBeats.map((beat, index) => { const marker = majorBeats.length === 1 ? '首个 · 终局' : index === 0 ? '首个' : index === majorBeats.length - 1 ? '终局' : ''; return <div className="outline-decision-major" key={`${beat.id}-${index}`}><small>ep{beat.episode}</small><strong>{beat.type}</strong><p>{beat.payoff}</p>{marker && <em>{marker}</em>}</div>; })}{!majorBeats.length && <p className="outline-table-empty">暂无大爆点</p>}</article></div></section>
    <section className="outline-report-section"><OutlineSectionTitle n="05" title="每集调度矩阵" note="资源在哪一集出现"/><div className="panel outline-report-table outline-report-matrix"><table className="detail-table"><thead><tr><th>角色 / 场景 / 道具</th><th>类别</th>{draft.episodes.map((_, index) => <th key={index}>E{index + 1}</th>)}<th>合计</th></tr></thead><tbody>{resourceRows.map(row => <tr key={`${row.id}-${row.name}`}><td className={`outline-resource-name outline-resource-${row.kind}`}><button type="button" onClick={() => go(`/p/${project.id}/${row.kind === 'character' ? 'cast' : `art/${row.kind === 'scene' ? 'scenes' : 'props'}`}/${encodeURIComponent(row.id)}`)}>{row.name}</button><small>{row.id}</small></td><td>{row.tier}</td>{draft.episodes.map((_, index) => <td key={index}><i className={row.episodes.includes(index + 1) ? 'active' : ''}/></td>)}<td>{row.episodes.length}{row.tier === '一次性场景' && row.episodes.length === 1 ? ' ⚠' : ''}</td></tr>)}</tbody></table></div></section>
    <section className="outline-report-section"><OutlineSectionTitle n="06" title="资产量折算" note="按层级估算制作投入"/><div className="panel outline-report-table outline-report-inventory"><table className="detail-table"><thead><tr><th>层级</th><th>数量</th><th>资产</th><th>制作要求</th></tr></thead><tbody><tr><td>主角组</td><td>{leads.length}</td><td>{leads.map(item => item.name).join('、') || '—'}</td><td>完整角色设定图与逐镜一致性核对</td></tr><tr><td>重要配角</td><td>{supporting.length}</td><td>{supporting.map(item => item.name).join('、') || '—'}</td><td>半身参考图，关键戏核对</td></tr><tr><td>功能性角色</td><td>{functional.length}</td><td>{functional.map(item => item.name).join('、') || '—'}</td><td>提示词直出，保持基本一致</td></tr><tr><td>场景环境</td><td>{scenes.length}</td><td>{scenes.map(item => item.name).join('、') || '—'}</td><td>主场景环境参考与光照基调</td></tr><tr><td>叙事道具</td><td>{props.length}</td><td>{props.map(item => item.name).join('、') || '—'}</td><td>白底设定图、状态变体与跨集一致性</td></tr><tr><td>生成难点</td><td>{draft.episodes.reduce((sum, episode) => sum + (episode.warnings?.length || 0), 0)}</td><td>{draft.episodes.flatMap((episode, index) => (episode.warnings || []).map(warning => `第 ${index + 1} 集：${warning}`)).join('；') || '—'}</td><td>拍摄前逐项确认预警</td></tr></tbody></table></div>{props.length > 0 && <div className="panel outline-report-props"><h3>道具清单</h3>{props.map((item, index) => <div className="outline-report-prop" key={item.id}><GalleryText className="outline-inline-edit" value={item.id} onChange={value => changeProp(index, 'id', value)}/><GalleryText className="outline-inline-edit" value={item.name} onChange={value => changeProp(index, 'name', value)}/><GalleryText className="outline-inline-edit multiline" value={item.function} onChange={value => changeProp(index, 'function', value)}/><small>{item.beatIds.join('、')}</small></div>)}</div>}</section>
    <section className="outline-report-section"><OutlineSectionTitle n="07" title="人物表"/><div className="panel outline-report-table outline-report-characters"><table className="detail-table"><thead><tr><th>ID</th><th>角色</th><th>层级</th><th>定位</th><th>人物弧</th><th>改动记录</th></tr></thead><tbody>{characters.map((item, index) => <tr key={`${item.id}-${index}`}><td><GalleryText className="outline-inline-edit" value={item.id} onChange={value => changeCharacter(index, 'id', value)}/></td><td><GalleryText className="outline-inline-edit" value={item.name} onChange={value => changeCharacter(index, 'name', value)}/></td><td><GalleryChoice className="outline-inline-edit" value={item.tier || 'support'} options={[{ value: 'lead', label: '主角组' }, { value: 'support', label: '重要配角' }, { value: 'functional', label: '功能性角色' }]} onChange={value => changeCharacter(index, 'tier', value)}/></td><td><GalleryText className="outline-inline-edit" value={item.role} onChange={value => changeCharacter(index, 'role', value)}/></td><td><GalleryText className="outline-inline-edit multiline" value={item.arc} onChange={value => changeCharacter(index, 'arc', value)}/></td><td><GalleryText className="outline-inline-edit" value={item.source} onChange={value => changeCharacter(index, 'source', value)}/></td></tr>)}</tbody></table></div></section>
    <section className="outline-report-section"><OutlineSectionTitle n="08" title="改编说明" note="为什么这么改 · 附原文依据"/><div className="panel outline-report-core"><label>故事核心<GalleryText className="outline-inline-edit multiline" value={draft.core} onChange={value => setDraft(d => ({ ...d, core: value }))}/></label><div className="outline-report-keep">{(draft.retainDetails || []).map((item, index) => <article key={index}><b>保留 · {item.what}</b><p>{item.why}</p>{item.evidence && <blockquote>{item.evidence}</blockquote>}</article>)}</div>{draft.cutNote && <p className="outline-report-cut-note">{draft.cutNote}</p>}</div></section>

  </div>;
}

function OutlineSectionTitle({ n, title, note }: { n: string; title: string; note?: string }) { return <div className="outline-report-section-title"><span>{n}</span><h2>{title}</h2>{note && <small>{note}</small>}</div>; }

function ScriptPage({ project, save, notify }: { project: Project; save: (value: Project['docs']['script']) => void; notify: (message: string) => void }) {
  const [draft, setDraft] = useState(() => clone(project.docs.script)); const [episode, setEpisode] = useState(0);
  useEffect(() => { setDraft(clone(project.docs.script)); setEpisode(0); }, [project.docs.script]);
  const current = draft.episodes[episode];
  function editEpisode(change: (value: typeof current) => typeof current) { setDraft(d => ({ ...d, episodes: d.episodes.map((e, i) => i === episode ? change(e) : e) })); }
  return <><PageHeading stage="STAGE 02 · 剧本 · SCRIPT" title={project.name} subtitle={excerpt(project.prompt, 160)} actions={<button className="btn primary" onClick={() => save(draft)}>保存剧本</button>}/><div className="editor-layout"><div className="editor-main"><div className="episode-tabs">{draft.episodes.map((_, i) => <button className={episode === i ? 'active' : ''} key={i} onClick={() => setEpisode(i)}>第 {i + 1} 集</button>)}<button onClick={() => { setDraft(d => ({ ...d, episodes: [...d.episodes, { title: `第 ${d.episodes.length + 1} 集`, duration: 60, hook: '', ending: '', scenes: [] }] })); setEpisode(draft.episodes.length); }}>＋</button></div>{current && <><section className="panel"><div className="episode-number">E{String(episode + 1).padStart(2, '0')} · {current.duration}s <button onClick={() => { setDraft(d => ({ ...d, episodes: d.episodes.filter((_, i) => i !== episode) })); setEpisode(Math.max(0, episode - 1)); }}>删除本集</button></div><input className="title-input" value={current.title} onChange={e => editEpisode(v => ({ ...v, title: e.target.value }))}/><div className="two-fields"><Field label="开场钩子" value={current.hook} onChange={v => editEpisode(e => ({ ...e, hook: v }))}/><Field label="结尾断点" value={current.ending} onChange={v => editEpisode(e => ({ ...e, ending: v }))}/></div><label className="compact-field">时长（秒）<input type="number" min="1" value={current.duration} onChange={e => editEpisode(v => ({ ...v, duration: Number(e.target.value) }))}/></label></section>{current.scenes.map((scene, i) => <section className="panel scene-panel" key={i}><div className="section-heading"><span className="eyebrow">S{i + 1} · SCENE</span><button className="text-button" onClick={() => editEpisode(e => ({ ...e, scenes: e.scenes.filter((_, j) => j !== i) }))}>删除场景</button></div><input className="title-input" value={scene.title} onChange={e => editEpisode(v => ({ ...v, scenes: v.scenes.map((s, j) => j === i ? { ...s, title: e.target.value } : s) }))}/><Field label="地点 / 时间" value={scene.location} onChange={v => editEpisode(e => ({ ...e, scenes: e.scenes.map((s, j) => j === i ? { ...s, location: v } : s) }))} rows={1}/><Field label="场景说明" value={scene.description} onChange={v => editEpisode(e => ({ ...e, scenes: e.scenes.map((s, j) => j === i ? { ...s, description: v } : s) }))}/><Field label="动作 / 台词 · 每行一条" value={scene.beats.join('\n')} onChange={v => editEpisode(e => ({ ...e, scenes: e.scenes.map((s, j) => j === i ? { ...s, beats: v.split('\n') } : s) }))} rows={5}/></section>)}<button className="add-block" onClick={() => editEpisode(e => ({ ...e, scenes: [...e.scenes, { title: '新场景', location: '', description: '', beats: [] }] }))}>＋ 新增场景</button></>}</div><Consultant project={project} onApply={scene => { const next = clone(draft); if (!next.episodes[episode]) return; next.episodes[episode].scenes.push(scene); save(next); notify('修改建议已加入剧本，并记录版本'); }}/></div></>;
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
      <button className="consultant-entry-delete delete-icon-button" type="button" title="删除记录" aria-label="删除这条顾问记录" onClick={() => setConfirmId(item.id)}><DeleteIcon/></button>
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

function SegmentProduction({ project, episode, segment, save, openImage, go }: { project: Project; episode: number; segment: string; save: (value: Project['docs']['storyboard'], label?: string) => void; openImage: (url: string) => void; go: (path: string) => void }) {
  const registerMedia = useContext(RegisterMedia);
  const [referenceShotId, setReferenceShotId] = useState<string | null>(null);
  const [referenceCategory, setReferenceCategory] = useState<'全部' | '角色' | '场景' | '道具' | '分镜图'>('全部');
  const [mediaDialog, setMediaDialog] = useState<{ shot: Shot; kind: 'image' | 'video' } | null>(null);
  const [imageHistoryShotId, setImageHistoryShotId] = useState<string | null>(null);
  const [deleteShotId, setDeleteShotId] = useState<string | null>(null);
  const [deletingShot, setDeletingShot] = useState(false);
  const [settings, setSettings] = useState<Awaited<ReturnType<typeof getSettings>> | null>(null);
  const [imageJobs, setImageJobs] = useState<Record<string, MediaJob>>({});
  const imageJobsRef = useRef<Record<string, { id: string; job: MediaJob }>>({});
  useEffect(() => { getSettings().then(setSettings).catch(() => setSettings(null)); }, []);
  const rawStoryboard = project.skillArtifacts?.storyboard?.raw as { episodes?: { ep?: number; segments?: { id?: string; sceneIndex?: number; cuts?: Record<string, unknown>[] }[] }[] } | undefined;
  const rawSegment = rawStoryboard?.episodes?.find(item => (Number(item.ep) || 1) === episode)?.segments?.find(item => item.id === segment);
  const shots = project.docs.storyboard.shots.filter(shot => (shot.episode || 1) === episode && (shot.segmentId || '未分段') === segment).map(shot => {
    const cutIndex = Number(shot.id.split('-').at(-1)) - 1;
    const rawCut = cutIndex >= 0 ? rawSegment?.cuts?.[cutIndex] : undefined;
    return {
      ...shot,
      lens: shot.lens || (typeof rawCut?.lens === 'string' ? rawCut.lens : undefined),
      cameraPosition: shot.cameraPosition || (typeof rawCut?.cameraPosition === 'string' ? rawCut.cameraPosition : undefined),
      composition: shot.composition || (typeof rawCut?.composition === 'string' ? rawCut.composition : undefined),
      eyeline: shot.eyeline || (typeof rawCut?.eyeline === 'string' ? rawCut.eyeline : undefined),
      focus: shot.focus || (typeof rawCut?.focus === 'string' ? rawCut.focus : undefined),
      stability: shot.stability || (typeof rawCut?.stability === 'string' ? rawCut.stability : undefined)
    };
  });
  const shotIdsKey = shots.map(shot => shot.id).join('|');
  useEffect(() => {
    let stopped = false;
    let refreshing = false;
    const refresh = async () => {
      if (refreshing) return;
      refreshing = true;
      const next = { ...imageJobsRef.current };
      try {
        for (const shotId of shotIdsKey.split('|').filter(Boolean)) {
          const storageKey = `reelbench-media-${project.id}-image-${shotId}`;
          const id = sessionStorage.getItem(storageKey);
          if (!id) { delete next[shotId]; continue; }
          const cached = next[shotId];
          if (cached?.id === id && !['queued', 'running'].includes(cached.job.status)) continue;
          try { next[shotId] = { id, job: await getMediaJob(id) }; }
          catch (error) {
            if (/不存在|重启/.test((error as Error).message)) {
              if (sessionStorage.getItem(storageKey) === id) sessionStorage.removeItem(storageKey);
              delete next[shotId];
            }
          }
        }
        if (!stopped) {
          imageJobsRef.current = next;
          setImageJobs(Object.fromEntries(Object.entries(next).map(([shotId, value]) => [shotId, value.job])));
        }
      } finally { refreshing = false; }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 1600);
    return () => { stopped = true; clearInterval(timer); };
  }, [project.id, shotIdsKey]);
  if (!shots.length) return <div className="empty-page">这一段暂无分镜</div>;
  const duration = Math.round(shots.reduce((sum, shot) => sum + shot.duration, 0) * 100) / 100;
  const starts = shots.map((_, index) => Math.round(shots.slice(0, index).reduce((sum, shot) => sum + shot.duration, 0) * 100) / 100);
  const resolveShotScene = (shot: Shot) => storyboardSceneAsset(project, shot);
  const timeline = shots.map((shot, index) => `[Shot ${index + 1}] At ${starts[index].toFixed(2)}s–${(starts[index] + shot.duration).toFixed(2)}s: ${shot.action}`).join('\n');
  const record = project.docs.storyboard.segments?.find(item => item.episode === episode && item.id === segment);
  const versions = record?.videos || [];
  const active = versions.find(version => version.id === record?.activeVideoId) || versions.at(-1);
  const missing = shots.filter(shot => !shot.image);
  const referenceToVideo = (() => { try { return Object.values(JSON.parse(settings?.comfy.video.workflowJson || '{}') as Record<string, { class_type?: string }>).some(node => node?.class_type === 'MiniMaxH3ReferenceToVideo'); } catch { return false; } })();
  const multi = !missing.length && shots.length > 1 && shots.length <= 8 && !!settings && (referenceToVideo || (settings.comfy.video.referenceSlots?.length || 0) >= shots.length - 1);
  const composedPrompt = multi ? `How the reference pictures align with the target video — ${shots.map((_, index) => `Picture ${index + 1} (from Shot ${index + 1}) aligns with the ${starts[index].toFixed(2)}-second mark`).join('; ')}.\n\nintegrated_multimodal_description:\n${timeline}` : `Use the first shot image as the only visual reference. Follow this segment timeline without assuming additional reference pictures.\n\nintegrated_multimodal_description:\n${timeline}`;
  // Imported storyboard segments keep the exact H3 prompt used by the upstream workflow.
  // Submit that text verbatim so MiniMax receives the same prompt shown in the raw-prompt disclosure.
  const prompt = shots[0].videoPrompt || composedPrompt;
  const videoSources = multi ? shots.map(shot => shot.image!).filter(Boolean) : undefined;
  const segmentKey = `segment-${episode}-${segment}`;
  const segmentReferenceAssets: { id: string; name: string; category: '角色' | '场景' | '道具'; href: string }[] = [];
  const seenSegmentReferences = new Set<string>();
  const addSegmentReference = (item: { id: string; name: string }, category: '角色' | '场景' | '道具') => {
    const key = `${category}-${item.id}`;
    if (seenSegmentReferences.has(key)) return;
    seenSegmentReferences.add(key);
    const href = category === '角色' ? `/p/${project.id}/cast/${encodeURIComponent(item.id)}` : `/p/${project.id}/art/${category === '场景' ? 'scenes' : 'props'}/${encodeURIComponent(item.id)}`;
    segmentReferenceAssets.push({ id: item.id, name: item.name, category, href });
  };
  if (rawSegment) {
    const characterIds = [...new Set(rawSegment.cuts?.flatMap(cut => Array.isArray(cut.characters) ? cut.characters.filter((id): id is string => typeof id === 'string') : []) || [])];
    const propIds = [...new Set(rawSegment.cuts?.flatMap(cut => Array.isArray(cut.props) ? cut.props.filter((id): id is string => typeof id === 'string') : []) || [])];
    characterIds.forEach(id => { const item = project.docs.cast.find(character => character.id === id); if (item) addSegmentReference(item, '角色'); });
    const sceneIndex = Number(rawSegment.sceneIndex);
    const sceneId = Number.isInteger(sceneIndex) && sceneIndex > 0 ? project.docs.script.episodes[episode - 1]?.scenes?.[sceneIndex - 1]?.sceneId : undefined;
    const scene = sceneId ? project.docs.art.scenes.find(item => item.id === sceneId) : undefined;
    if (scene) addSegmentReference(scene, '场景');
    propIds.forEach(id => {
      const sceneAsset = project.docs.art.scenes.find(item => item.id === id);
      const prop = project.docs.art.props.find(item => item.id === id);
      if (sceneAsset) addSegmentReference(sceneAsset, '场景');
      else if (prop) addSegmentReference(prop, '道具');
    });
  } else shots.forEach(shot => {
    (shot.characters || []).forEach(id => { const item = project.docs.cast.find(character => character.id === id); if (item) addSegmentReference(item, '角色'); });
    const scene = resolveShotScene(shot);
    if (scene) addSegmentReference(scene, '场景');
    (shot.props || []).forEach(id => {
      const sceneAsset = project.docs.art.scenes.find(item => item.id === id);
      const prop = project.docs.art.props.find(item => item.id === id);
      if (sceneAsset) addSegmentReference(sceneAsset, '场景');
      else if (prop) addSegmentReference(prop, '道具');
    });
  });
  const changeShot = (id: string, update: (shot: Shot) => Shot, label: string) => save({ ...project.docs.storyboard, shots: project.docs.storyboard.shots.map(shot => shot.id === id ? update(shot) : shot) }, label);
  const reorderShotReferences = (shotId: string, fromIndex: number, toIndex: number) => {
    const shot = project.docs.storyboard.shots.find(item => item.id === shotId);
    if (!shot || fromIndex === toIndex) return;
    const references = [...storyboardImageReferences(project, shot).entries];
    if (fromIndex < 0 || fromIndex >= references.length || toIndex < 0 || toIndex >= references.length) return;
    const [moved] = references.splice(fromIndex, 1);
    references.splice(toIndex, 0, moved);
    changeShot(shotId, item => ({ ...item, referenceImages: references }), '调整镜头引用图片顺序');
  };
  async function confirmDeleteShot(shot: Shot) {
    setDeletingShot(true);
    const storageKey = `reelbench-media-${project.id}-image-${shot.id}`;
    const jobId = sessionStorage.getItem(storageKey);
    if (jobId) {
      try {
        const job = await getMediaJob(jobId);
        if (job.status === 'queued' || job.status === 'running') await cancelMediaJob(jobId);
        else if (job.status === 'completed') await discardMediaJob(jobId);
      } catch { /* The shot can still be removed if its temporary task has expired. */ }
      sessionStorage.removeItem(storageKey);
    }
    const next = clone(project.docs.storyboard);
    next.shots = next.shots.filter(item => item.id !== shot.id);
    save(next, `删除第 ${shots.findIndex(item => item.id === shot.id) + 1} 镜`);
    setDeletingShot(false);
    setDeleteShotId(null);
  }
  const saveVersion = (url: string, usedPrompt?: string) => {
    const next = clone(project.docs.storyboard);
    const found = next.segments?.find(item => item.episode === episode && item.id === segment);
    const version = { id: uid(), url, createdAt: Date.now(), prompt: usedPrompt || prompt };
    if (found) { found.videos.push(version); found.activeVideoId = version.id; }
    else next.segments = [...(next.segments || []), { episode, id: segment, videos: [version], activeVideoId: version.id }];
    save(next, `保存第 ${episode} 集${segment}分段视频`);
  };
  return <div className="segment-production">
    <div className="segment-header">
      <div><div className="eyebrow">分镜 / 第 {episode} 集</div><h1>{segment}</h1><p>{shots.length} 镜 · {duration.toFixed(1)}s / 15s</p>{!!segmentReferenceAssets.length && <div className="segment-header-references" aria-label="本段引用资产">{segmentReferenceAssets.map(asset => <button type="button" key={`${asset.category}-${asset.id}`} className={`segment-header-reference segment-header-reference-${asset.category}`} onClick={() => go(asset.href)}>{asset.name}</button>)}</div>}</div>
    </div>
    <div className="segment-video-layout">
      <section className="panel segment-prompt">
        <div className="eyebrow">integrated_multimodal_description:</div>
        {shots.map((shot, index) => <div className="segment-prompt-row" key={shot.id}>
          <small>[Shot {index + 1}]<br/>{starts[index].toFixed(2)}–{(starts[index] + shot.duration).toFixed(2)}s</small>
          <SegmentPromptEditor label={`第 ${index + 1} 镜提示词`} value={shot.action} save={value => changeShot(shot.id, item => ({ ...item, action: value }), '修改分段镜头提示词')}/>
        </div>)}
        {shots[0].videoPrompt && <details><summary>查看生成时的原始 H3 提示词<button className="copy-prompt-button" onClick={event => { event.stopPropagation(); void copyText(prompt); }} title="复制整条提示词" aria-label="复制整条提示词"><CopyPromptIcon/></button></summary><pre>{shots[0].videoPrompt}</pre></details>}
      </section>
      <section className="segment-video-side">
        <div className="segment-video-preview" style={{ aspectRatio: project.ratio.replace(':', ' / ') }}>{active ? <video src={active.url} controls preload="metadata"/> : <div>尚未生成本段视频</div>}</div>
        {(duration > 15 || missing.length > 0 || (duration <= 15 && !!shots[0].image)) && <div className="segment-video-action">
          <div className="segment-video-warnings">{duration > 15 && <p className="field-error">本段 {duration.toFixed(1)}s 超过 MiniMax H3 的 15s 上限，请拆段或缩短镜头。</p>}{missing.length > 0 && <p className="field-error">还有 {missing.length} 张分镜图片未保存；可逐镜上传或生成。</p>}</div>
          {duration <= 15 && shots[0].image && <MediaGenerator project={project} kind="video" targetId={segmentKey} videoTitle={`${segment} · 生成分段视频`} prompt={prompt} source={shots[0].image} duration={duration} segmentMode videoSources={videoSources} cutPoints={multi && !referenceToVideo ? starts : undefined} onAccept={saveVersion}/>}
        </div>}
        <div className="segment-version-tabs"><span>这一段的历次</span>{versions.map((version, index) => <button key={version.id} className={active?.id === version.id ? 'active' : ''} onClick={() => {
          const next = clone(project.docs.storyboard);
          const item = next.segments?.find(entry => entry.episode === episode && entry.id === segment);
          if (item) item.activeVideoId = version.id;
          save(next, '切换分段视频版本');
        }}>第 {index + 1} 版</button>)}</div>
      </section>
    </div>
    <div className="segment-shot-section-head"><div><h2>逐镜设定</h2></div></div>
    <div className="segment-shot-list">{shots.map((shot, index) => {
      const selectedReferenceEntries = storyboardImageReferences(project, shot).entries;
      const imageHistory = project.assets.filter(asset => asset.sourceItemId === shot.id && asset.image).sort((a, b) => (b.generatedAt || 0) - (a.generatedAt || 0)); const imageVersionCount = imageHistory.length + (shot.image && !imageHistory.some(asset => asset.image === shot.image) ? 1 : 0);
      const nextShot = shots[index + 1]; const useFirstLastVideoWorkflow = !!settings?.comfy.videoFirstLast.workflowJson && !!shot.image && !!nextShot?.image;
      const videoVersions = project.assets.filter(asset => asset.sourceItemId === shot.id && asset.video).sort((a, b) => (a.generatedAt || 0) - (b.generatedAt || 0));
      if (shot.video && !videoVersions.some(asset => asset.video === shot.video)) videoVersions.unshift({ id: `current-video-${shot.id}`, type: 'other', name: `分镜 · ${shot.scene} · 当前视频`, description: '当前使用中的视频', mediaKind: 'video', video: shot.video, sourceItemId: shot.id });
      return <article className="panel segment-shot-editor" key={shot.id}>
        <div className="segment-shot-editor-head"><strong>#{index + 1}</strong><span>{starts[index].toFixed(1)}s</span><span>·</span><span>{shot.duration}s</span><span>·</span><span>{shot.framing || '景别未设'}</span><span>·</span><span>{shot.camera || '运镜未设'}</span><button className="segment-shot-delete-button delete-icon-button" title="删除此镜头" aria-label={`删除第 ${index + 1} 镜`} onClick={() => setDeleteShotId(shot.id)}><DeleteIcon/></button></div>
       <div className="segment-shot-editor-grid">
    <section className="segment-shot-visual"><div className="segment-shot-editor-label"><span>分镜图</span><div className="segment-shot-media-actions"><button className="btn small segment-shot-history-button" onClick={() => setImageHistoryShotId(shot.id)} title="图片历史">◷ <span>{imageVersionCount}</span></button><SingleImageUploadButton project={project} target={{ id: shot.id, type: 'storyboard', name: `${segment}-${String(index + 1).padStart(2, '0')}`, description: shot.action, image: shot.image }} title={`${segment}-${String(index + 1).padStart(2, '0')}`} buttonLabel="上传" onAccept={url => { if (shot.image && !project.assets.some(asset => asset.sourceItemId === shot.id && asset.image === shot.image)) registerMedia(project.id, { id: uid(), type: 'storyboard', name: `${segment}-${String(index + 1).padStart(2, '0')} · 上传前版本`, description: '上传替换前的分镜图', mediaKind: 'image', image: shot.image, sourceProjectId: project.id, sourceItemId: shot.id, generatedAt: Date.now() }); changeShot(shot.id, item => ({ ...item, image: url }), '上传分镜图'); }}/>{(() => { const job = imageJobs[shot.id]; const status = job?.status === 'queued' || job?.status === 'running' || job?.status === 'completed' ? job.status : null; const statusTitle = status === 'queued' ? `排队中${job.queuePosition ? ` · 队列第 ${job.queuePosition} 位` : ''}` : status === 'running' ? '正在生成' : status === 'completed' ? '已生成，待确认保存' : ''; return <button className="btn small segment-shot-regenerate-button" onClick={() => setMediaDialog({ shot, kind: 'image' })} title={statusTitle || (shot.image ? '重新生成' : '生成')} aria-label={`${shot.image ? '重新生成' : '生成'}${status ? `，${statusTitle}` : ''}`}>{shot.image ? '重新生成' : '生成'}{status && <span className={`segment-shot-job-dot ${status}`} aria-hidden="true"/>}</button>; })()}</div></div><div className="segment-shot-large-picture">{shot.image ? <img src={shot.image} alt={`镜头 ${index + 1}`} onClick={() => openImage(shot.image!)}/> : <span>尚无分镜图</span>}<small>SHOT {String(index + 1).padStart(2, '0')} · {starts[index].toFixed(2)}s</small></div><div className="segment-shot-video-tools">{shot.image && <MediaGenerator key={`shot-video-${shot.id}`} project={project} kind="video" videoWorkflow={useFirstLastVideoWorkflow ? 'firstLast' : undefined} videoSources={useFirstLastVideoWorkflow ? [shot.image!, nextShot!.image!] : undefined} targetId={shot.id} videoTitle={`${segment}-${String(index + 1).padStart(2, '0')} · 生成分镜视频`} prompt={shot.action} source={shot.image} duration={shot.duration} onAccept={url => changeShot(shot.id, item => ({ ...item, video: url }), '保存分镜视频')}/>}{videoVersions.length > 0 && <div className="segment-version-tabs"><span>本镜历次</span>{videoVersions.map((version, versionIndex) => <button key={version.id} className={shot.video === version.video ? 'active' : ''} onClick={() => changeShot(shot.id, item => ({ ...item, video: version.video }), '切换单镜视频版本')}>第 {versionIndex + 1} 版</button>)}</div>}{shot.video && <MediaClip src={shot.video} showDownload={false}/>}</div></section>
          <section className="segment-shot-prompt"><div className="segment-shot-editor-label"><span>画面提示词</span><button className="copy-prompt-button" onClick={() => void copyText(shot.action)} title="复制画面提示词" aria-label="复制画面提示词"><CopyPromptIcon/></button></div><SegmentPromptEditor label={`第 ${index + 1} 镜画面提示词`} value={shot.action} save={value => changeShot(shot.id, item => ({ ...item, action: value }), '修改分镜画面提示词')}/><div className="segment-shot-reference-head"><span>引用资产</span><button className="btn small segment-add-reference-button" title="添加引用" aria-label="添加引用" onClick={() => { setReferenceCategory('全部'); setReferenceShotId(shot.id); }}>＋</button></div><div className="segment-shot-references">{selectedReferenceEntries.map((reference, referenceIndex) => <div draggable onDragStart={event => { event.dataTransfer.setData('text/plain', String(referenceIndex)); event.dataTransfer.effectAllowed = 'move'; }} onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); const fromIndex = Number(event.dataTransfer.getData('text/plain')); if (Number.isInteger(fromIndex)) reorderShotReferences(shot.id, fromIndex, referenceIndex); }} className={`segment-shot-reference segment-shot-reference-${reference.category === '角色' ? 'character' : reference.category === '场景' ? 'scene' : reference.category === '分镜图' ? 'storyboard' : 'prop'}`} key={`${reference.assetId}-${reference.image}`}><img src={reference.image} alt="" title="点击查看大图" onClick={() => openImage(reference.image)}/><small>{reference.category}</small><button className="segment-shot-reference-link">{reference.name}</button><button className="segment-shot-reference-remove delete-icon-button" title="移除引用" onClick={() => changeShot(shot.id, item => ({ ...item, referenceImages: selectedReferenceEntries.filter(entry => !(entry.assetId === reference.assetId && entry.image === reference.image)) }), '移除镜头引用图片')}><DeleteIcon/></button></div>)}{!selectedReferenceEntries.length && <span className="segment-shot-no-references">尚未引用角色、场景、道具或分镜图</span>}</div></section>
        </div>
      </article>;
    })}</div>
    {referenceShotId && <Modal title="选择引用资产" onClose={() => setReferenceShotId(null)}><p className="muted">按分类选择要引用的具体图片，分镜图仅显示当前保存的图片。</p><div className="filter-tabs" role="tablist" aria-label="引用资产分类">{(['全部', '角色', '场景', '道具', '分镜图'] as const).map(category => <button key={category} role="tab" aria-selected={referenceCategory === category} className={referenceCategory === category ? 'active' : ''} onClick={() => setReferenceCategory(category)}>{category}</button>)}</div><div className="segment-reference-picker">{[...project.docs.cast.map(item => ({ id: item.id, name: item.name, category: '角色' as const, images: [{ image: item.image, label: '形象图' }, { image: item.turnaroundImage, label: '三视图' }, ...(item.states || []).map((state, index) => ({ image: state.image, label: state.state || `状态 ${index + 1}` }))].filter((entry): entry is { image: string; label: string } => !!entry.image) })), ...project.docs.art.scenes.map(item => ({ id: item.id, name: item.name, category: '场景' as const, images: [{ image: item.image, label: '主图' }, { image: item.settingImage, label: '设定图' }, ...(item.states || []).map((state, index) => ({ image: state.image, label: state.state || `状态 ${index + 1}` }))].filter((entry): entry is { image: string; label: string } => !!entry.image) })), ...project.docs.art.props.map(item => ({ id: item.id, name: item.name, category: '道具' as const, images: [{ image: item.image, label: '主图' }, { image: item.settingImage, label: '设定图' }, ...(item.states || []).map((state, index) => ({ image: state.image, label: state.state || `状态 ${index + 1}` }))].filter((entry): entry is { image: string; label: string } => !!entry.image) })), ...project.docs.storyboard.shots.filter(item => !!item.image).map(item => ({ id: item.id, name: `${item.segmentId || '分镜'}-${String(project.docs.storyboard.shots.filter(other => other.episode === item.episode && other.segmentId === item.segmentId).findIndex(other => other.id === item.id) + 1).padStart(2, '0')}`, category: '分镜图' as const, images: [{ image: item.image!, label: '分镜图' }] }))].filter(asset => referenceCategory === '全部' || asset.category === referenceCategory).map(asset => <section className="segment-reference-group" key={asset.id}><strong>{asset.category} · {asset.name}</strong><div>{asset.images.map((entry, index) => { const currentShot = shots.find(item => item.id === referenceShotId)!; const existing = currentShot.referenceImages || storyboardImageReferences(project, currentShot).entries; const selected = existing.some(reference => reference.assetId === asset.id && reference.image === entry.image); return <button className={selected ? 'selected' : ''} key={`${entry.image}-${index}`} onClick={() => changeShot(referenceShotId, item => { const current = item.referenceImages || storyboardImageReferences(project, item).entries; const next = selected ? current.filter(reference => !(reference.assetId === asset.id && reference.image === entry.image)) : [...current, { assetId: asset.id, image: entry.image, name: `${asset.name} · ${entry.label}`, category: asset.category }]; return { ...item, referenceImages: next }; }, '更新镜头引用图片')}><img src={entry.image} alt=""/><span>{entry.label}</span><b>{selected ? '已引用' : '＋'}</b></button>; })}{!asset.images.length && <small>暂无图片</small>}</div></section>)}</div></Modal>}
    {deleteShotId && (() => { const target = shots.find(item => item.id === deleteShotId); if (!target) return null; return <Modal title="删除分镜" onClose={() => { if (!deletingShot) setDeleteShotId(null); }}><p>确定删除第 {shots.findIndex(item => item.id === target.id) + 1} 镜「{target.scene || '新场景'}」吗？该镜头将从当前分段移除，已确认的媒体仍保留在项目资产库。</p><div className="modal-actions"><button className="btn" disabled={deletingShot} onClick={() => setDeleteShotId(null)}>取消</button><button className="btn danger" disabled={deletingShot} onClick={() => void confirmDeleteShot(target)}>{deletingShot ? '正在删除…' : '确认删除'}</button></div></Modal>; })()}
    {imageHistoryShotId && (() => { const historyShot = shots.find(item => item.id === imageHistoryShotId); if (!historyShot) return null; const history = project.assets.filter(asset => asset.sourceItemId === historyShot.id && asset.image).sort((a, b) => (b.generatedAt || 0) - (a.generatedAt || 0)); const currentImage = historyShot.image; const versions = [...history]; if (currentImage && !versions.some(asset => asset.image === currentImage)) versions.unshift({ id: `current-${historyShot.id}`, type: 'storyboard', name: '当前分镜图', description: '当前使用中的图片', image: currentImage, sourceItemId: historyShot.id }); return <Modal title="分镜图历史记录" onClose={() => setImageHistoryShotId(null)}><div className="eyebrow">IMAGE HISTORY</div><p className="muted">重新生成、编辑和恢复都会保留图片版本。恢复只切换当前分镜图，不会删除其他历史版本。</p><div className="segment-image-history-grid">{versions.map((asset, versionIndex) => { const isCurrent = asset.image === currentImage; return <article className={`segment-image-history-card${isCurrent ? ' current' : ''}`} key={asset.id}><button className="segment-image-history-preview" onClick={() => openImage(asset.image!)}><img src={asset.image} alt={asset.name}/><span>查看大图</span></button><div className="segment-image-history-meta"><strong>图片 #{history.length - versionIndex}</strong>{isCurrent && <em>当前版本</em>}</div><p>{asset.provider || '分镜图片'}{asset.generatedAt ? ` · ${new Date(asset.generatedAt).toLocaleString()}` : ''}</p><button className="btn primary small" disabled={isCurrent} onClick={() => { const next = clone(project.docs.storyboard); const target = next.shots.find(item => item.id === historyShot.id); if (!target) return; if (target.image && target.image !== asset.image && !project.assets.some(item => item.sourceItemId === target.id && item.image === target.image)) registerMedia(project.id, { id: uid(), type: 'storyboard', name: `分镜 · ${target.scene} · 恢复前版本`, description: '恢复历史版本时保留的前一版本', mediaKind: 'image', image: target.image, sourceProjectId: project.id, sourceItemId: target.id, generatedAt: Date.now() }); target.image = asset.image!; save(next, `恢复第 ${shots.findIndex(item => item.id === historyShot.id) + 1} 镜历史分镜图`); setImageHistoryShotId(null); }}>{isCurrent ? '正在使用' : '恢复此版本'}</button></article>; })}{!versions.length && <div className="detail-empty">暂无历史图片。重新生成或编辑后，版本会保存在这里。</div>}</div></Modal>; })()}
    {mediaDialog && (() => { const targetShot = shots.find(item => item.id === mediaDialog.shot.id) || mediaDialog.shot; const { references } = storyboardImageReferences(project, targetShot); return <Modal title={`第 ${shots.findIndex(item => item.id === targetShot.id) + 1} 镜 · 生成分镜图`} onClose={() => setMediaDialog(null)}><MediaGenerator key={targetShot.id} project={project} kind="image" targetId={targetShot.id} prompt={targetShot.action} referenceImages={references} onAccept={url => { changeShot(targetShot.id, item => ({ ...item, image: url }), '保存分镜图'); setMediaDialog(null); }}/></Modal>; })()}
  </div>;
}
function storyboardSceneAsset(project: Project, shot: Shot) {
  if (shot.sceneId === null) return undefined;
  const direct = project.docs.art.scenes.find(item => item.id === shot.sceneId) || project.docs.art.scenes.find(item => item.name === shot.scene);
  if (direct) return direct;
  const firstBeat = shot.beats?.[0];
  if (!firstBeat) return undefined;
  const scriptScenes = project.docs.script.episodes[(shot.episode || 1) - 1]?.scenes || [];
  let beatOffset = 0;
  for (const scriptScene of scriptScenes) {
    const sceneBeatCount = Math.max(scriptScene.beats?.length || 0, scriptScene.flow?.length || 0);
    if (firstBeat >= beatOffset + 1 && firstBeat <= beatOffset + sceneBeatCount && scriptScene.sceneId) {
      return project.docs.art.scenes.find(item => item.id === scriptScene.sceneId)
        || project.docs.art.scenes.find(item => item.name === project.docs.outline.scenes?.find(outlineScene => outlineScene.id === scriptScene.sceneId)?.name);
    }
    beatOffset += sceneBeatCount;
  }
  return undefined;
}

function storyboardImageReferences(project: Project, shot: Shot) {
  if (shot.referenceImages) return { entries: shot.referenceImages, references: shot.referenceImages.map(entry => entry.image) };
  const characters = (shot.characters || []).map(id => project.docs.cast.find(item => item.id === id)).filter((item): item is Character => !!item);
  const scene = storyboardSceneAsset(project, shot);
  const art = [...(scene ? [scene] : []), ...(shot.props || []).map(id => [...project.docs.art.scenes, ...project.docs.art.props].find(item => item.id === id)).filter((item): item is ArtAsset => !!item)]
    .filter((item, index, all) => all.findIndex(other => other.id === item.id) === index);
  const entries = [...art.filter(asset => asset.type === 'scene').map(asset => ({ asset, image: asset.image, category: '场景' as const, isCharacter: false as const })), ...art.filter(asset => asset.type !== 'scene').map(asset => ({ asset, image: asset.image, category: '道具' as const, isCharacter: false as const })), ...characters.map(asset => ({ asset, image: asset.turnaroundImage || asset.image, category: '角色' as const, isCharacter: true as const }))]
    .filter((entry, index, all) => all.findIndex(other => other.asset.id === entry.asset.id) === index);
  const imageEntries = entries.filter((entry): entry is typeof entry & { image: string } => !!entry.image)
    .filter((entry, index, all) => all.findIndex(other => other.image === entry.image) === index);
  const references = imageEntries.map(entry => entry.image);
  const selectedEntries = imageEntries.map(entry => ({ assetId: entry.asset.id, image: entry.image, name: entry.asset.name, category: entry.category }));
  const instructions = entries.map((entry, index) => `@图${index + 1}:${entry.asset.name}`);
  let prompt = shot.action.replace(/抱着一只水晶鞋冲向空殿大门，双手用力拍门/, '一只手抱着水晶鞋，另一只手用力拍紧闭的殿门');
  for (const character of characters) prompt = prompt.replace(new RegExp(`\\b${character.id}\\b`, 'g'), character.name);
  const framing = /全景|远景|wide|full/i.test(shot.framing || '') ? '全景：人物从头顶到脚部完整入画，四周保留空间，完整展示动作和场景。' : /中景|medium/i.test(shot.framing || '') ? '中景：人物头顶、面部、双手和腰部完整入画，头顶留白；手持道具完整可见，不得只拍裙摆或躯干。' : `景别：${shot.framing || '按镜头描述'}。`;
  const cameraDescriptions: Record<string, string> = { 'Static Shot': '固定镜头', 'Push In': '缓慢推近', 'Pull Out': '缓慢拉远', 'Pan Left': '向左摇镜', 'Pan Right': '向右摇镜', 'Tilt Up': '向上摇镜', 'Tilt Down': '向下摇镜' };
  const camera = shot.camera ? `运镜：${cameraDescriptions[shot.camera] || shot.camera}。` : '';
  const sceneInstruction = scene ? `场景按「${scene.name}」资产设定还原，保持空间布局、建筑与陈设一致。` : '';
  const stabilityDescriptions: Record<string, string> = { stable: '画面稳定', 'slight-shake': '轻微晃动', handheld: '手持拍摄' };
  const visualParameters = [
    shot.lens && `焦距与景深：${shot.lens}`,
    shot.cameraPosition && `机位：${shot.cameraPosition}`,
    shot.composition && `构图：${shot.composition}`,
    shot.eyeline && `视线：${shot.eyeline}`,
    shot.focus && `焦点：${shot.focus}`,
    shot.stability && `稳定方式：${stabilityDescriptions[shot.stability] || shot.stability}`
  ].filter(Boolean).join('；');
  const visualDirection = visualParameters ? `镜头画面控制：${visualParameters}。` : '';
  const referenceMapping = instructions.length ? `引用图对应：${instructions.join('，')}` : '';
  return { references, entries: selectedEntries, prompt: [sceneInstruction, framing, camera, visualDirection, referenceMapping, prompt].filter(Boolean).join('\n') };
}

function GalleryText({ value, onChange, className = '', placeholder }: { value: string; onChange: (value: string) => void; className?: string; placeholder?: string }) {
  const [editing, setEditing] = useState(false);
  return editing ? <textarea className={`gallery-text-edit ${className}`} autoFocus value={value} placeholder={placeholder} onChange={e => onChange(e.target.value)} onBlur={() => setEditing(false)} onKeyDown={e => { if (e.key === 'Escape' || ((e.ctrlKey || e.metaKey) && e.key === 'Enter')) setEditing(false); }}/> : <div className={className} onDoubleClick={() => setEditing(true)} title="双击编辑">{value || <em>{placeholder || '双击填写'}</em>}</div>;
}

function GalleryChoice({ value, options, onChange, className = '' }: { value: string; options: { value: string; label: string }[]; onChange: (value: string) => void; className?: string }) {
  const [editing, setEditing] = useState(false);
  const label = options.find(option => option.value === value)?.label || value || '双击选择';
  return editing ? <select className={className} autoFocus value={value} onChange={event => { onChange(event.target.value); setEditing(false); }} onBlur={() => setEditing(false)}>{options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select> : <div className={className} onDoubleClick={() => setEditing(true)} title="双击编辑">{label}</div>;
}

function SingleImageUploadButton({ project, target, title, historyId = target.id, onAccept, buttonLabel = '上传图片' }: { project: Project; target: Character | Asset; title: string; historyId?: string; onAccept: (url: string) => void; buttonLabel?: string }) {
  const [uploading, setUploading] = useState(false);
  const controllerRef = useRef<AbortController | null>(null);
  const registerMedia = useContext(RegisterMedia);
  const notify = useContext(Notify);
  async function upload(file?: File) {
    if (!file) return;
    if (!(file.type === 'image/png' || file.type === 'image/jpeg' || file.type === 'image/webp') && !/\.(png|jpe?g|webp)$/i.test(file.name)) { notify('仅支持 PNG、JPEG 或 WebP 图片'); return; }
    if (file.size > 20 * 1024 * 1024) { notify('图片不能超过 20 MB'); return; }
    const controller = new AbortController(); controllerRef.current = controller; setUploading(true);
    try {
      const { url } = await uploadLibraryMedia(file, 'image', controller.signal);
      const type: AssetType = 'type' in target ? target.type : 'character';
      registerMedia(project.id, { id: uid(), type, name: title, description: '卡片上传', mediaKind: 'image', image: url, sourceProjectId: project.id, sourceItemId: historyId, generatedAt: Date.now(), provider: '本机上传' });
      onAccept(url); notify(`已上传「${title}」图片到项目${assetNames[type]}资产`);
    } catch (error) { notify(controller.signal.aborted ? '已取消图片上传' : `上传失败：${(error as Error).message}`); }
    finally { if (controllerRef.current === controller) controllerRef.current = null; setUploading(false); }
  }
  return <span className="gallery-upload-wrap"><label className={`btn small gallery-upload-image-button${uploading ? ' disabled' : ''}`}>{uploading ? '正在上传…' : buttonLabel}<input type="file" accept="image/png,image/jpeg,image/webp" disabled={uploading} onChange={event => { void upload(event.currentTarget.files?.[0]); event.currentTarget.value = ''; }}/></label>{uploading && <button type="button" className="gallery-upload-cancel" title="取消上传" aria-label="取消上传" onClick={() => controllerRef.current?.abort()}>×</button>}</span>;
}

function CompactDetailImageTools({ project, target, prompt, negativePrompt, referenceImages, source, history, historyId = target.id, viewName, onAccept, onDeleteHistory, openImage }: { project: Project; target: Character | Asset; prompt: string; negativePrompt?: string; referenceImages?: string[]; source?: string; history: Asset[]; historyId?: string; viewName: string; onAccept: (url: string) => void; onDeleteHistory: (asset: Asset) => void; openImage: (url: string) => void }) {
  const [dialog, setDialog] = useState<'edit' | 'history' | null>(null);
  const [jobStatus, setJobStatus] = useState<MediaJob | null>(null);
  const registerMedia = useContext(RegisterMedia);
  useEffect(() => setJobStatus(null), [historyId]);
  const visibleJobStatus = jobStatus?.status === 'queued' || jobStatus?.status === 'running' || jobStatus?.status === 'completed' ? jobStatus.status : null;
  const statusTitle = visibleJobStatus === 'queued' ? `排队中${jobStatus?.queuePosition ? ` · 队列第 ${jobStatus.queuePosition} 位` : ''}` : visibleJobStatus === 'running' ? '正在生成' : visibleJobStatus === 'completed' ? '已生成，待确认保存' : '';
  const versions = [...history].sort((a, b) => (b.generatedAt || 0) - (a.generatedAt || 0));
  const assetType = 'type' in target ? target.type : 'character';
  const generateLabel = target.image ? '重新生成' : '生图';
  if (target.image && !versions.some(asset => asset.image === target.image)) versions.unshift({ id: `current-${historyId}`, type: assetType, name: target.name, description: '当前使用中的图片', image: target.image, sourceItemId: historyId });
  return <>
    <div className="character-image-actions"><button className="btn small character-history-button" title={`${viewName}图片历史`} onClick={() => setDialog('history')}>◷ <span>{versions.length}</span></button><SingleImageUploadButton project={project} target={target} title={`${target.name} · ${viewName}`} historyId={historyId} onAccept={onAccept}/><button className="btn small segment-shot-regenerate-button" title={statusTitle || generateLabel} aria-label={`${generateLabel}${visibleJobStatus ? `，${statusTitle}` : ''}`} onClick={() => setDialog('edit')}>{generateLabel}{visibleJobStatus && <span className={`segment-shot-job-dot ${visibleJobStatus}`} aria-hidden="true"/>}</button></div>
    {dialog === 'edit' && <Modal title={`${target.name} · ${viewName}`} onClose={() => setDialog(null)}><MediaGenerator key={historyId} project={project} kind="image" targetId={target.id} historyId={historyId} prompt={prompt} negativePrompt={negativePrompt} referenceImages={referenceImages} source={source} defaultRatio={viewName === '形象' ? '9:16' : undefined} onJobStatusChange={setJobStatus} onAccept={url => { onAccept(url); setDialog(null); }}/></Modal>}
    {dialog === 'history' && <Modal title={`${viewName}图片历史记录`} onClose={() => setDialog(null)}><div className="eyebrow">IMAGE HISTORY</div><p className="muted">图片历史记录按视图分别保存。</p><div className="segment-image-history-grid">{versions.map((asset, index) => { const current = asset.image === target.image; return <article className={`segment-image-history-card${current ? ' current' : ''}`} key={asset.id}>{!current && <button className="segment-image-history-delete delete-icon-button" title="删除此版本" aria-label="删除此版本" onClick={() => onDeleteHistory(asset)}><DeleteIcon/></button>}<button className="segment-image-history-preview" onClick={() => openImage(asset.image!)}><img src={asset.image} alt={asset.name}/><span>查看大图</span></button><div className="segment-image-history-meta"><strong>图片 #{versions.length - index}</strong>{current && <em>当前版本</em>}</div><p>{asset.provider || ('type' in target ? target.type : '角色')}{asset.generatedAt ? ` · ${new Date(asset.generatedAt).toLocaleString()}` : ''}</p><button className="btn primary small" disabled={current} onClick={() => { if (target.image && !project.assets.some(item => item.sourceItemId === historyId && item.image === target.image)) registerMedia(project.id, { id: uid(), type: assetType, name: `${target.name} · 恢复前版本`, description: '恢复历史版本时保留的前一版本', mediaKind: 'image', image: target.image, sourceProjectId: project.id, sourceItemId: historyId, generatedAt: Date.now() }); onAccept(asset.image!); setDialog(null); }}>{current ? '正在使用' : '恢复此版本'}</button></article>; })}{!versions.length && <div className="detail-empty">暂无历史图片。生成或编辑后，版本会保存在这里。</div>}</div></Modal>}
  </>;
}

function GalleryImageCard({ project, target, title, subtitle, description, prompt, settingPrompt, dualView = false, characterDualView = false, onName, onDescription, onPrompt, onSettingPrompt, onTurnaroundPrompt, onAccept, onSettingAccept, onTurnaroundAccept, onDelete, onDetails, onLibrary }: { project: Project; target: Character | ArtAsset; title: string; subtitle: string; description: string; prompt: string; settingPrompt?: string; dualView?: boolean; characterDualView?: boolean; onName: (value: string) => void; onDescription: (value: string) => void; onPrompt: (value: string) => void; onSettingPrompt?: (value: string) => void; onTurnaroundPrompt?: (value: string) => void; onAccept: (url: string) => void; onSettingAccept?: (url: string) => void; onTurnaroundAccept?: (url: string) => void; onDelete: () => void; onDetails: () => void; onLibrary: (image?: string, prompt?: string, viewName?: string) => void }) {
  const [view, setView] = useState<'main' | 'setting'>('main');
  const [editingImage, setEditingImage] = useState(false);
  const [uploadingImage, setUploadingImage] = useState(false);
  const uploadController = useRef<AbortController | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [confirmRemoveImage, setConfirmRemoveImage] = useState(false);
  const historyId = view === 'setting' && dualView ? `${target.id}:setting` : view === 'setting' && characterDualView ? `${target.id}:turnaround` : target.id;
  const viewName = characterDualView ? view === 'setting' ? '三视图' : '形象' : dualView ? view === 'setting' ? '设定图' : '主视角' : '形象';
  const image = view === 'setting' && dualView && 'type' in target ? target.settingImage : view === 'setting' && characterDualView && !('type' in target) ? target.turnaroundImage : target.image;
  const activePrompt = view === 'setting' && dualView ? settingPrompt || '' : view === 'setting' && characterDualView && !('type' in target) ? target.imageSheetPrompt || '' : prompt;
  const acceptImage = view === 'setting' && dualView ? onSettingAccept || (() => {}) : view === 'setting' && characterDualView ? onTurnaroundAccept || (() => {}) : onAccept;
  const saveActivePrompt = view === 'setting' && dualView ? onSettingPrompt || onPrompt : view === 'setting' && characterDualView ? onTurnaroundPrompt || onPrompt : onPrompt;
  const history = project.assets.filter(asset => asset.sourceItemId === historyId && asset.image);
  const versions = [...history].sort((a, b) => (b.generatedAt || 0) - (a.generatedAt || 0));
  if (image && !versions.some(asset => asset.image === image)) versions.unshift({ id: `current-${historyId}`, type: 'other', name: title, description: '当前使用中的图片', image, sourceItemId: historyId });
  const openImage = useContext(OpenImage);
  const registerMedia = useContext(RegisterMedia);
  const notify = useContext(Notify);
  async function copyPrompt() { await copyText(activePrompt); }
  async function uploadCardImage(file?: File) {
    if (!file) return;
    if (!(file.type === 'image/png' || file.type === 'image/jpeg' || file.type === 'image/webp') && !/\.(png|jpe?g|webp)$/i.test(file.name)) { notify('仅支持 PNG、JPEG 或 WebP 图片'); return; }
    if (file.size > 20 * 1024 * 1024) { notify('图片不能超过 20 MB'); return; }
    const controller = new AbortController();
    uploadController.current = controller;
    setUploadingImage(true);
    try {
      const { url } = await uploadLibraryMedia(file, 'image', controller.signal);
      const type: AssetType = 'type' in target && (target.type === 'scene' || target.type === 'prop') ? target.type : 'character';
      registerMedia(project.id, { id: uid(), type, name: `${title} · ${viewName}`, description: '卡片上传', mediaKind: 'image', image: url, sourceProjectId: project.id, sourceItemId: historyId, generatedAt: Date.now(), provider: '本机上传' });
      acceptImage(url);
      notify(`已上传「${title}」图片到项目${assetNames[type]}资产`);
    } catch (error) { notify(controller.signal.aborted ? '已取消图片上传' : `上传失败：${(error as Error).message}`); }
    finally { if (uploadController.current === controller) uploadController.current = null; setUploadingImage(false); }
  }
  return <article className="panel gallery-image-card"><div className="gallery-card-top"><span>{viewName}</span><div className="gallery-image-actions"><button className="btn small gallery-history-button" title={`${viewName}图片历史`} onClick={() => setShowHistory(true)}>◷ <span>{versions.length}</span></button><span className="gallery-upload-wrap"><label className={`btn small gallery-upload-image-button${uploadingImage ? ' disabled' : ''}`}>{uploadingImage ? '正在上传…' : '上传图片'}<input type="file" accept="image/png,image/jpeg,image/webp" disabled={uploadingImage} onChange={event => { void uploadCardImage(event.currentTarget.files?.[0]); event.currentTarget.value = ''; }}/></label>{uploadingImage && <button type="button" className="gallery-upload-cancel" title="取消上传" aria-label="取消上传" onClick={() => uploadController.current?.abort()}>×</button>}</span><button className="btn small" onClick={() => setEditingImage(true)}>重新生成</button></div></div><div className={`gallery-card-image${dualView || characterDualView ? ' gallery-card-image-dual' : ''}${characterDualView && view === 'main' ? ' gallery-card-character-appearance' : ''}`}>{(dualView || characterDualView) && <div className="gallery-view-tabs" role="tablist" aria-label={characterDualView ? '角色图片视图' : '美术图片视图'}><button type="button" role="tab" aria-selected={view === 'main'} className={view === 'main' ? 'active' : ''} onClick={() => setView('main')}>{characterDualView ? '形象' : '主视角'}</button><button type="button" role="tab" aria-selected={view === 'setting'} className={view === 'setting' ? 'active' : ''} onClick={() => setView('setting')}>{characterDualView ? '三视图' : '设定图'}</button></div>}{image ? <MediaPicture src={image}/> : <span>尚未生成{viewName}</span>}</div><div className="gallery-card-actions"><button className="btn small" disabled={!image} onClick={() => onLibrary(image, activePrompt, viewName)}>加入资产库</button><ImagePicker value={image} onChange={acceptImage} allowRemove={false}/></div><div className="gallery-card-identity"><GalleryText value={title} onChange={onName} className="gallery-card-name"/><span>{subtitle}</span></div><GalleryText value={description} onChange={onDescription} className="gallery-card-description"/><div className="gallery-card-prompt-label">出图提示词 <button className="copy-prompt-button" onClick={() => void copyPrompt()} title="复制提示词" aria-label="复制提示词"><CopyPromptIcon/></button></div><GalleryText value={activePrompt} onChange={saveActivePrompt} className="gallery-card-prompt"/><div className="gallery-card-bottom"><button onClick={onDetails}>详情</button><button onClick={onDelete}>删除</button></div>{editingImage && <Modal title={`${title} · ${viewName}`} onClose={() => setEditingImage(false)}><MediaGenerator key={historyId} project={project} kind="image" targetId={target.id} historyId={historyId} prompt={activePrompt || description} negativePrompt={'type' in target ? target.negativePrompt : target.imageNegativePrompt} referenceImages={view === 'setting' && (dualView || characterDualView) && target.image ? [target.image] : undefined} source={view === 'setting' && (dualView || characterDualView) ? undefined : image} defaultRatio={characterDualView && view === 'main' ? '9:16' : undefined} onAccept={url => { acceptImage(url); setEditingImage(false); }}/></Modal>}{showHistory && <Modal title={`${viewName}图片历史记录`} onClose={() => setShowHistory(false)}><div className="eyebrow">IMAGE HISTORY</div><p className="muted">重新生成、编辑和恢复都会保留一个版本。恢复只切换当前图片，不会删除其他版本。</p><div className="segment-image-history-grid">{versions.map((asset, index) => { const current = asset.image === image; return <article className={`segment-image-history-card${current ? ' current' : ''}`} key={asset.id}><button className="segment-image-history-preview" onClick={() => openImage(asset.image!)}><img src={asset.image} alt={asset.name}/><span>查看大图</span></button><div className="segment-image-history-meta"><strong>图片 #{versions.length - index}</strong>{current && <em>当前版本</em>}</div><p>{asset.provider || subtitle}{asset.generatedAt ? ` · ${new Date(asset.generatedAt).toLocaleString()}` : ''}</p><button className="btn primary small" disabled={current} onClick={() => { if (image && !project.assets.some(item => item.sourceItemId === historyId && item.image === image)) registerMedia(project.id, { id: uid(), type: 'other', name: `${title} · 恢复前版本`, description: '恢复历史版本时保留的前一版本', mediaKind: 'image', image, sourceProjectId: project.id, sourceItemId: historyId, generatedAt: Date.now() }); acceptImage(asset.image!); setShowHistory(false); }}>{current ? '正在使用' : '恢复此版本'}</button></article>; })}{!versions.length && <div className="detail-empty">暂无历史图片。重新生成或编辑后，版本会保存在这里。</div>}</div></Modal>}{confirmRemoveImage && <Modal title={`移除${viewName}`} onClose={() => setConfirmRemoveImage(false)}><p>确定移除「{title}」当前使用的图片吗？历史版本会保留，可稍后恢复。</p><div className="modal-actions"><button className="btn" onClick={() => setConfirmRemoveImage(false)}>取消</button><button className="btn danger" onClick={() => { acceptImage(''); setConfirmRemoveImage(false); }}>移除图片</button></div></Modal>}</article>;
}

function CastGallery({ project, save, addToLibrary, go }: { project: Project; save: (value: Character[]) => void; addToLibrary: (asset: Asset, projectId: string) => void; go: (path: string) => void }) {
  const [draft, setDraft] = useState(() => clone(project.docs.cast)); useEffect(() => setDraft(clone(project.docs.cast)), [project.docs.cast]);
  const dialogueReport = useScriptDialogueReport(project.id);
  const voiceover = dialogueReport.status === 'ready' ? voiceoverDialogueGroup(dialogueReport.groups) : undefined;
  const [showRelationshipGraph, setShowRelationshipGraph] = useState(false);
  const update = (id: string, key: keyof Character, value: string) => setDraft(items => items.map(item => item.id === id ? { ...item, [key]: value } : item));
  return <>{showRelationshipGraph && <CastRelationshipGraph characters={draft} onClose={() => setShowRelationshipGraph(false)} go={go} projectId={project.id}/>}<PageHeading stage="角色 · CAST" title="角色卡" actions={<div className="inline-actions"><button className="btn" onClick={() => setShowRelationshipGraph(true)}>关系图谱</button><button className="btn primary" onClick={() => save(draft)}>保存角色</button></div>}/><div className="gallery-grid">{draft.map(character => <GalleryImageCard key={character.id} project={project} target={character} title={character.name} subtitle={character.role} description={character.description} prompt={character.imagePrompt || `${character.name}，${character.role}，${character.description}`} onName={value => update(character.id, 'name', value)} onDescription={value => update(character.id, 'description', value)} onPrompt={value => update(character.id, 'imagePrompt', value)} characterDualView onTurnaroundPrompt={value => update(character.id, 'imageSheetPrompt', value)} onAccept={url => save(draft.map(item => item.id === character.id ? { ...item, image: url } : item))} onTurnaroundAccept={url => save(draft.map(item => item.id === character.id ? { ...item, turnaroundImage: url } : item))} onDelete={() => setDraft(items => items.filter(item => item.id !== character.id))} onDetails={() => go(`/p/${project.id}/cast/${encodeURIComponent(character.id)}`)} onLibrary={(image, activePrompt, viewName) => addToLibrary({ id: viewName === '三视图' ? `${character.id}-turnaround` : character.id, type: 'character', name: viewName === '三视图' ? `${character.name} · 三视图` : character.name, description: character.description, prompt: activePrompt || '', image: image || '' }, project.id)}/>)}{voiceover && <article className="panel cast-voiceover-card"><div className="gallery-card-top"><span>台词本 · JSON</span><span className="character-code-badge">VO</span></div><div className="gallery-card-identity"><strong className="gallery-card-name">画外音</strong><span>虚拟角色</span></div><span className="cast-voiceover-meta">{voiceover.metadata}</span><ol>{voiceover.lines.slice(0, 3).map((line, index) => <li key={`${line.reference}-${index}`}><i>{line.reference}</i><span>{line.text}</span></li>)}</ol><div className="gallery-card-bottom"><button type="button" onClick={() => go(`/p/${project.id}/cast/VO`)}>查看台词本 →</button></div></article>}</div><button className="btn" onClick={() => setDraft(items => [...items, { id: uid(), name: '新角色', role: '', description: '', arc: '' }])}>＋ 新增角色</button></>;
}

type CastRelationEdge = { key: string; left: Character; right: Character; descriptions: { character: Character; text: string }[] };

function CastRelationshipGraph({ characters, onClose, go, projectId }: { characters: Character[]; onClose: () => void; go: (path: string) => void; projectId: string }) {
  const [focusedRelationId, setFocusedRelationId] = useState<string | null>(null);
  const [focusedCharacterId, setFocusedCharacterId] = useState<string | null>(null);
  const edgeMap = new Map<string, CastRelationEdge>();
  for (const character of characters) {
    const persona = character.persona || {};
    const relationships = Array.isArray(persona.relationships) ? persona.relationships as { name?: string; relation?: string }[] : Array.isArray(persona.relations) ? persona.relations as { name?: string; relation?: string }[] : [];
    for (const relation of relationships) {
      const targetName = relation.name?.trim();
      const target = characters.find(item => item.id !== character.id && (item.name === targetName || item.aliases?.includes(targetName || '')));
      if (!target) continue;
      const ordered = [character, target].sort((a, b) => a.id.localeCompare(b.id));
      const key = `${ordered[0].id}:${ordered[1].id}`;
      const edge = edgeMap.get(key) || { key, left: ordered[0], right: ordered[1], descriptions: [] };
      if (relation.relation?.trim() && !edge.descriptions.some(item => item.character.id === character.id && item.text === relation.relation!.trim())) edge.descriptions.push({ character, text: relation.relation.trim() });
      edgeMap.set(key, edge);
    }
  }
  const edges = [...edgeMap.values()];
  const degree = new Map<string, number>();
  for (const edge of edges) { degree.set(edge.left.id, (degree.get(edge.left.id) || 0) + 1); degree.set(edge.right.id, (degree.get(edge.right.id) || 0) + 1); }
  const defaultCenter = characters.find(character => /protagonist|主角/i.test(character.role)) || [...characters].sort((a, b) => (degree.get(b.id) || 0) - (degree.get(a.id) || 0))[0];
  const center = defaultCenter;
  const others = characters.filter(character => character.id !== center?.id);
  const positions = new Map<string, { x: number; y: number }>();
  if (center) positions.set(center.id, { x: 370, y: 290 });
  others.forEach((character, index) => {
    const angle = -Math.PI / 2 + (2 * Math.PI * index) / Math.max(others.length, 1);
    positions.set(character.id, { x: 370 + Math.cos(angle) * 265, y: 290 + Math.sin(angle) * 205 });
  });
  const openCharacter = (character: Character) => { onClose(); go(`/p/${projectId}/cast/${encodeURIComponent(character.id)}`); };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return <div className="cast-graph-overlay" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}><section className="cast-graph-dialog" role="dialog" aria-modal="true" aria-label="角色关系图谱"><header className="cast-graph-header"><div><span className="eyebrow">CAST · RELATIONSHIPS</span><h2>关系图谱</h2><p>{characters.length} 位角色 · {edges.length} 组关系</p></div><button className="icon-button" onClick={onClose} aria-label="关闭关系图谱">×</button></header>{edges.length ? <div className="cast-graph-layout"><div className="cast-graph-canvas"><svg viewBox="0 0 740 580" role="img" aria-label="角色之间的关系图"><g className="cast-graph-edges">{edges.map((edge, index) => { const a = positions.get(edge.left.id); const b = positions.get(edge.right.id); if (!a || !b) return null; const bend = (index % 2 ? 1 : -1) * Math.min(36, 12 + edges.length * 1.5); const mx = (a.x + b.x) / 2 + bend; const my = (a.y + b.y) / 2 - bend; const isFocused = edge.key === focusedRelationId || (!!focusedCharacterId && (edge.left.id === focusedCharacterId || edge.right.id === focusedCharacterId)); return <g key={edge.key} className={isFocused ? 'is-focused' : ''}><path d={`M${a.x} ${a.y} Q${mx} ${my} ${b.x} ${b.y}`}/>{edge.descriptions[0] && <text x={mx} y={my} textAnchor="middle"><title>{edge.descriptions.map(item => `${item.character.name}：${item.text}`).join('\n')}</title>{edge.descriptions[0].text.length > 12 ? `${edge.descriptions[0].text.slice(0, 12)}…` : edge.descriptions[0].text}</text>}</g>; })}</g><g className="cast-graph-nodes">{characters.map(character => { const point = positions.get(character.id); if (!point) return null; const lead = character.id === center?.id; const selected = character.id === focusedCharacterId; const radius = lead ? 12 : Math.max(7, Math.min(10, 5 + Math.sqrt(degree.get(character.id) || 0) * 2)); return <g key={character.id} className={`${lead ? 'is-lead ' : ''}${selected ? 'is-selected' : ''}`} role="button" tabIndex={0} aria-label={`以${character.name}为关系图中心`} onClick={() => { setFocusedRelationId(null); setFocusedCharacterId(character.id); }} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setFocusedRelationId(null); setFocusedCharacterId(character.id); } }}><circle className="cast-graph-hit" cx={point.x} cy={point.y} r="24"/><circle className="cast-graph-dot" cx={point.x} cy={point.y} r={radius}/><text x={point.x} y={point.y - radius - 10} textAnchor="middle">{character.name}</text></g>; })}</g></svg></div><aside className="cast-graph-relations"><h3>全部关系</h3><div className="cast-graph-relation-list">{edges.map(edge => <article className={`cast-graph-relation${edge.key === focusedRelationId ? ' is-selected' : ''}`} key={edge.key} onClick={() => { setFocusedCharacterId(null); setFocusedRelationId(edge.key); }}><button type="button" className="cast-graph-relation-focus" aria-pressed={edge.key === focusedRelationId} onClick={() => { setFocusedCharacterId(null); setFocusedRelationId(edge.key); }}><strong>{edge.left.name}<i>—</i>{edge.right.name}</strong></button>{edge.descriptions.map((item, index) => <p key={`${item.character.id}-${index}`}><button type="button" className="cast-graph-character-link" onClick={event => { event.stopPropagation(); openCharacter(item.character); }}>{item.character.name}</button><span>{item.text}</span></p>)}</article>)}</div></aside></div> : <div className="cast-graph-empty">暂时没有可展示的角色关系。请先在角色详情的“关系”栏目中填写角色关系。</div>}</section></div>;
}

function ArtGallery({ project, save, addToLibrary, go }: { project: Project; save: (value: Project['docs']['art']) => void; addToLibrary: (asset: Asset, projectId: string) => void; go: (path: string) => void }) {
  const [draft, setDraft] = useState(() => clone(project.docs.art)); const [filter, setFilter] = useState<'all' | 'scenes' | 'props'>('all'); useEffect(() => setDraft(clone(project.docs.art)), [project.docs.art]);
  const update = (kind: 'scenes' | 'props', id: string, key: keyof ArtAsset, value: string) => setDraft(current => ({ ...current, [kind]: current[kind].map(item => item.id === id ? { ...item, [key]: value } : item) }));
  const rawArt = project.skillArtifacts?.art?.raw as { scenes?: { id?: string; name?: string; image?: { sheet?: unknown } }[]; props?: { id?: string; name?: string; image?: { sheet?: unknown } }[] } | undefined;
  return <><PageHeading stage="美术 · ART" title="美术卡" actions={<button className="btn primary" onClick={() => save(draft)}>保存美术</button>}/><div className="material-tabs">{(['all', 'scenes', 'props'] as const).map(key => <button key={key} className={filter === key ? 'active' : ''} onClick={() => setFilter(key)}>{key === 'all' ? '全部' : key === 'scenes' ? '场景' : '道具'}</button>)}</div><div className="gallery-grid">{(['scenes', 'props'] as const).filter(key => filter === 'all' || filter === key).flatMap(kind => draft[kind].map(asset => { const rawSheet = rawArt?.[kind]?.find(entry => entry.id === asset.id || entry.name === asset.name)?.image?.sheet; const sheetPrompt = asset.settingPrompt ?? (typeof rawSheet === 'string' ? rawSheet : ''); return <GalleryImageCard key={asset.id} project={project} target={asset} title={asset.name} subtitle={kind === 'scenes' ? '场景' : '道具'} description={asset.description} prompt={asset.prompt || `${asset.name}，${asset.description}`} settingPrompt={sheetPrompt} dualView onName={value => update(kind, asset.id, 'name', value)} onDescription={value => update(kind, asset.id, 'description', value)} onPrompt={value => update(kind, asset.id, 'prompt', value)} onSettingPrompt={value => update(kind, asset.id, 'settingPrompt', value)} onAccept={url => { const next = { ...draft, [kind]: draft[kind].map(item => item.id === asset.id ? { ...item, image: url } : item) }; setDraft(next); save(next); }} onSettingAccept={url => { const next = { ...draft, [kind]: draft[kind].map(item => item.id === asset.id ? { ...item, settingImage: url } : item) }; setDraft(next); save(next); }} onDelete={() => setDraft(current => ({ ...current, [kind]: current[kind].filter(item => item.id !== asset.id) }))} onDetails={() => go(`/p/${project.id}/art/${kind}/${encodeURIComponent(asset.id)}`)} onLibrary={() => addToLibrary(asset, project.id)}/>; }))}</div><div className="inline-actions">{filter !== 'props' && <button className="btn" onClick={() => setDraft(current => ({ ...current, scenes: [...current.scenes, { id: uid(), type: 'scene', name: '新场景', description: '' }] }))}>＋ 新增场景</button>}{filter !== 'scenes' && <button className="btn" onClick={() => setDraft(current => ({ ...current, props: [...current.props, { id: uid(), type: 'prop', name: '新道具', description: '' }] }))}>＋ 新增道具</button>}</div></>;
}

async function detectImageRatio(source: string | undefined, fallback: ImageRatio): Promise<ImageRatio> {
  if (!source) return fallback;
  const dimensions = await new Promise<{ width: number; height: number }>((resolve, reject) => {
    const image = new Image(); image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight }); image.onerror = () => reject(new Error('无法读取参考图画幅。')); image.src = source;
  }).catch(() => null);
  if (!dimensions?.width || !dimensions.height) return fallback;
  const aspect = dimensions.width / dimensions.height;
  return IMAGE_RATIOS.reduce((best, value) => Math.abs(Math.log(ratioValue(value) / aspect)) < Math.abs(Math.log(ratioValue(best) / aspect)) ? value : best, IMAGE_RATIOS[0]);
}
function ratioValue(ratio: ImageRatio) { const [width, height] = ratio.split(':').map(Number); return width / height; }

function MediaGenerator({ project, kind, targetId, prompt, negativePrompt, source, duration, onAccept, videoSources, cutPoints, segmentMode = false, referenceImages, historyId, defaultRatio, onJobStatusChange, videoTitle, videoWorkflow }: { project: Project; kind: 'image' | 'video'; targetId: string; prompt: string; negativePrompt?: string; source?: string; duration?: number; onAccept: (url: string, usedPrompt?: string) => void; videoSources?: string[]; cutPoints?: number[]; segmentMode?: boolean; referenceImages?: string[]; historyId?: string; defaultRatio?: ImageRatio; onJobStatusChange?: (job: MediaJob | null) => void; videoTitle?: string; videoWorkflow?: 'firstLast' }) {
  const storageKey = `reelbench-media-${project.id}-${kind}-${historyId || targetId}`;
  const [job, setJob] = useState<MediaJob | null>(null);
  const [error, setError] = useState('');
  const referenceImagesKey = (kind === 'video' ? videoSources : referenceImages)?.join('\n');
  const [references, setReferences] = useState<string[]>(kind === 'video' && videoSources?.length ? videoSources : referenceImages?.length ? referenceImages : source ? [source] : []);
  const [draftPrompt, setDraftPrompt] = useState(prompt);
  const [draftNegativePrompt, setDraftNegativePrompt] = useState(negativePrompt || '');
  const [promptEdited, setPromptEdited] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [provider, setProvider] = useState<'qwen' | 'gpt' | 'chatgpt'>('qwen');
  const [videoDialogOpen, setVideoDialogOpen] = useState(false);
  const [videoResolution, setVideoResolution] = useState<480 | 720 | 1080>(480);
  const [imageRatio, setImageRatio] = useState<ImageRatio | 'adaptive'>(defaultRatio || project.ratio);
  const [ratioPickerOpen, setRatioPickerOpen] = useState(false);
  const ratioPickerRef = useRef<HTMLDivElement>(null);
  const [imageStyle, setImageStyle] = useState(project.style);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const [referenceMention, setReferenceMention] = useState<{ start: number; end: number; query: string; left: number; top: number } | null>(null);
  const deletedImages = useContext(DeletedImages);
  const registerMedia = useContext(RegisterMedia);
  const [chooseReference, setChooseReference] = useState(false);
  useEffect(() => { if (kind !== 'image') return; let active = true; getSettings().then(s => { if (active) setProvider(s.imageProvider); }).catch(() => {}); return () => { active = false; }; }, [kind]);
  useEffect(() => { setReferences(referenceImagesKey ? referenceImagesKey.split('\n') : source ? [source] : []); setDraftPrompt(prompt); setDraftNegativePrompt(negativePrompt || ''); setImageRatio(defaultRatio || project.ratio); setImageStyle(project.style); setPromptEdited(false); }, [project.id, targetId, kind, referenceImagesKey, negativePrompt, defaultRatio, project.ratio, project.style]);
  useEffect(() => {
    if (kind !== 'image' || !promptRef.current) return;
    const textarea = promptRef.current;
    textarea.style.height = 'auto';
    const maxHeight = Math.floor(window.innerHeight * 0.55);
    textarea.style.height = `${Math.min(textarea.scrollHeight, maxHeight)}px`;
    textarea.style.overflowY = textarea.scrollHeight > maxHeight ? 'auto' : 'hidden';
  }, [draftPrompt, kind]);
  useEffect(() => {
    if (!ratioPickerOpen) return;
    const closeOnOutsideClick = (event: PointerEvent) => { if (!ratioPickerRef.current?.contains(event.target as Node)) setRatioPickerOpen(false); };
    document.addEventListener('pointerdown', closeOnOutsideClick);
    return () => document.removeEventListener('pointerdown', closeOnOutsideClick);
  }, [ratioPickerOpen]);
  useEffect(() => { if (!promptEdited) setDraftPrompt(prompt); }, [prompt, promptEdited]);
  useEffect(() => { const id = sessionStorage.getItem(storageKey); if (id) getMediaJob(id).then(setJob).catch(e => { if (/不存在|重启/.test((e as Error).message)) { sessionStorage.removeItem(storageKey); setJob(null); setError('服务已重启，原任务已失效，请重新提交。'); } else setError((e as Error).message); }); }, [storageKey]);
  useEffect(() => { if (!job || !['queued', 'running'].includes(job.status)) return; const timer = window.setInterval(() => getMediaJob(job.id).then(next => { setJob(current => current?.id === next.id && current.status !== 'cancelled' ? next : current); setError(''); }).catch(e => { if (/不存在|重启/.test((e as Error).message)) { sessionStorage.removeItem(storageKey); setJob(null); setError('服务已重启，原任务已失效，请重新提交。'); } else setError((e as Error).message); }), 1600); return () => clearInterval(timer); }, [job?.id, job?.status, storageKey]);
  useEffect(() => { onJobStatusChange?.(job); }, [job, onJobStatusChange]);
  async function start() {
    setError('');
    if (kind === 'video' && references.some(reference => deletedImages.includes(imageKey(reference)))) return setError('分镜首帧已被删除，请先更换图片。');
    if (kind === 'image' && references.some(reference => deletedImages.includes(imageKey(reference)))) return setError('所选参考图已被删除，请更换参考图。');
    if (kind === 'image' && references.length > 8) return setError('最多选择 8 张参考图。');
    if (kind === 'image') {
      const usedNumbers = [...draftPrompt.matchAll(/@(?:参考图|图)(\d+)|<image(\d+)>/g)].map(match => Number(match[1] || match[2]));
      const invalidNumber = usedNumbers.find(number => number < 1 || number > references.length);
      if (invalidNumber) return setError(`提示词引用了参考图 ${invalidNumber}，但当前只选择了 ${references.length} 张。请调整引用或添加对应图片。`);
    }
    const useFirstLastWorkflow = videoWorkflow === 'firstLast' && references.length === 2;
    if (kind === 'video' && (!references.length || (!segmentMode && videoWorkflow !== 'firstLast' && project.docs.storyboard.shots.find(shot => shot.id === targetId)?.image !== references[0]))) return setError('请先保存分镜图片，再生成视频。');
    if (kind === 'video' && (!duration || duration < 1 || duration > 15)) return setError('MiniMax H3 单镜时长应为 1–15 秒。');
    if (kind === 'video' && (!draftPrompt.trim() || references.length > 8)) return setError('请填写提示词，并选择 1–8 张参考图。');
    const submittedCuts = kind === 'video' && cutPoints ? references.map(reference => cutPoints[(videoSources || [source!]).indexOf(reference)]) : undefined;
    if (submittedCuts && (submittedCuts[0] !== 0 || submittedCuts.some((time, index) => !Number.isFinite(time) || time < 0 || time >= duration! || (index > 0 && time <= submittedCuts[index - 1])))) return setError('当前切点工作流需要参考图对应原镜头，并按时间顺序排列，第一张须对应 0 秒。');
    setPreparing(true);
    try {
      const cleanPrompt = draftPrompt.trim().replace(/@(?:参考图|图)(\d+)/g, (_match, number: string) => provider === 'qwen' ? `<image${number}>` : `第 ${number} 张参考图`);
      const positivePrompt = kind === 'image' ? (project.docs.storyboard.shots.some(shot => shot.id === targetId) ? cleanPrompt : `${cleanPrompt}\n画风:${imageStyle}`) : draftPrompt.trim();
      const effectiveRatio = (kind === 'image' && imageRatio === 'adaptive' ? await detectImageRatio(references[0], project.ratio) : kind === 'image' ? imageRatio : project.ratio) as ImageRatio;
      const started = await createMediaJob({ projectId: project.id, kind, provider: kind === 'image' ? provider : undefined, imageMode: kind === 'image' ? (project.docs.storyboard.shots.some(shot => shot.id === targetId) ? 'compose' : 'edit') : undefined, prompt: positivePrompt, negativePrompt: kind === 'image' ? draftNegativePrompt.trim() : undefined, source: kind === 'video' ? references[0] : kind === 'image' && provider === 'qwen' ? references[0] : undefined, sources: references, videoWorkflow: kind === 'video' && useFirstLastWorkflow ? 'firstLast' : undefined, cutPoints: submittedCuts, duration, videoResolution: kind === 'video' ? videoResolution : undefined, ratio: effectiveRatio });
      setJob(started); sessionStorage.setItem(storageKey, started.id);
    }
    catch (e) { setError((e as Error).message); }
    finally { setPreparing(false); }
  }
  function updatePrompt(value: string, caret: number, textarea: HTMLTextAreaElement) {
    setDraftPrompt(value); setPromptEdited(true);
    const at = value.lastIndexOf('@', Math.max(0, caret - 1));
    if (at < 0 || !references.length || /[\s@]/.test(value.slice(at + 1, caret))) { setReferenceMention(null); return; }
    const mirror = document.createElement('div'); const marker = document.createElement('span'); const style = window.getComputedStyle(textarea);
    const textareaRect = textarea.getBoundingClientRect();
    Object.assign(mirror.style, { position: 'fixed', left: `${textareaRect.left}px`, top: `${textareaRect.top}px`, visibility: 'hidden', width: `${textarea.clientWidth}px`, boxSizing: style.boxSizing, padding: style.padding, border: style.border, font: style.font, letterSpacing: style.letterSpacing, lineHeight: style.lineHeight, textIndent: style.textIndent, whiteSpace: 'pre-wrap', overflowWrap: 'break-word', wordBreak: 'break-word' });
    mirror.textContent = value.slice(0, caret); marker.textContent = '\u200b'; mirror.append(marker); document.body.append(mirror); mirror.scrollTop = textarea.scrollTop;
    const caretRect = marker.getBoundingClientRect(); const wrapperRect = textarea.parentElement!.getBoundingClientRect(); const menuWidth = Math.min(340, window.innerWidth - 32);
    const left = Math.max(8, Math.min(caretRect.left - wrapperRect.left, wrapperRect.width - menuWidth - 8));
    const top = Math.min(caretRect.bottom - wrapperRect.top + 5, wrapperRect.height - 44);
    mirror.remove();
    setReferenceMention({ start: at, end: caret, query: value.slice(at + 1, caret).replace(/^(?:参考图|图)/, ''), left, top });
  }
  function insertReferenceMention(index: number) {
    if (!referenceMention) return;
    const token = `@参考图${index + 1} `;
    const next = `${draftPrompt.slice(0, referenceMention.start)}${token}${draftPrompt.slice(referenceMention.end)}`;
    const caret = referenceMention.start + token.length;
    setDraftPrompt(next); setPromptEdited(true); setReferenceMention(null);
    requestAnimationFrame(() => { promptRef.current?.focus(); promptRef.current?.setSelectionRange(caret, caret); });
  }
  function close() { sessionStorage.removeItem(storageKey); setJob(null); }
  async function cancel() { if (!job || cancelling) return; setCancelling(true); setError(''); try { await cancelMediaJob(job.id); close(); } catch (e) { setError(`取消失败：${(e as Error).message}`); } finally { setCancelling(false); } }
  async function discard() { if (job?.status === 'completed') { try { await discardMediaJob(job.id); } catch (e) { setError((e as Error).message); return; } } close(); }
  function acceptResult() {
    if (!job?.result) return;
    const url = job.result.url;
    const character = project.docs.cast.find(item => item.id === targetId);
    const art = [...project.docs.art.scenes, ...project.docs.art.props].find(item => item.id === targetId);
    const shot = project.docs.storyboard.shots.find(item => item.id === targetId);
    const type: AssetType = character ? 'character' : art?.type || (shot && kind === 'image' ? 'storyboard' : 'other');
    const name = character?.name || art?.name || (shot ? `分镜 · ${shot.scene}` : '生成媒体');
    onAccept(url, job.result.prompt);
    registerMedia(project.id, { id: uid(), type, name: kind === 'video' ? `${name} · 视频` : name, description: job.result.prompt, mediaKind: kind, sourceItemId: historyId || targetId, generatedAt: job.result.generatedAt, provider: kind === 'image' ? provider : 'minimax_h3', ...(kind === 'image' ? { image: url } : { video: url }) });
    close();
    setVideoDialogOpen(false);
  }
  const composer = <div className={kind === 'image' ? 'media-generator image-composer' : 'media-generator'}>{kind === 'image' && <><div className="image-composer-references"><button className="btn small" disabled={references.length >= 8} onClick={() => setChooseReference(true)}>＋ 参考图 {references.length}/8</button><div className="image-composer-thumbnails">{references.map((reference, index) => <div className="reference-preview" key={reference}><MediaPicture src={reference}/><span className="reference-preview-index">{index + 1}</span><button className="reference-preview-remove" onClick={() => { setReferences(current => current.filter(item => item !== reference)); setReferenceMention(null); }} title="移除参考图" aria-label={`移除第 ${index + 1} 张参考图`}>×</button></div>)}</div></div><div className="image-composer-prompt-wrap"><textarea ref={promptRef} className="image-composer-prompt" aria-label="生图提示词" placeholder="描述想要生成的画面… 输入 @ 可引用参考图" maxLength={8000} value={draftPrompt} onChange={e => updatePrompt(e.target.value, e.target.selectionStart, e.currentTarget)} onClick={e => updatePrompt(draftPrompt, e.currentTarget.selectionStart, e.currentTarget)} onKeyUp={e => updatePrompt(draftPrompt, e.currentTarget.selectionStart, e.currentTarget)}/>{referenceMention && <div className="reference-mention-menu" style={{ left: referenceMention.left, top: referenceMention.top }} role="listbox" aria-label="选择参考图">{references.map((reference, index) => <button key={reference} type="button" role="option" onMouseDown={e => e.preventDefault()} onClick={() => insertReferenceMention(index)}><img src={reference} alt=""/><span>参考图 {index + 1}</span><small>@参考图{index + 1}</small></button>)}</div>}</div>{negativePrompt !== undefined && <label className="image-composer-negative-wrap"><span>反向提示词</span><textarea aria-label="反向提示词" className="image-composer-negative-prompt" placeholder="填写不希望出现在图片中的内容…" value={draftNegativePrompt} onChange={event => setDraftNegativePrompt(event.target.value)}/></label>}<div className="image-composer-footer"><select aria-label="生图模型" value={provider} onChange={e => setProvider(e.target.value as 'qwen' | 'gpt' | 'chatgpt')}><option value="qwen">Qwen-Image-2.1 · 本机</option><option value="gpt">GPT Image 2.5 · API</option><option value="chatgpt">ChatGPT · 网页</option></select><div className="ratio-picker" ref={ratioPickerRef} onKeyDown={event => { if (event.key === 'Escape') setRatioPickerOpen(false); }}><button type="button" className="ratio-picker-trigger" aria-label={`Aspect ratio: ${imageRatio}`} aria-haspopup="listbox" aria-expanded={ratioPickerOpen} onClick={() => setRatioPickerOpen(open => !open)}><span className="ratio-preview-icon"><i style={(() => { const [w, h] = imageRatio === 'adaptive' ? [16, 12] : imageRatio.split(':').map(Number); const scale = Math.min(22 / w, 13 / h); return { width: w * scale, height: h * scale }; })()}/></span><span>{imageRatio === 'adaptive' ? '自适应' : imageRatio}</span></button>{ratioPickerOpen && <div className="ratio-picker-menu" role="listbox" aria-label="比例"><div className="ratio-picker-title">比例</div><div className="ratio-picker-grid">{(['adaptive', ...IMAGE_RATIOS] as const).map(value => { const [w, h] = value === 'adaptive' ? [16, 12] : value.split(':').map(Number); const scale = Math.min(22 / w, 13 / h); return <button type="button" role="option" aria-selected={imageRatio === value} className={`ratio-picker-option${imageRatio === value ? ' selected' : ''}`} key={value} onClick={() => { setImageRatio(value); setRatioPickerOpen(false); }}><span className="ratio-preview-icon"><i style={{ width: w * scale, height: h * scale }}/></span><span>{value === 'adaptive' ? '自适应' : value}</span></button>; })}</div></div>}</div><ImageStylePicker value={imageStyle} onChange={setImageStyle}/><button className="btn primary small" disabled={!!job || preparing || !draftPrompt.trim()} onClick={start}>{preparing ? '提交任务…' : '↑ 生图'}</button></div></>}
    {kind === 'video' && <><div className="image-composer-references"><button className="btn small" disabled={!!job || preparing || references.length >= (videoWorkflow === 'firstLast' ? 2 : 8)} onClick={() => setChooseReference(true)}>＋ {videoWorkflow === 'firstLast' ? '添加参考图' : '参考图'} {references.length}/{videoWorkflow === 'firstLast' ? 2 : 8}</button><div className="image-composer-thumbnails">{references.map((reference, index) => <div className="reference-preview" key={reference} draggable={!job && !preparing} onDragStart={event => event.dataTransfer.setData('text/plain', String(index))} onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); if (job || preparing) return; const from = Number(event.dataTransfer.getData('text/plain')); if (!Number.isInteger(from) || from < 0 || from >= references.length) return; setReferences(current => { const next = [...current]; const [moved] = next.splice(from, 1); next.splice(index, 0, moved); return next; }); }}><MediaPicture src={reference}/><span className="reference-preview-index">{index + 1}</span><button className="reference-preview-remove" disabled={!!job || preparing} onClick={() => setReferences(current => current.filter(item => item !== reference))} aria-label={`移除第 ${index + 1} 张参考图`}>×</button></div>)}</div></div><textarea className="video-composer-prompt" aria-label="生视频提示词" maxLength={8000} value={draftPrompt} disabled={!!job || preparing} onChange={event => { setDraftPrompt(event.target.value); setPromptEdited(true); }}/><div className="video-composer-footer"><span>MiniMax H3</span>{videoWorkflow === 'firstLast' && <span>{references.length === 2 ? '首尾帧图生视频' : '图片生视频'}</span>}<span>{project.ratio}</span><span>{duration}s</span><select aria-label="MiniMax H3 分辨率" title="生成分辨率" value={videoResolution} onChange={event => setVideoResolution(Number(event.target.value) as 480 | 720 | 1080)} disabled={!!job || preparing}><option value={480}>480p</option><option value={720}>720p</option><option value={1080}>1080p</option></select><button className="btn small" disabled={!!job || preparing} onClick={start}>{preparing ? '正在提交…' : job?.status === 'queued' ? '排队中…' : job?.status === 'running' ? '生成中…' : '↑ 生视频'}</button></div></>}
    {job && (job.status === 'queued'
      ? <div className="media-job media-job-queued" role="status"><div className="media-job-status-copy"><strong>正在排队</strong><span>{job.queueType === 'comfyui' ? 'ComfyUI 队列' : '其它生成队列'} · 第 {job.queuePosition || 1} 位</span></div><button className="btn small" disabled={cancelling} onClick={() => void cancel()}>{cancelling ? '正在取消…' : '取消任务'}</button></div>
      : job.status === 'running'
        ? <div className="media-job media-job-loading" role="status" aria-label={job.message || '正在生成'}><span className="media-spinner" aria-hidden="true"/><div className="media-job-status-copy"><strong>{job.message?.includes('提交') ? '正在提交任务' : '正在生成中'}</strong><span>{job.message || (kind === 'video' ? 'MiniMax H3 正在生成视频…' : '图片模型正在生成…')}</span></div><button className="btn small" disabled={cancelling} onClick={() => void cancel()}>{cancelling ? '正在取消…' : '取消任务'}</button></div>
        : <div className="media-job">{job.status === 'failed' && <><p className="field-error">{job.error || job.message || '生成失败'}</p><button className="btn small" onClick={close}>关闭</button></>}{job.status === 'completed' && job.result && <>{kind === 'image' ? <MediaPicture src={job.result.url}/> : <MediaClip src={job.result.url} showDownload={false}/>}<div className="inline-actions"><MediaDownload src={job.result.url} kind={kind}/><button className="btn small" onClick={() => void discard()}>放弃</button><button className="btn primary small" onClick={acceptResult}>确认保存</button></div></>}</div>)}
    {chooseReference && <ImageChooser currentOnly={kind === 'video'} maxSelection={videoWorkflow === 'firstLast' ? 2 : 8} project={project} selected={references} onSelectionChange={setReferences} onClose={() => setChooseReference(false)}/>}{error && <small className="field-error">{error}</small>}</div>;
  const buttonJobStatus = job?.status === 'queued' || job?.status === 'running' || job?.status === 'completed' ? job.status : null;
  const buttonStatusText = buttonJobStatus === 'queued' ? `排队中${job?.queuePosition ? ` · 队列第 ${job.queuePosition} 位` : ''}` : buttonJobStatus === 'running' ? '正在生成' : buttonJobStatus === 'completed' ? '已生成，待确认保存' : '';
  return kind === 'video' ? <><button className="btn small segment-shot-regenerate-button" title={buttonStatusText || 'MiniMax H3 生视频'} aria-label={`MiniMax H3 生视频${buttonStatusText ? `，${buttonStatusText}` : ''}`} onClick={() => setVideoDialogOpen(true)}>MiniMax H3 生视频{buttonJobStatus && <span className={`segment-shot-job-dot ${buttonJobStatus}`} aria-hidden="true"/>}</button>{videoDialogOpen && <Modal title={videoTitle || '生成视频'} onClose={() => { setVideoDialogOpen(false); setChooseReference(false); }}><div className="video-composer image-composer">{composer}</div></Modal>}</> : composer;
}
function MediaPicture({ src }: { src: string }) { const [missing, setMissing] = useState(false); const deleted = useContext(DeletedImages).includes(imageKey(src)); const open = useContext(OpenImage); useEffect(() => setMissing(false), [src]); return deleted ? <span className="media-missing">已被删除</span> : missing ? <span className="media-missing">本机图片文件不可用</span> : <button className="zoomable-image" onClick={() => open(src)} title="点击放大图片"><img src={src} alt="项目图片" onError={() => setMissing(true)}/></button>; }
function MediaClip({ src, showDownload = true }: { src: string; showDownload?: boolean }) { const [missing, setMissing] = useState(false); const deleted = useContext(DeletedImages).includes(imageKey(src)); const open = useContext(OpenVideo); useEffect(() => setMissing(false), [src]); return deleted ? <div className="media-missing">已被删除</div> : missing ? <div className="media-missing">本机视频文件不可用</div> : <div className="media-clip"><button className="media-clip-open" onClick={() => open(src)} title="点击按原始比例播放视频"><video className="shot-video" src={src} muted playsInline preload="metadata" onError={() => setMissing(true)}/><span>▶ 点击播放</span></button>{showDownload && <MediaDownload src={src} kind="video"/>}</div>; }
function ImageChooser({ project, onSelect, selected, onSelectionChange, onAssetSelectionChange, onClose, currentOnly = false, maxSelection = 8 }: { currentOnly?: boolean; maxSelection?: number; project?: Project; onSelect?: (url: string) => void; selected?: string[]; onSelectionChange?: (urls: string[]) => void; onAssetSelectionChange?: (assets: Asset[]) => void; onClose: () => void }) {
  const globalAssets = useContext(LibraryContext); const deleted = useContext(DeletedImages);
  const [tab, setTab] = useState<'project' | 'global'>(project ? 'project' : 'global');
  const [category, setCategory] = useState<AssetType | 'all'>('all');
  const [query, setQuery] = useState('');
  const [unavailable, setUnavailable] = useState<string[]>([]);
  const projectAssets = project ? [...(project.assets || []), ...project.referenceImages.map((image, i) => ({ id: `reference-${i}`, type: 'other' as const, name: `创作参考图 ${i + 1}`, description: '', image }))] : [];
  const currentImages = new Set(project ? [...project.referenceImages, ...project.docs.cast.flatMap(item => [item.image, item.turnaroundImage, ...(item.states || []).map(state => state.image)]), ...[...project.docs.art.scenes, ...project.docs.art.props].flatMap(item => [item.image, item.settingImage, ...(item.states || []).map(state => state.image)]), ...project.docs.storyboard.shots.map(shot => shot.image)] : []);
  const currentAssets = [...currentImages].filter((image): image is string => !!image).map((image, index) => projectAssets.find(asset => asset.image === image) || { id: `current-reference-${index}`, type: 'other' as const, name: `当前项目图片 ${index + 1}`, description: '', image });
  const selectableAssets = [...projectAssets, ...globalAssets, ...currentAssets];
  const available = [...new Map((currentOnly ? currentAssets : tab === 'project' ? projectAssets : globalAssets).filter(a => a.image && !deleted.includes(imageKey(a.image)) && !unavailable.includes(a.image)).map(a => [a.image, a])).values()];
  const counts = { all: available.length, character: available.filter(a => a.type === 'character').length, scene: available.filter(a => a.type === 'scene').length, prop: available.filter(a => a.type === 'prop').length, storyboard: available.filter(a => a.type === 'storyboard').length, other: available.filter(a => a.type === 'other').length };
  const visible = available.filter(a => (category === 'all' || a.type === category) && `${a.name} ${a.description}`.toLowerCase().includes(query.toLowerCase()));
  return <Modal title="选择图片" onClose={onClose}><div className="filter-tabs image-chooser-tabs">{project && <button className={tab === 'project' ? 'active' : ''} onClick={() => setTab('project')}>项目资产库</button>}{!currentOnly && <button className={tab === 'global' ? 'active' : ''} onClick={() => setTab('global')}>全局资产库</button>}</div><div className="image-chooser-filters"><AssetFilter value={category} onChange={setCategory} counts={counts}/><input className="search-input" placeholder="搜索图片…" value={query} onChange={e => setQuery(e.target.value)}/></div><div className="image-chooser-grid">{visible.map(a => { const isSelected = !!selected?.includes(a.image!); return <button key={a.id} className={isSelected ? 'selected' : ''} aria-pressed={selected ? isSelected : undefined} disabled={!!selected && !isSelected && selected.length >= maxSelection} onClick={() => { if (selected && onSelectionChange) { const next = isSelected ? selected.filter(url => url !== a.image) : [...selected, a.image!]; const selectedAssets = next.map(url => selectableAssets.find(asset => asset.image === url) || { id: `reference-${url}`, type: 'other' as const, name: '引用图片', description: '', image: url }); if (onAssetSelectionChange) onAssetSelectionChange(selectedAssets); else onSelectionChange(next); } else { onSelect?.(a.image!); onClose(); } }}><img src={a.image} alt={a.name} onError={() => setUnavailable(v => v.includes(a.image!) ? v : [...v, a.image!])}/><span>{a.name}</span>{isSelected && <b className="image-chooser-selected">✓</b>}</button>; })}</div>{!visible.length && <p className="muted">没有符合条件的图片。</p>}{selected && <p className="image-chooser-count">已选择 {selected.length}/{maxSelection} 张参考图</p>}<div className="modal-actions"><button className="btn" onClick={onClose}>{selected ? '完成' : '关闭'}</button></div></Modal>;
}
function ImagePicker({ value, onChange, allowRemove = true }: { value?: string; onChange: (value: string) => void; allowRemove?: boolean }) { const [open, setOpen] = useState(false); const project = useContext(CurrentProject); return <div className="image-picker"><button className="btn small" onClick={() => setOpen(true)}>{value ? '从资产库更换图片' : '从资产库选择图片'}</button>{value && allowRemove && <button className="text-button" onClick={() => onChange('')}>移除图片</button>}{open && <ImageChooser project={project} onSelect={onChange} onClose={() => setOpen(false)}/>}</div>; }

function StoryboardPage({ project, save, go }: { project: Project; save: (value: Project['docs']['storyboard']) => void; go: (path: string) => void }) {
  const episodes = Array.from({ length: Math.max(project.docs.script.episodes.length, project.docs.outline.episodes.length, ...project.docs.storyboard.shots.map(shot => shot.episode || 1), 0) }, (_, index) => index + 1);
  const shots = project.docs.storyboard.shots;
  function addShot(episode: number, segment: string) {
    const next = clone(project.docs.storyboard);
    const shot: Shot = { id: uid(), scene: '新场景', framing: '中景', action: '', duration: 4, episode, segmentId: segment };
    next.shots.push(shot);
    save(next);
    go(`/p/${project.id}/storyboard/${episode}/${encodeURIComponent(segment)}`);
  }
  return <section className="storyboard-episode-list">
    <div className="storyboard-list-heading"><div><h2>分集与分段</h2><p>选择分段进入提示词、镜头图片与视频制作。</p></div></div>
    {episodes.map(episode => {
      const episodeShots = shots.filter(shot => (shot.episode || 1) === episode);
      const segments = Array.from(new Set(episodeShots.map(shot => shot.segmentId || '未分段')));
      const seconds = episodeShots.reduce((sum, shot) => sum + shot.duration, 0);
      const target = project.docs.script.episodes[episode - 1]?.duration;
      return <section className="panel storyboard-episode-row" key={episode}>
        <div className="storyboard-episode-row-head"><button className="storyboard-episode-title" onClick={() => go(`/p/${project.id}/storyboard/${episode}`)}>第 {episode} 集 <span>本集总表 →</span></button><div><b>{seconds.toFixed(1)}s</b><small> / {target || '—'}s · {segments.length} 段 · {episodeShots.length} 镜</small></div></div>
        {segments.length ? <div className="storyboard-segment-list">{segments.map((segment, segmentIndex) => {
          const group = episodeShots.filter(shot => (shot.segmentId || '未分段') === segment);
          const duration = group.reduce((sum, shot) => sum + shot.duration, 0);
          return <article className="storyboard-segment-row" key={segment}>
            <button className="storyboard-segment-link" onClick={() => go(`/p/${project.id}/storyboard/${episode}/${encodeURIComponent(segment)}`)}>
              <div className="storyboard-segment-thumbs">{group.slice(0, 3).map((shot, index) => <span key={shot.id}>{shot.image ? <img src={shot.image} alt={`第 ${index + 1} 镜`}/> : String(index + 1).padStart(2, '0')}</span>)}{group.length > 3 && <span className="storyboard-thumb-more">+{group.length - 3}</span>}</div>
              <span className="storyboard-segment-copy"><strong>{segment === '未分段' ? `未分段镜头 · ${segmentIndex + 1}` : segment}</strong><small>{group[0]?.scene || '尚未填写场景'} · {group[0]?.framing || '景别待定'}</small></span>
              <span className="storyboard-segment-metrics">{duration.toFixed(1)}s · {group.length} 镜</span><b>→</b>
            </button>
            <button className="storyboard-add-to-segment" onClick={() => addShot(episode, segment)}>＋ 镜头</button>
          </article>;
        })}</div> : <div className="storyboard-empty-episode"><span>这一集还没有镜头</span><button className="btn small" onClick={() => addShot(episode, 'S01')}>创建第一个镜头</button></div>}
      </section>;
    })}
    {!episodes.length && <div className="empty-state"><h2>还没有分镜分集</h2><p>先在剧本中新增分集。</p></div>}
  </section>;
}
type DiffRow = { path: string[]; kind: 'added' | 'removed' | 'changed'; before: string; after: string };
const diffFieldNames: Record<string, string> = { id: '编号', name: '名称', title: '标题', role: '角色定位', description: '简介', arc: '人物弧光', image: '图片', imagePrompt: '出图提示词', prompt: '提示词', scene: '场景', framing: '景别', action: '动作', duration: '时长', camera: '运镜', episode: '集数', segmentId: '分段', location: '地点', lighting: '光线', beats: '节拍', flow: '对白与动作', line: '台词', speaker: '说话人', delivery: '表演提示', seconds: '秒数', summary: '梗概', hook: '钩子', ending: '断点', core: '核心设定', retain: '保留内容', cut: '删减内容', merge: '合并内容', risks: '风险', scenes: '场景', props: '道具', characters: '角色', states: '状态', anchors: '锚点', negativePrompt: '负面提示词', style: '画风', scale: '尺度', primary: '主要场景' };
function diffValue(value: unknown): string { if (value === undefined) return '（无）'; if (typeof value === 'string') return value || '（空）'; if (value === null) return 'null'; if (typeof value !== 'object') return String(value); return JSON.stringify(value, null, 2); }
function diffItemName(collection: string, item: unknown, index: number): string {
  const value = item && typeof item === 'object' ? item as Record<string, unknown> : null;
  if (!value) return `第 ${index + 1} 项`;
  const identity = String(value.name || value.title || value.sceneId || value.id || value.scene || '');
  if (!collection && typeof value.role === 'string') return `角色「${String(value.name || identity)}」`;
  if (!collection && value.type === 'scene') return `场景「${String(value.name || identity)}」`;
  if (!collection && value.type === 'prop') return `道具「${String(value.name || identity)}」`;
  if (!collection && typeof value.duration === 'number' && value.scene) return `镜头 ${index + 1} · ${String(value.scene)}`;
  if (collection === 'episodes') return `第 ${index + 1} 集${identity ? ` · ${identity}` : ''}`;
  if (collection === 'scenes') return `场次 ${index + 1}${identity ? ` · ${identity}` : ''}`;
  if (collection === 'beats' || collection === 'flow') return `节拍 ${index + 1}`;
  if (collection === 'shots') return `镜头 ${index + 1}${identity ? ` · ${identity}` : ''}`;
  if (collection === 'cast' || collection === 'characters') return `角色「${identity || `第 ${index + 1} 项`}」`;
  if (collection === 'props') return `道具「${identity || `第 ${index + 1} 项`}」`;
  if (collection === 'anchors') return `锚点「${identity || `第 ${index + 1} 项`}」`;
  if (collection === 'states') return `状态「${identity || `第 ${index + 1} 项`}」`;
  return identity ? `「${identity}」` : `第 ${index + 1} 项`;
}
function collectDiff(before: unknown, after: unknown, path: string[] = []): DiffRow[] {
  if (JSON.stringify(before) === JSON.stringify(after)) return [];
  if (before && after && typeof before === 'object' && typeof after === 'object' && !Array.isArray(before) && !Array.isArray(after)) {
    const left = before as Record<string, unknown>; const right = after as Record<string, unknown>;
    return [...new Set([...Object.keys(left), ...Object.keys(right)])].flatMap(key => collectDiff(left[key], right[key], [...path, key]));
  }
  if (Array.isArray(before) && Array.isArray(after)) {
    const keyed = [...before, ...after].every(item => item && typeof item === 'object' && !Array.isArray(item) && 'id' in item);
    if (keyed) {
      const left = new Map(before.map((item, index) => [String((item as { id: unknown }).id), { item, index }]));
      const right = new Map(after.map((item, index) => [String((item as { id: unknown }).id), { item, index }]));
      const rows = [...new Set([...left.keys(), ...right.keys()])].flatMap(id => { const old = left.get(id); const next = right.get(id); const item = next?.item || old!.item; const index = next?.index ?? old!.index; return collectDiff(old?.item, next?.item, [...path, diffItemName(path.at(-1) || '', item, index)]); });
      const beforeOrder = before.map(item => String((item as { id: unknown }).id)).filter(id => right.has(id));
      const afterOrder = after.map(item => String((item as { id: unknown }).id)).filter(id => left.has(id));
      if (JSON.stringify(beforeOrder) !== JSON.stringify(afterOrder)) rows.push({ path: [...path, '排列顺序'], kind: 'changed', before: beforeOrder.map(id => diffItemName(path.at(-1) || '', left.get(id)!.item, left.get(id)!.index)).join(' → '), after: afterOrder.map(id => diffItemName(path.at(-1) || '', right.get(id)!.item, right.get(id)!.index)).join(' → ') });
      return rows;
    }
    return Array.from({ length: Math.max(before.length, after.length) }, (_, index) => collectDiff(before[index], after[index], [...path, diffItemName(path.at(-1) || '', after[index] ?? before[index], index)])).flat();
  }
  const kind = before === undefined ? 'added' : after === undefined ? 'removed' : 'changed';
  return [{ path, kind, before: diffValue(before), after: diffValue(after) }];
}
function DiffText({ value }: { value: string }) { return <pre className="history-diff-text">{value.split('\n').map((line, index) => <span className="history-diff-line" key={index}><i>{index + 1}</i><span>{line || ' '}</span></span>)}</pre>; }
function HistoryPage({ project, updateProject, notify, loadChange, ensureProjectParts }: { project: Project; updateProject: (id: string, change: (project: Project) => Project) => void; notify: (message: string) => void; loadChange: (id: string) => Promise<Project['changes'][number] | null>; ensureProjectParts: (id: string, parts: string[]) => Promise<Project> }) {
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<Project['changes'][number] | null>(null);
  const [loading, setLoading] = useState(false);
  const [confirmChange, setConfirmChange] = useState<string | null>(null);
  const [filter, setFilter] = useState<DocKey | 'all'>('all');
  const deleteChange = useContext(DeleteChange);
  const validChanges = project.changes;
  const change = selected && detail?.id === selected ? detail : null;
  const diffRows = change?.before !== undefined && change.after !== undefined ? collectDiff(change.before, change.after) : [];
  const categories: [DocKey | 'all', string][] = [['all', '全部'], ['outline', '大纲'], ['cast', '角色'], ['script', '剧本'], ['art', '美术'], ['storyboard', '分镜']];
  const categoryCount = (key: DocKey | 'all') => key === 'all' ? validChanges.length : validChanges.filter(item => item.section === key).length;
  const visibleChanges = validChanges.filter(item => filter === 'all' || item.section === filter);
  async function openChange(id: string) {
    setSelected(id); setDetail(null); setLoading(true);
    try { setDetail(await loadChange(id)); }
    catch (error) { notify(`无法读取历史快照：${(error as Error).message}`); }
    finally { setLoading(false); }
  }
  const diffPath = (path: string[]) => [sectionLabel(change!.section), ...path.map(part => diffFieldNames[part] || part)].join(' / ');
  function restore(id: string) {
    void (async () => {
      const target = detail?.id === id ? detail : await loadChange(id);
      if (!target?.before) { notify('这条历史记录没有可恢复的快照'); return; }
      const current = await ensureProjectParts(project.id, [`doc-${target.section}`, 'artifacts', 'changes']);
      if (collectDiff(current.docs[target.section], target.before).length === 0) { setSelected(null); notify('当前内容没有变化，未新增恢复记录'); return; }
      updateProject(project.id, p => {
        p.changes.unshift({ id: uid(), at: Date.now(), section: target.section, label: `恢复版本 · ${target.label}`, before: clone(p.docs[target.section]), after: clone(target.before!), beforeArtifact: p.skillArtifacts?.[target.section] ? clone(p.skillArtifacts[target.section]) : undefined, beforeGeneratedSource: target.section === 'outline' ? p.generatedSource : undefined });
        (p.docs as unknown as Record<DocKey, Project['docs'][DocKey]>)[target.section] = clone(target.before!);
        p.skillArtifacts = { ...p.skillArtifacts, [target.section]: target.beforeArtifact ? clone(target.beforeArtifact) : undefined };
        if (target.section === 'outline') p.generatedSource = target.beforeGeneratedSource;
        return p;
      });
      setSelected(null); notify('已恢复版本，可再次撤回');
    })().catch(error => notify(`恢复失败：${(error as Error).message}`));
  }
  return <><PageHeading stage="变更 · HISTORY" title="变更历史" subtitle="按创作阶段筛选记录；可逐项查看差异并撤销。"/><div className="history-filter-tabs">{categories.map(([key, label]) => <button key={key} className={filter === key ? "active" : ""} onClick={() => setFilter(key)}>{label}<small>{categoryCount(key)}</small></button>)}</div><div className="history-list">{visibleChanges.length ? visibleChanges.map(c => <div className="history-row" key={c.id}><button className="history-item" onClick={() => void openChange(c.id)}><span className="history-dot"/><span><strong>{c.label}</strong><small>{sectionLabel(c.section)} · {fmt(c.at)}</small></span><em>比较差异 →</em></button><button className="history-delete delete-icon-button" aria-label={`删除${c.label}的变更记录`} title="删除记录" onClick={() => setConfirmChange(c.id)}><DeleteIcon/></button></div>) : <div className="empty-state">该分类暂无变更记录。</div>}</div>{selected && <Modal title="查看变更" onClose={() => { setSelected(null); setDetail(null); }}><>{loading && <p>正在读取历史快照…</p>}{change && <><div className="eyebrow">{sectionLabel(change.section)} · {fmt(change.at)}</div><p>{change.label}</p>{(!change.before || !change.after) && <p className="history-legacy-note">这条旧记录缺少完整快照，无法显示完整差异或恢复。</p>}<div className="history-diff-summary"><strong>{diffRows.length} 项差异</strong><span><i className="added">＋</i> 新增</span><span><i className="removed">−</i> 删除</span><span><i className="changed">±</i> 修改</span></div><div className="history-diff-list">{diffRows.length ? diffRows.map((row, index) => <article className={`history-diff-row ${row.kind}`} key={`${row.path.join('.')}-${index}`}><div className="history-diff-path"><b>{row.kind === 'added' ? '+' : row.kind === 'removed' ? '−' : '±'}</b>{diffPath(row.path)}</div><div className="history-diff-values"><div className="history-diff-before"><small>改前</small><DiffText value={row.before}/></div><div className="history-diff-after"><small>改后</small><DiffText value={row.after}/></div></div></article>) : <div className="detail-empty">改前与改后没有差异。</div>}</div></>}<div className="modal-actions"><button className="btn" onClick={() => setSelected(null)}>关闭</button><button className="btn primary" disabled={!change?.before} onClick={() => restore(selected)}>撤销这批</button></div></></Modal>}{confirmChange && <Modal title="删除变更记录" onClose={() => setConfirmChange(null)}><p>确定删除「{project.changes.find(c => c.id === confirmChange)?.label}」？删除后无法从这条记录恢复，当前文档和媒体不会改变。</p><div className="modal-actions"><button className="btn" onClick={() => setConfirmChange(null)}>取消</button><button className="btn danger" onClick={() => { deleteChange(project.id, confirmChange); setConfirmChange(null); }}>删除记录</button></div></Modal>}</>;
}

function AssetFilter({ value, onChange, counts }: { value: AssetType | 'all'; onChange: (value: AssetType | 'all') => void; counts: Record<AssetType | 'all', number> }) { return <div className="filter-tabs">{([['all', '全部'], ['character', '角色'], ['scene', '场景'], ['prop', '道具'], ['storyboard', '分镜图'], ['other', '其它']] as const).map(([key, label]) => <button key={key} className={value === key ? 'active' : ''} onClick={() => onChange(key)}>{label} <small>{counts[key]}</small></button>)}</div>; }
function AssetCards({ assets, action, actionLabel, deleteAsset, renameAsset, detailPath, go, updatePrompt }: { assets: Asset[]; action?: (asset: Asset) => void; actionLabel?: string; deleteAsset?: (asset: Asset) => void; renameAsset?: (asset: Asset, name: string) => void; detailPath?: (asset: Asset) => string | undefined; go?: (path: string) => void; updatePrompt?: (asset: Asset, prompt: string) => void }) {
  const [editing, setEditing] = useState<string | null>(null); const [name, setName] = useState(''); const [editingPrompt, setEditingPrompt] = useState<string | null>(null); const [prompt, setPrompt] = useState('');
  function commit(asset: Asset) { const next = name.trim(); if (next && next !== asset.name) renameAsset?.(asset, next); setEditing(null); }
  async function copyPrompt(value: string) { if (!value.trim()) return; await copyText(value); }
  return <div className="asset-grid">{assets.map(a => { const path = detailPath?.(a); const currentPrompt = a.prompt ?? (a.description === '本机上传' ? '' : a.description); return <article className="panel asset-card" key={a.id}>{deleteAsset && <button className="asset-card-delete delete-icon-button" title="删除资产" aria-label={`删除${a.name}`} onClick={() => deleteAsset(a)}><DeleteIcon/></button>}<div className={`asset-placeholder${a.video ? ' asset-placeholder-video' : ''}`}><span>{a.type === 'character' ? '人' : a.type === 'scene' ? '景' : a.type === 'prop' ? '物' : '◇'}</span>{a.image && <MediaPicture src={a.image}/ >}{a.video && <MediaClip src={a.video}/>}</div><div className="asset-card-body"><span className="eyebrow">{assetNames[a.type] || '其它'} · {a.video ? '视频' : a.image ? '图片' : '内容'}</span>{editing === a.id ? <input className="asset-rename-input" autoFocus maxLength={120} value={name} aria-label="图片名称" onChange={e => setName(e.target.value)} onBlur={() => commit(a)} onKeyDown={e => { if (e.key === 'Enter') commit(a); if (e.key === 'Escape') setEditing(null); }}/> : <div className="asset-card-name">{path ? <button className="asset-card-title-link" onClick={() => go?.(path)}>{a.name}</button> : <h3>{a.name}</h3>}{renameAsset && a.image && <button className="rename-trigger" title="重命名图片" aria-label="重命名图片" onClick={() => { setName(a.name); setEditing(a.id); }}><svg viewBox="0 0 24 24"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z"/></svg></button>}</div>}{updatePrompt && a.image ? <div className="asset-prompt-block"><div className="asset-prompt-heading"><span>提示词</span><button className="copy-prompt-button" onClick={() => void copyPrompt(currentPrompt)} title="复制提示词" aria-label="复制提示词"><CopyPromptIcon/></button>{editingPrompt === a.id && <><button className="text-button" onClick={() => { setPrompt(currentPrompt); setEditingPrompt(null); }}>取消</button><button className="text-button" onClick={() => { updatePrompt(a, prompt); setEditingPrompt(null); }}>保存</button></>}</div>{editingPrompt === a.id ? <textarea className="asset-prompt-editor" autoFocus value={prompt} maxLength={8000} onChange={e => setPrompt(e.target.value)} aria-label={`${a.name}提示词`}/> : <p className="asset-prompt-text" title="双击编辑提示词" onDoubleClick={() => { setPrompt(currentPrompt); setEditingPrompt(a.id); }}>{currentPrompt || '尚未填写提示词'}</p>}</div> : <p>{a.description}</p>}<div className="inline-actions">{a.image && <MediaDownload src={a.image} name={a.name} kind="image"/>}{a.video && <MediaDownload src={a.video} name={a.name} kind="video"/>}{action && <button className="btn small" onClick={() => action(a)}>{actionLabel}</button>}</div></div></article>; })}</div>;
}
function GlobalLibrary({ state, importAsset, deleteAsset, renameAsset, addUpload, go }: { state: Store; importAsset: (asset: Asset, projectId: string) => void; deleteAsset: (asset: Asset) => void; renameAsset: (asset: Asset, name: string) => void; addUpload: (asset: Asset) => void; go: (path: string) => void }) {
  const [type, setType] = useState<AssetType | 'all'>('all'); const [media, setMedia] = useState<'all' | 'image' | 'video'>('all');
  const [query, setQuery] = useState(''); const [target, setTarget] = useState(''); const [uploadType, setUploadType] = useState<AssetType>('other');
  const [uploadError, setUploadError] = useState(''); const [busy, setBusy] = useState(false);
  const counts = useMemo(() => ({ all: state.library.length, character: state.library.filter(a => a.type === 'character').length, scene: state.library.filter(a => a.type === 'scene').length, prop: state.library.filter(a => a.type === 'prop').length, storyboard: state.library.filter(a => a.type === 'storyboard').length, other: state.library.filter(a => a.type === 'other').length }), [state.library]);
  const visible = state.library.filter(a => (type === 'all' || a.type === type) && (media === 'all' || (media === 'image' ? !!a.image : !!a.video)) && `${a.name} ${a.description}`.toLowerCase().includes(query.toLowerCase()));
  function detailPath(asset: Asset) {
    const owners = state.projects.filter(project => !asset.sourceProjectId || project.id === asset.sourceProjectId);
    for (const project of owners) {
      if (asset.type === 'character') {
        const character = project.docs.cast.find(item => item.id === asset.sourceItemId || item.name === asset.name);
        if (character) return `/p/${project.id}/cast/${encodeURIComponent(character.id)}`;
      }
      if (asset.type === 'scene' || asset.type === 'prop') {
        const section = asset.type === 'scene' ? 'scenes' : 'props';
        const item = project.docs.art[section].find(entry => entry.id === asset.sourceItemId || entry.name === asset.name);
        if (item) return `/p/${project.id}/art/${section}/${encodeURIComponent(item.id)}`;
      }
    }
    return undefined;
  }
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
  return <><PageHeading stage="用户级 · 跨项目复用 · ASSET LIBRARY" title="资产库" subtitle="上传图片和视频，按角色、场景、道具或其它分类，再导入项目使用。"/><div className="library-target panel global-library-row"><div><strong>上传媒体</strong><p>图片支持 PNG、JPEG、WebP，视频支持 MP4、WebM。</p></div><div className="global-library-controls"><select aria-label="上传分类" value={uploadType} onChange={e => setUploadType(e.target.value as AssetType)}>{(Object.keys(assetNames) as AssetType[]).map(key => <option key={key} value={key}>{assetNames[key]}</option>)}</select><label className="btn small library-upload-button">{busy ? '正在上传…' : '上传图片或视频'}<input type="file" accept="image/png,image/jpeg,image/webp,video/mp4,video/webm" disabled={busy} onChange={e => { void upload(e.target.files?.[0]); e.target.value = ''; }}/></label></div></div>{uploadError && <p className="field-error">{uploadError}</p>}<div className="library-target panel global-library-row"><div><strong>导入目标</strong><p>选择项目后，可将资产复制到项目库。</p></div><select value={target} onChange={e => setTarget(e.target.value)}><option value="">暂不选择项目</option>{state.projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></div><div className="library-toolbar global-library-toolbar"><AssetFilter value={type} onChange={setType} counts={counts}/><div className="global-library-controls"><select className="media-filter" value={media} onChange={e => setMedia(e.target.value as typeof media)}><option value="all">所有媒体</option><option value="image">图片</option><option value="video">视频</option></select><input className="search-input" value={query} onChange={e => setQuery(e.target.value)} placeholder="搜索资产…"/></div></div>{visible.length ? <AssetCards assets={visible} action={target ? a => importAsset(a, target) : undefined} actionLabel="导入到项目" deleteAsset={deleteAsset} renameAsset={renameAsset} detailPath={detailPath} go={go}/> : <div className="empty-state"><div className="empty-icon">◇</div><h2>{state.library.length ? '没有找到匹配的资产' : '资产库还是空的'}</h2><p>可以在这里上传图片或视频，也可以从项目编辑页将角色和美术加入全局库。</p><button className="btn" onClick={() => go('/dashboard')}>返回工作台</button></div>}</>;
}
function ProjectLibrary({ project, globalAssets, importAsset, deleteAsset, deleteReference, addProjectAsset, updateProject, notify, go }: { project: Project; globalAssets: Asset[]; importAsset: (asset: Asset, projectId: string) => void; deleteAsset: (asset: Asset) => void; deleteReference: (source: string, index: number) => void; addProjectAsset: (asset: Asset) => void; updateProject: (id: string, change: (project: Project) => Project) => void; notify: (message: string) => void; go: (path: string) => void }) {
  const [type, setType] = useState<AssetType | 'all'>('all'); const [media, setMedia] = useState<'all' | 'image' | 'video'>('all'); const [query, setQuery] = useState(''); const [showGlobal, setShowGlobal] = useState(false);
  const [globalType, setGlobalType] = useState<AssetType | 'all'>('all'); const [globalMedia, setGlobalMedia] = useState<'all' | 'image' | 'video'>('all'); const [globalQuery, setGlobalQuery] = useState('');
  const [uploadType, setUploadType] = useState<AssetType>('other'); const [uploadBusy, setUploadBusy] = useState(false);
  const assets = project.assets || [];
  const counts = { all: assets.length, character: assets.filter(a => a.type === 'character').length, scene: assets.filter(a => a.type === 'scene').length, prop: assets.filter(a => a.type === 'prop').length, storyboard: assets.filter(a => a.type === 'storyboard').length, other: assets.filter(a => a.type === 'other').length };
  const visible = assets.filter(a => (type === 'all' || a.type === type) && (media === 'all' || (media === 'image' ? !!a.image : !!a.video)) && `${a.name} ${a.description}`.toLowerCase().includes(query.toLowerCase()));
  const globalCounts = { all: globalAssets.length, character: globalAssets.filter(a => a.type === 'character').length, scene: globalAssets.filter(a => a.type === 'scene').length, prop: globalAssets.filter(a => a.type === 'prop').length, storyboard: globalAssets.filter(a => a.type === 'storyboard').length, other: globalAssets.filter(a => a.type === 'other').length };
  const visibleGlobal = globalAssets.filter(a => (globalType === 'all' || a.type === globalType) && (globalMedia === 'all' || (globalMedia === 'image' ? !!a.image : !!a.video)) && `${a.name} ${a.description}`.toLowerCase().includes(globalQuery.toLowerCase()));
  async function uploadProjectImages(files: File[]) {
    if (!files.length) return;
    setUploadBusy(true);
    let uploaded = 0; const failures: string[] = [];
    for (const file of files) {
      const valid = file.type === 'image/png' || file.type === 'image/jpeg' || file.type === 'image/webp' || /\.(png|jpe?g|webp)$/i.test(file.name);
      if (!valid) { failures.push(`${file.name}：格式不支持`); continue; }
      if (file.size > 20 * 1024 * 1024) { failures.push(`${file.name}：超过 20 MB`); continue; }
      try {
        const { url } = await uploadLibraryMedia(file, 'image');
        addProjectAsset({ id: uid(), type: uploadType, name: file.name.replace(/\.[^.]+$/, ''), description: '本机上传', mediaKind: 'image', image: url, sourceProjectId: project.id });
        uploaded++;
      } catch (error) { failures.push(`${file.name}：${(error as Error).message}`); }
    }
    if (failures.length) notify(`${uploaded ? `已上传 ${uploaded} 张；` : ''}失败 ${failures.length} 张：${failures.join('；')}`);
    else notify(`已上传 ${uploaded} 张${assetNames[uploadType]}图片到项目资产`);
    setUploadBusy(false);
  }
  function saveAssetPrompt(asset: Asset, prompt: string) {
    updateProject(project.id, current => { const target = current.assets.find(item => item.id === asset.id); if (target) target.prompt = prompt; return current; });
    notify('提示词已保存');
  }
  function detailPath(asset: Asset) {
    if (asset.sourceProjectId && asset.sourceProjectId !== project.id && asset.sourceItemId) {
      if (asset.type === 'character') return `/p/${asset.sourceProjectId}/cast/${encodeURIComponent(asset.sourceItemId)}`;
      if (asset.type === 'scene' || asset.type === 'prop') return `/p/${asset.sourceProjectId}/art/${asset.type === 'scene' ? 'scenes' : 'props'}/${encodeURIComponent(asset.sourceItemId)}`;
    }
    if (asset.type === 'character') {
      const character = project.docs.cast.find(item => item.id === asset.sourceItemId || item.id === asset.id || item.name === asset.name);
      if (character) return `/p/${project.id}/cast/${encodeURIComponent(character.id)}`;
    }
    if (asset.type === 'scene' || asset.type === 'prop') {
      const section = asset.type === 'scene' ? 'scenes' : 'props';
      const item = project.docs.art[section].find(entry => entry.id === asset.sourceItemId || entry.id === asset.id || entry.name === asset.name);
      if (item) return `/p/${project.id}/art/${section}/${encodeURIComponent(item.id)}`;
    }
    return undefined;
  }
  return <><PageHeading stage="PROJECT ASSETS" title={project.kind === 'novel' ? '素材库' : '项目资产库'} subtitle="查看已确认的生成结果与导入资产。" actions={<button className="btn" onClick={() => setShowGlobal(v => !v)}>{showGlobal ? '收起全局资产库' : '从全局资产库导入'}</button>}/><div className="library-target panel global-library-row project-upload-row"><div><strong>上传项目图片</strong><p>可多选上传 PNG、JPEG 或 WebP，每张图片按选定分类加入当前项目资产。</p></div><div className="global-library-controls"><select aria-label="项目图片分类" value={uploadType} disabled={uploadBusy} onChange={e => setUploadType(e.target.value as AssetType)}>{(Object.keys(assetNames) as AssetType[]).map(key => <option key={key} value={key}>{assetNames[key]}</option>)}</select><label className={`btn small library-upload-button${uploadBusy ? ' disabled' : ''}`}>{uploadBusy ? '正在上传…' : '批量上传图片'}<input type="file" multiple accept="image/png,image/jpeg,image/webp" disabled={uploadBusy} onChange={e => { void uploadProjectImages(Array.from(e.target.files || [])); e.target.value = ''; }}/></label></div></div>{project.referenceImages.length > 0 && <section className="panel"><h2>创作参考图</h2><div className="reference-grid">{project.referenceImages.map((src, i) => <div className="reference-card" key={i}><MediaPicture src={src}/><MediaDownload src={src} name={`创作参考图 ${i + 1}`} kind="image"/><button className="btn small danger" onClick={() => deleteReference(src, i)}>删除</button></div>)}</div></section>}{showGlobal && <section className="panel project-global-assets"><div className="section-heading"><h2>全局资产库 · 导入到当前项目</h2><span className="eyebrow">IMPORT</span></div><div className="library-toolbar"><AssetFilter value={globalType} onChange={setGlobalType} counts={globalCounts}/><div className="project-library-controls"><select className="media-filter" value={globalMedia} onChange={e => setGlobalMedia(e.target.value as typeof globalMedia)}><option value="all">所有媒体</option><option value="image">图片</option><option value="video">视频</option></select><input className="search-input" value={globalQuery} onChange={e => setGlobalQuery(e.target.value)} placeholder="搜索全局资产…"/></div></div>{visibleGlobal.length ? <AssetCards assets={visibleGlobal} action={a => importAsset(a, project.id)} actionLabel="导入这个项目" detailPath={detailPath} go={go}/> : <p className="muted">没有符合当前分类的全局资产。</p>}</section>}<div className="library-toolbar project-library-toolbar"><AssetFilter value={type} onChange={setType} counts={counts}/><div className="project-library-controls"><select className="media-filter" value={media} onChange={e => setMedia(e.target.value as typeof media)}><option value="all">所有媒体</option><option value="image">图片</option><option value="video">视频</option></select><input className="search-input" value={query} onChange={e => setQuery(e.target.value)} placeholder="搜索项目资产…"/></div></div>{visible.length ? <AssetCards assets={visible} deleteAsset={deleteAsset} detailPath={detailPath} go={go} updatePrompt={saveAssetPrompt}/> : <div className="empty-state"><div className="empty-icon">◇</div><h2>暂无项目资产</h2><p>确认生成图片或视频后会自动出现在这里，也可以从全局资产库导入。</p></div>}</>;
}
