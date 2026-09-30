import { beatSeconds } from './model';
import type { Asset, Project, Store, StoreSummary } from './model';
import { imageKey } from './mediaRefs';

const CHANNEL_NAME = 'reelbench-local-demo-sync';
const CHANNEL_CLIENT_ID = crypto.randomUUID();
function withLegacyMedia(project: Project, deletedAssets: string[], deletedMedia: string[]): Project {
  if (project.docs.script) {
    const script = { ...project.docs.script, episodes: project.docs.script.episodes.map(episode => ({ ...episode, scenes: episode.scenes.map(scene => ({ ...scene, flow: scene.beats.map((beat, index) => { const existing = scene.flow?.[index] || { action: beat }; return { ...existing, seconds: beatSeconds(existing, beat) }; }) })) })) };
    project = { ...project, docs: { ...project.docs, script } };
  }
  const assets = [...(project.assets || [])];
  const add = (url: string | undefined, type: Asset['type'], name: string, sourceItemId: string, video = false) => {
    if (!url || deletedMedia.includes(imageKey(url)) || assets.some(a => a.image === url || a.video === url)) return;
    const id = `legacy-${project.id}-${imageKey(url).replace(/:/g, '-')}`;
    if (!deletedAssets.includes(id)) assets.push({ id, type, name, description: '已有内容', mediaKind: video ? 'video' : 'image', sourceItemId, ...(video ? { video: url } : { image: url }) });
  };
  for (const character of project.docs.cast) add(character.image, 'character', character.name, character.id);
  for (const scene of project.docs.art.scenes) add(scene.image, 'scene', scene.name, scene.id);
  for (const prop of project.docs.art.props) add(prop.image, 'prop', prop.name, prop.id);
  for (const shot of project.docs.storyboard.shots) {
    add(shot.image, 'other', `分镜 · ${shot.scene}`, shot.id);
    add(shot.video, 'other', `分镜视频 · ${shot.scene}`, shot.id, true);
  }
  for (const segment of project.docs.storyboard.segments || []) for (const version of segment.videos) add(version.url, 'other', `第 ${segment.episode} 集 ${segment.id} · 分段视频`, `segment-${segment.episode}-${segment.id}`, true);
  return { ...project, assets };
}

export function mergeStores(a: Store, b: Store): Store {
  const deletedProjectIds = [...new Set([...(a.deletedProjectIds || []), ...(b.deletedProjectIds || [])])];
  const deletedAssetIds = [...new Set([...(a.deletedAssetIds || []), ...(b.deletedAssetIds || [])])];
  const deletedImages = [...new Set([...(a.deletedImages || []), ...(b.deletedImages || [])])];
  const deletedReferenceKeys = [...new Set([...(a.deletedReferenceKeys || []), ...(b.deletedReferenceKeys || [])])];
  const deletedChangeIds = [...new Set([...(a.deletedChangeIds || []), ...(b.deletedChangeIds || [])])];
  const deletedConsultationIds = [...new Set([...(a.deletedConsultationIds || []), ...(b.deletedConsultationIds || [])])];
  const projects = new Map(a.projects.map(p => [p.id, p]));
  for (const project of b.projects) {
    const current = projects.get(project.id);
    if (!current || project.updatedAt > current.updatedAt) projects.set(project.id, project);
  }
  const library = new Map(a.library.map(asset => [asset.id, asset]));
  for (const asset of b.library) library.set(asset.id, asset);
  return {
    projects: [...projects.values()].filter(p => !deletedProjectIds.includes(p.id)).map(p => withLegacyMedia({ ...p, assets: (p.assets || []).filter(asset => !deletedAssetIds.includes(asset.id)), changes: p.changes.filter(change => !deletedChangeIds.includes(change.id)), consultations: (p.consultations || []).filter(item => !deletedConsultationIds.includes(item.id)), referenceImages: p.referenceImages.filter(src => !deletedReferenceKeys.includes(`${p.id}:${imageKey(src)}`)) }, deletedAssetIds, deletedImages)).sort((x, y) => y.updatedAt - x.updatedAt),
    library: [...library.values()].filter(asset => !deletedAssetIds.includes(asset.id)),
    deletedProjectIds,
    deletedAssetIds,
    deletedImages,
    deletedReferenceKeys,
    deletedChangeIds,
    deletedConsultationIds
  };
}

export async function loadStore(): Promise<Store> {
  const response = await fetch('/api/store');
  if (!response.ok) throw new Error('无法读取本机项目文件。');
  const store = await response.json() as Store;
  clearLegacyBrowserStore();
  return mergeStores({ projects: [], library: [] }, store);
}

export async function loadStoreSummary(): Promise<StoreSummary> {
  const response = await fetch('/api/store/summary');
  if (!response.ok) throw new Error('无法读取项目列表。');
  clearLegacyBrowserStore();
  return await response.json() as StoreSummary;
}

export async function loadProjectParts(projectId: string, parts: string[]): Promise<Project & { changeDetails?: Record<string, Project['changes'][number] | null> }> {
  const query = new URLSearchParams({ parts: parts.join(',') });
  const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/parts?${query}`);
  if (!response.ok) {
    const detail = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(detail?.error || '无法读取项目内容。');
  }
  return await response.json() as Project & { changeDetails?: Record<string, Project['changes'][number] | null> };
}

export async function saveProjectMutation(projectId: string, input: { expectedRevisions: Record<string, string | null>; updates: Record<string, unknown>; addChanges?: Project['changes']; deleteChanges?: string[] }): Promise<{ conflict: boolean; conflicts?: string[]; revisions: Record<string, string | null> }> {
  const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/mutation`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
  const result = await response.json().catch(() => null) as { conflict?: boolean; conflicts?: string[]; revisions?: Record<string, string | null>; error?: string } | null;
  if (!response.ok && response.status !== 409) throw new Error(result?.error || '项目内容保存失败。');
  if (typeof BroadcastChannel !== 'undefined') {
    const channel = new BroadcastChannel(CHANNEL_NAME);
    channel.postMessage({ origin: CHANNEL_CLIENT_ID, projectId });
    channel.close();
  }
  return { conflict: response.status === 409 || !!result?.conflict, conflicts: result?.conflicts, revisions: result?.revisions || {} };
}

export async function createProject(project: Project): Promise<Record<string, string>> {
  const response = await fetch('/api/projects', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(project) });
  const result = await response.json().catch(() => null) as { revisions?: Record<string, string>; error?: string } | null;
  if (!response.ok) throw new Error(result?.error || '创建项目失败。');
  if (typeof BroadcastChannel !== 'undefined') {
    const channel = new BroadcastChannel(CHANNEL_NAME);
    channel.postMessage({ origin: CHANNEL_CLIENT_ID });
    channel.close();
  }
  return result?.revisions || {};
}

function clearLegacyBrowserStore() {
  try { localStorage.removeItem('reelbench-file-store-migrated'); } catch { /* Storage may be unavailable. */ }
  if (typeof indexedDB === 'undefined') return;
  try { indexedDB.deleteDatabase('reelbench-local-demo'); } catch { /* IndexedDB may be unavailable. */ }
}

export async function saveStore(state: Store): Promise<void> {
  const response = await fetch('/api/store', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(state) });
  if (!response.ok) {
    const detail = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(detail?.error || '无法保存本机项目文件。');
  }
  if (typeof BroadcastChannel !== 'undefined') {
    const channel = new BroadcastChannel(CHANNEL_NAME);
    channel.postMessage({ origin: CHANNEL_CLIENT_ID });
    channel.close();
  }
}

export async function saveStoreIndex(index: Partial<Store>): Promise<void> {
  const response = await fetch('/api/store/index', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(index) });
  if (!response.ok) {
    const detail = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(detail?.error || '项目索引保存失败。');
  }
  if (typeof BroadcastChannel !== 'undefined') {
    const channel = new BroadcastChannel(CHANNEL_NAME);
    channel.postMessage({ origin: CHANNEL_CLIENT_ID });
    channel.close();
  }
}

export function listenForUpdates(onUpdate: () => void): () => void {
  const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(CHANNEL_NAME) : null;
  if (channel) channel.onmessage = event => { if (event.data?.origin !== CHANNEL_CLIENT_ID) onUpdate(); };
  let revision: string | null = null;
  let checking = false;
  const timer = window.setInterval(() => {
    if (document.hidden || checking) return;
    checking = true;
    fetch('/api/store/revision').then(async response => {
      if (!response.ok) throw new Error('无法检查项目更新。');
      const next = (await response.json() as { revision: string }).revision;
      if (revision !== next) onUpdate();
      revision = next;
    }).catch(() => {}).finally(() => { checking = false; });
  }, 5000);
  return () => { channel?.close(); window.clearInterval(timer); };
}
