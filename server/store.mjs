import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DATA_DIR = process.env.REELBENCH_DATA_DIR || join(ROOT, '.local-runs');
const FILE = join(DATA_DIR, 'projects.json');
const empty = () => ({ projects: [], library: [] });
const DELETION_FIELDS = ['deletedProjectIds', 'deletedAssetIds', 'deletedImages', 'deletedReferenceKeys', 'deletedChangeIds', 'deletedConsultationIds'];
const DOC_KEYS = ['outline', 'script', 'cast', 'art', 'storyboard'];
let pending = Promise.resolve();
export async function waitForStoreWrites() { await pending; }

function imageKey(source) {
  let a = 2166136261, b = 0x9e3779b9;
  for (let i = 0; i < source.length; i++) { const code = source.charCodeAt(i); a = Math.imul(a ^ code, 16777619); b = Math.imul(b ^ code, 2246822519); }
  return source.length + ':' + (a >>> 0).toString(36) + ':' + (b >>> 0).toString(36);
}
function projectDirectory(id) {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{3,80}$/.test(id)) throw new Error('项目 ID 无效。');
  return join(DATA_DIR, id);
}
function json(value) { return JSON.stringify(value); }
function equal(a, b) { return json(a) === json(b); }

export function merge(a, b) {
  const deleted = Object.fromEntries(DELETION_FIELDS.map(field => [field, [...new Set([...(a[field] || []), ...(b[field] || [])])]]));
  const projects = new Map((a.projects || []).map(project => [project.id, project]));
  for (const project of b.projects || []) { const current = projects.get(project.id); if (!current || project.updatedAt > current.updatedAt) projects.set(project.id, project); }
  const library = new Map((a.library || []).map(asset => [asset.id, asset]));
  for (const asset of b.library || []) library.set(asset.id, asset);
  return {
    projects: [...projects.values()].filter(project => !deleted.deletedProjectIds.includes(project.id)).map(project => ({ ...project,
      assets: (project.assets || []).filter(asset => !deleted.deletedAssetIds.includes(asset.id)),
      changes: (project.changes || []).filter(change => !deleted.deletedChangeIds.includes(change.id)),
      consultations: (project.consultations || []).filter(item => !deleted.deletedConsultationIds.includes(item.id)),
      referenceImages: (project.referenceImages || []).filter(src => !deleted.deletedReferenceKeys.includes(project.id + ':' + imageKey(src)))
    })).sort((x, y) => y.updatedAt - x.updatedAt),
    library: [...library.values()].filter(asset => !deleted.deletedAssetIds.includes(asset.id)), ...deleted
  };
}

async function readIndex() {
  try { return JSON.parse(await readFile(FILE, 'utf8')); }
  catch (error) { if (error?.code === 'ENOENT') return empty(); throw error; }
}
export async function storeRevision() {
  try { const info = await stat(FILE, { bigint: true }); return `${info.mtimeNs}:${info.size}`; }
  catch (error) { if (error?.code === 'ENOENT') return 'empty'; throw error; }
}
async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = path + '.' + randomUUID() + '.tmp';
  await writeFile(temporary, json(value), { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, path);
}
function manifestPath(id) { return join(projectDirectory(id), 'manifest.json'); }
function partPath(id, part, revision) { return join(projectDirectory(id), 'parts', `${part}.${revision}.json`); }
function changePath(id, changeId) { if (!/^[a-zA-Z0-9_-]{1,100}$/.test(changeId)) throw new Error('变更记录 ID 无效。'); return join(projectDirectory(id), 'changes', `${changeId}.json`); }
function classifyStoryboardImages(assets, shots = []) {
  return assets.map(asset => asset.type === 'other' && asset.image && !asset.video && shots.some(shot => shot.id === asset.sourceItemId || shot.image === asset.image) ? { ...asset, type: 'storyboard' } : asset);
}
function withLegacyMedia(project) {
  const assets = classifyStoryboardImages(project.assets || [], project.docs?.storyboard?.shots);
  const add = (url, type, name, sourceItemId, video = false) => {
    if (!url || assets.some(asset => asset.image === url || asset.video === url)) return;
    const id = `legacy-${project.id}-${imageKey(url).replace(/:/g, '-')}`;
    assets.push({ id, type, name, description: '已有内容', mediaKind: video ? 'video' : 'image', sourceItemId, ...(video ? { video: url } : { image: url }) });
  };
  for (const item of project.docs?.cast || []) add(item.image, 'character', item.name, item.id);
  for (const item of project.docs?.art?.scenes || []) add(item.image, 'scene', item.name, item.id);
  for (const item of project.docs?.art?.props || []) add(item.image, 'prop', item.name, item.id);
  for (const item of project.docs?.storyboard?.shots || []) { add(item.image, 'storyboard', `分镜 · ${item.scene}`, item.id); add(item.video, 'other', `分镜视频 · ${item.scene}`, item.id, true); }
  for (const segment of project.docs?.storyboard?.segments || []) for (const version of segment.videos || []) add(version.url, 'other', `第 ${segment.episode} 集 ${segment.id} · 分段视频`, `segment-${segment.episode}-${segment.id}`, true);
  return { ...project, assets };
}
function splitProject(project) {
  const { docs, assets, changes, consultations, skillArtifacts, sourceText, generatedSource, referenceImages, loadedParts, revisions, partRevisions, docStats, ...meta } = project;
  return { meta, docs: docs || {}, assets: assets || [], changes: changes || [], consultations: consultations || [], skillArtifacts: skillArtifacts || {}, source: { sourceText, generatedSource }, references: referenceImages || [] };
}
function changeSummaries(changes = []) { return changes.map(({ id, at, section, label, beforeArtifact, beforeGeneratedSource }) => ({ id, at, section, label, hasBeforeArtifact: !!beforeArtifact, hasBeforeGeneratedSource: beforeGeneratedSource !== undefined })); }

async function readManifest(id) {
  try { return JSON.parse(await readFile(manifestPath(id), 'utf8')); }
  catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
}
async function readPartFile(id, manifest, part) {
  const revision = manifest.revisions?.[part];
  if (!revision) return undefined;
  try { return JSON.parse(await readFile(partPath(id, part, revision), 'utf8')); }
  catch (error) { if (error?.code === 'ENOENT') throw new Error(`项目数据不完整：${part} ${revision} 缺失。`); throw error; }
}
async function migrateProject(project) {
  const id = project.id;
  const currentManifest = await readManifest(id);
  if (currentManifest) return currentManifest;
  const parts = splitProject(withLegacyMedia(project));
  const revisions = {};
  const writePart = async (name, value) => { const revision = randomUUID(); await writeJsonAtomic(partPath(id, name, revision), value); revisions[name] = revision; };
  await writePart('meta', parts.meta);
  for (const key of DOC_KEYS) await writePart(`doc-${key}`, parts.docs[key] ?? null);
  await writePart('assets', parts.assets);
  await writePart('changes', changeSummaries(parts.changes));
  await writePart('source', parts.source);
  await writePart('references', parts.references);
  await writePart('consultations', parts.consultations);
  await writePart('artifacts', parts.skillArtifacts);
  for (const change of parts.changes) await writeJsonAtomic(changePath(id, change.id), change);
  const backupPath = join(projectDirectory(id), 'project.json');
  try { await stat(backupPath); }
  catch (error) { if (error?.code !== 'ENOENT') throw error; await writeJsonAtomic(backupPath, project); }
  const summary = makeSummary(project);
  const manifest = { version: 2, revisions, summary, docStats: summary.docStats, migratedAt: Date.now() };
  await writeJsonAtomic(manifestPath(id), manifest);
  return manifest;
}
async function getProject(id, requestedParts = []) {
  const legacyPath = join(projectDirectory(id), 'project.json');
  let manifest = await readManifest(id);
  if (!manifest) {
    let legacy;
    try { legacy = JSON.parse(await readFile(legacyPath, 'utf8')); }
    catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
    manifest = await migrateProject(legacy);
  }
  const meta = await readPartFile(id, manifest, 'meta') || {};
  const parts = new Set(requestedParts);
  const result = { ...meta, id, updatedAt: manifest.updatedAt || manifest.summary?.updatedAt || meta.updatedAt, loadedParts: [...parts], docs: {}, assets: [], changes: [], consultations: [], skillArtifacts: {}, referenceImages: [], docStats: manifest.docStats || {} };
  for (const key of DOC_KEYS) if (parts.has(`doc-${key}`)) result.docs[key] = await readPartFile(id, manifest, `doc-${key}`);
  if (parts.has('assets')) {
    result.assets = await readPartFile(id, manifest, 'assets') || [];
    if (result.assets.some(asset => asset.type === 'other' && asset.image && !asset.video)) {
      const storyboard = await readPartFile(id, manifest, 'doc-storyboard');
      result.assets = classifyStoryboardImages(result.assets, storyboard?.shots);
    }
  }
  if (parts.has('changes')) result.changes = await readPartFile(id, manifest, 'changes') || [];
  if (parts.has('consultations')) result.consultations = await readPartFile(id, manifest, 'consultations') || [];
  if (parts.has('source')) Object.assign(result, await readPartFile(id, manifest, 'source') || {});
  if (parts.has('references')) result.referenceImages = await readPartFile(id, manifest, 'references') || [];
  if (parts.has('artifacts')) result.skillArtifacts = await readPartFile(id, manifest, 'artifacts') || {};
  for (const part of parts) if (part.startsWith('change:')) result.changeDetails ||= {}, result.changeDetails[part.slice(7)] = await readFile(changePath(id, part.slice(7)), 'utf8').then(JSON.parse).catch(error => { if (error?.code === 'ENOENT') return null; throw error; });
  result.revisions = Object.fromEntries([...parts].map(part => [part, manifest.revisions?.[part] || null]));
  return result;
}
function makeSummary(project) {
  const parts = splitProject(withLegacyMedia(project));
  const docs = parts.docs;
  return { ...parts.meta, id: project.id, updatedAt: project.updatedAt, referenceImageCount: project.referenceImages?.length || 0, docStats: {
    outlineEpisodes: docs.outline?.episodes?.length || 0, outlineBeats: docs.outline?.beats?.length || 0,
    cast: docs.cast?.length || 0, scenes: docs.art?.scenes?.length || 0, props: docs.art?.props?.length || 0,
    scriptScenes: (docs.script?.episodes || []).reduce((sum, episode) => sum + (episode.scenes || []).length, 0),
    scriptBeats: (docs.script?.episodes || []).reduce((sum, episode) => sum + (episode.scenes || []).reduce((count, scene) => count + (scene.beats || []).length, 0), 0),
    shots: docs.storyboard?.shots?.length || 0,
    segments: new Set((docs.storyboard?.shots || []).map(shot => shot.segmentId).filter(Boolean)).size,
    storyboardEpisodes: docs.storyboard?.shots?.reduce((max, shot) => Math.max(max, shot.episode || 1), 0) || 0
  }};
}
function summaryDocStats(key, value, current = {}) {
  const stats = { ...current };
  if (key === 'doc-outline') { stats.outlineEpisodes = value?.episodes?.length || 0; stats.outlineBeats = value?.beats?.length || 0; }
  if (key === 'doc-cast') stats.cast = value?.length || 0;
  if (key === 'doc-art') { stats.scenes = value?.scenes?.length || 0; stats.props = value?.props?.length || 0; }
  if (key === 'doc-script') {
    stats.scriptScenes = (value?.episodes || []).reduce((sum, episode) => sum + (episode.scenes || []).length, 0);
    stats.scriptBeats = (value?.episodes || []).reduce((sum, episode) => sum + (episode.scenes || []).reduce((count, scene) => count + (scene.beats || []).length, 0), 0);
  }
  if (key === 'doc-storyboard') {
    stats.shots = value?.shots?.length || 0;
    stats.segments = new Set((value?.shots || []).map(shot => shot.segmentId).filter(Boolean)).size;
    stats.storyboardEpisodes = (value?.shots || []).reduce((max, shot) => Math.max(max, shot.episode || 1), 0) || 0;
  }
  return stats;
}
async function writeProject(project) {
  const id = project.id;
  const manifest = await migrateProject(project);
  const parts = splitProject(withLegacyMedia(project));
  const revisions = { ...manifest.revisions };
  const writePart = async (name, value) => {
    const current = await readPartFile(id, manifest, name);
    if (equal(current, value)) return;
    const revision = randomUUID();
    await writeJsonAtomic(partPath(id, name, revision), value);
    revisions[name] = revision;
  };
  await writePart('meta', parts.meta);
  for (const key of DOC_KEYS) await writePart(`doc-${key}`, parts.docs[key] ?? null);
  await writePart('assets', parts.assets);
  await writePart('changes', changeSummaries(parts.changes));
  await writePart('source', parts.source);
  await writePart('references', parts.references);
  await writePart('consultations', parts.consultations);
  await writePart('artifacts', parts.skillArtifacts);
  const knownChanges = await readPartFile(id, manifest, 'changes') || [];
  const knownIds = new Set(knownChanges.map(change => change.id));
  for (const change of parts.changes) if (!knownIds.has(change.id)) await writeJsonAtomic(changePath(id, change.id), change);
  const summary = makeSummary(project);
  const next = { ...manifest, revisions, summary, docStats: summary.docStats, updatedAt: project.updatedAt || manifest.updatedAt || Date.now() };
  if (!equal(next, manifest)) await writeJsonAtomic(manifestPath(id), next);
  return next;
}

export async function readStoreSummary() {
  const index = await readIndex();
  const inline = new Map((index.projects || []).map(project => [project.id, project]));
  const ids = [...new Set([...(index.projectIds || []), ...inline.keys()])];
  const projects = [];
  for (const id of ids) {
    let manifest = await readManifest(id);
    if (!manifest) {
      const legacy = inline.get(id) || await readLegacyProject(id);
      if (!legacy) continue;
      manifest = await migrateProject(legacy);
    }
    projects.push({ ...manifest.summary, revisions: manifest.revisions });
  }
  if (index.projects?.length) {
    const compact = pending.then(async () => {
      const latest = await readIndex();
      if (!latest.projects) return;
      const legacyIds = (latest.projects || []).map(project => project.id);
      const complete = await Promise.all(legacyIds.map(readManifest));
      if (complete.some(manifest => !manifest)) return;
      const { projects: _legacyProjects, ...rest } = latest;
      await writeJsonAtomic(FILE, { ...rest, projectIds: [...new Set([...(rest.projectIds || []), ...legacyIds])] });
    });
    pending = compact.catch(() => {});
    await compact;
  }
  const latestIndex = await readIndex();
  return { projects: projects.filter(project => !(latestIndex.deletedProjectIds || []).includes(project.id)).sort((a, b) => b.updatedAt - a.updatedAt), library: (latestIndex.library || []).filter(asset => !(latestIndex.deletedAssetIds || []).includes(asset.id)), ...Object.fromEntries(DELETION_FIELDS.map(field => [field, latestIndex[field] || []])) };
}
async function readLegacyProject(id) {
  try { return JSON.parse(await readFile(join(projectDirectory(id), 'project.json'), 'utf8')); }
  catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
}

export async function readProjectParts(id, parts) {
  if (!Array.isArray(parts) || parts.length > 16) throw new Error('项目数据分区无效。');
  const allowed = new Set(['meta', 'assets', 'changes', 'source', 'references', 'consultations', 'artifacts', ...DOC_KEYS.map(key => `doc-${key}`)]);
  for (const part of parts) if (!allowed.has(part) && !/^change:[a-zA-Z0-9_-]{1,100}$/.test(part)) throw new Error(`不支持的项目分区：${part}`);
  const index = await readIndex();
  if ((index.deletedProjectIds || []).includes(id)) return null;
  if (!await readManifest(id)) {
    const current = await readLegacyProject(id);
    if (!current) return null;
    await migrateProject(current);
  }
  const project = await getProject(id, parts);
  if (parts.includes('assets')) project.assets = (project.assets || []).filter(asset => !(index.deletedAssetIds || []).includes(asset.id));
  for (const part of parts) if (part.startsWith('change:') && (index.deletedChangeIds || []).includes(part.slice(7))) project.changeDetails[part.slice(7)] = null;
  return project;
}

export function saveProjectMutation(id, input) {
  const operation = pending.then(async () => {
    if (!input || !input.updates || typeof input.updates !== 'object') throw new Error('项目更新内容无效。');
    let manifest = await readManifest(id);
    if (!manifest) {
      const current = await readLegacyProject(id);
      if (!current) throw new Error('项目不存在。');
      manifest = await migrateProject(current);
    }
    const revisions = { ...manifest.revisions };
    const conflicts = [];
    for (const part of Object.keys(input.updates)) {
      if (!['meta', 'assets', 'source', 'references', 'consultations', 'artifacts', ...DOC_KEYS.map(key => `doc-${key}`)].includes(part)) throw new Error(`不支持的项目分区：${part}`);
      const expected = input.expectedRevisions?.[part] ?? null;
      const actual = manifest.revisions?.[part] || null;
      if (expected !== actual) conflicts.push(part);
    }
    if (input.deleteChanges?.length) {
      const expected = input.expectedRevisions?.changes ?? null;
      const actual = manifest.revisions?.changes || null;
      if (expected !== actual) conflicts.push('changes');
    }
    if (conflicts.length) return { conflict: true, conflicts, revisions: manifest.revisions };
    const nextChanges = await readPartFile(id, manifest, 'changes') || [];
    const addChanges = input.addChanges || [];
    const deleteIds = new Set(input.deleteChanges || []);
    for (const change of addChanges) {
      if (!change || typeof change.id !== 'string' || !DOC_KEYS.includes(change.section)) throw new Error('变更记录无效。');
      if (nextChanges.some(item => item.id === change.id)) throw new Error('变更记录 ID 已存在。');
      await writeJsonAtomic(changePath(id, change.id), change);
    }
    const changeIndex = [...addChanges.map(({ id, at, section, label, beforeArtifact, beforeGeneratedSource }) => ({ id, at, section, label, hasBeforeArtifact: !!beforeArtifact, hasBeforeGeneratedSource: beforeGeneratedSource !== undefined })), ...nextChanges.filter(change => !deleteIds.has(change.id))];
    if (addChanges.length || deleteIds.size) {
      const revision = randomUUID();
      await writeJsonAtomic(partPath(id, 'changes', revision), changeIndex);
      revisions.changes = revision;
    }
    for (const [part, value] of Object.entries(input.updates)) {
      const existing = await readPartFile(id, manifest, part);
      if (equal(existing, value)) continue;
      const revision = randomUUID();
      await writeJsonAtomic(partPath(id, part, revision), value);
      revisions[part] = revision;
    }
    let summary = { ...(manifest.summary || {}), ...(input.updates.meta || {}) };
    if (Object.hasOwn(input.updates, 'references')) summary.referenceImageCount = input.updates.references?.length || 0;
    let docStats = { ...(manifest.docStats || {}) };
    for (const [part, value] of Object.entries(input.updates)) if (part.startsWith('doc-')) docStats = summaryDocStats(part, value, docStats);
    summary = { ...summary, docStats, updatedAt: Date.now() };
    const nextManifest = { ...manifest, revisions, summary, docStats, updatedAt: Date.now() };
    if (!equal(nextManifest, manifest)) await writeJsonAtomic(manifestPath(id), nextManifest);
    const index = await readIndex();
    await writeJsonAtomic(FILE, { ...index, projectIds: [...new Set([...(index.projectIds || []), id])], projects: undefined, deletedChangeIds: [...new Set([...(index.deletedChangeIds || []), ...deleteIds])] });
    for (const changeId of deleteIds) await rm(changePath(id, changeId), { force: true });
    return { conflict: false, revisions };
  });
  pending = operation.catch(() => {});
  return operation;
}

export function createProject(project) {
  const operation = pending.then(async () => {
    if (!project || typeof project !== 'object' || typeof project.id !== 'string') throw new Error('项目数据无效。');
    const existing = await readManifest(project.id);
    const index = await readIndex();
    if (!existing) await writeProject(project);
    await writeJsonAtomic(FILE, { ...index, projectIds: [...new Set([...(index.projectIds || []), project.id])], projects: undefined });
    return (await readManifest(project.id)).revisions;
  });
  pending = operation.catch(() => {});
  return operation;
}

async function readFullProject(id) {
  const manifest = await readManifest(id);
  if (!manifest) return readLegacyProject(id);
  const loaded = await getProject(id, ['assets', 'changes', 'source', 'references', 'consultations', 'artifacts', ...DOC_KEYS.map(key => `doc-${key}`)]);
  const changes = await Promise.all((loaded.changes || []).map(async change => {
    try { return JSON.parse(await readFile(changePath(id, change.id), 'utf8')); }
    catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
  }));
  return { ...loaded, changes: changes.filter(Boolean), docs: Object.fromEntries(DOC_KEYS.map(key => [key, loaded.docs[key]])) };
}
export async function readStore() {
  await readStoreSummary();
  return readStoreContents();
}
async function readStoreContents() {
  const index = await readIndex();
  const inline = new Map((index.projects || []).map(project => [project.id, project]));
  const ids = [...new Set([...(index.projectIds || []), ...inline.keys()])];
  const projects = (await Promise.all(ids.map(async id => {
    if (!await readManifest(id) && inline.has(id)) await migrateProject(inline.get(id));
    return (await readFullProject(id)) || inline.get(id) || null;
  }))).filter(Boolean);
  return merge({ ...empty(), ...index, projects: [] }, { ...empty(), projects });
}
export function saveStoreIndex(incoming) {
  const operation = pending.then(async () => {
    const current = await readIndex();
    const next = { ...current, ...incoming };
    for (const field of DELETION_FIELDS) next[field] = [...new Set([...(current[field] || []), ...(incoming[field] || [])])];
    next.projectIds = (current.projectIds || []).filter(id => !next.deletedProjectIds.includes(id));
    delete next.projects;
    await writeJsonAtomic(FILE, next);
    return next;
  });
  pending = operation.catch(() => {});
  return operation;
}
export function restoreProjectTombstones(id, tombstones = {}) {
  const operation = pending.then(async () => {
    const previous = await readIndex();
    const project = await readFullProject(id);
    if (!project) throw new Error('待还原的项目数据不存在。');
    const assetIds = new Set((project.assets || []).map(item => item.id));
    const changeIds = new Set((project.changes || []).map(item => item.id));
    const consultationIds = new Set((project.consultations || []).map(item => item.id));
    const referenceKeys = new Set((project.referenceImages || []).map(source => `${id}:${imageKey(source)}`));
    const keepKnown = (values, allowed) => (Array.isArray(values) ? values : []).filter(value => allowed.has(value));
    const next = {
      ...previous,
      projectIds: [...new Set([...(previous.projectIds || []), id])],
      deletedProjectIds: (previous.deletedProjectIds || []).filter(value => value !== id),
      deletedAssetIds: [...new Set([...(previous.deletedAssetIds || []).filter(value => !assetIds.has(value)), ...keepKnown(tombstones.assets, assetIds)])],
      deletedChangeIds: [...new Set([...(previous.deletedChangeIds || []).filter(value => !changeIds.has(value)), ...keepKnown(tombstones.changes, changeIds)])],
      deletedConsultationIds: [...new Set([...(previous.deletedConsultationIds || []).filter(value => !consultationIds.has(value)), ...keepKnown(tombstones.consultations, consultationIds)])],
      deletedReferenceKeys: [...new Set([...(previous.deletedReferenceKeys || []).filter(value => !referenceKeys.has(value)), ...keepKnown(tombstones.references, referenceKeys)])]
    };
    await writeJsonAtomic(FILE, next);
    return previous;
  });
  pending = operation.catch(() => {});
  return operation;
}
export function rollbackStoreIndex(snapshot) {
  const operation = pending.then(() => writeJsonAtomic(FILE, snapshot));
  pending = operation.catch(() => {});
  return operation;
}
export function saveStore(incoming) {
  if (!incoming || !Array.isArray(incoming.projects) || !Array.isArray(incoming.library)) throw new Error('项目数据格式无效。');
  const operation = pending.then(async () => {
    const current = await readStoreContents();
    const next = merge(current, incoming);
    const deletedProjectIds = [...new Set([...(current.deletedProjectIds || []), ...(incoming.deletedProjectIds || [])])];
    const projects = next.projects.filter(project => !deletedProjectIds.includes(project.id));
    for (const project of projects) await writeProject(project);
    const index = { projectIds: projects.map(project => project.id), library: next.library, ...Object.fromEntries(DELETION_FIELDS.map(field => [field, next[field] || []])) };
    await writeJsonAtomic(FILE, index);
    return { ...next, projects };
  });
  pending = operation.catch(() => {});
  return operation;
}
