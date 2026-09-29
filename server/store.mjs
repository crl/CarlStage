import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DATA_DIR = process.env.REELBENCH_DATA_DIR || join(ROOT, '.local-runs');
const FILE = join(DATA_DIR, 'projects.json');
const empty = () => ({ projects: [], library: [] });
const DELETION_FIELDS = ['deletedProjectIds', 'deletedAssetIds', 'deletedImages', 'deletedReferenceKeys', 'deletedChangeIds', 'deletedConsultationIds'];
let pending = Promise.resolve();

function imageKey(source) {
  let a = 2166136261, b = 0x9e3779b9;
  for (let i = 0; i < source.length; i++) {
    const code = source.charCodeAt(i);
    a = Math.imul(a ^ code, 16777619);
    b = Math.imul(b ^ code, 2246822519);
  }
  return source.length + ':' + (a >>> 0).toString(36) + ':' + (b >>> 0).toString(36);
}

function projectDirectory(id) {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{3,80}$/.test(id)) throw new Error('项目 ID 无效。');
  return join(DATA_DIR, id);
}

export function merge(a, b) {
  const deleted = Object.fromEntries(DELETION_FIELDS.map(field => [field, [...new Set([...(a[field] || []), ...(b[field] || [])])]]));
  const projects = new Map((a.projects || []).map(project => [project.id, project]));
  for (const project of b.projects || []) {
    const current = projects.get(project.id);
    if (!current || project.updatedAt > current.updatedAt) projects.set(project.id, project);
  }
  const library = new Map((a.library || []).map(asset => [asset.id, asset]));
  for (const asset of b.library || []) library.set(asset.id, asset);
  return {
    projects: [...projects.values()].filter(project => !deleted.deletedProjectIds.includes(project.id)).map(project => ({
      ...project,
      assets: (project.assets || []).filter(asset => !deleted.deletedAssetIds.includes(asset.id)),
      changes: (project.changes || []).filter(change => !deleted.deletedChangeIds.includes(change.id)),
      consultations: (project.consultations || []).filter(item => !deleted.deletedConsultationIds.includes(item.id)),
      referenceImages: (project.referenceImages || []).filter(src => !deleted.deletedReferenceKeys.includes(project.id + ':' + imageKey(src)))
    })).sort((x, y) => y.updatedAt - x.updatedAt),
    library: [...library.values()].filter(asset => !deleted.deletedAssetIds.includes(asset.id)),
    ...deleted
  };
}

async function readIndex() {
  try { return JSON.parse(await readFile(FILE, 'utf8')); }
  catch (error) { if (error?.code === 'ENOENT') return empty(); throw error; }
}

async function readProject(id) {
  try { return JSON.parse(await readFile(join(projectDirectory(id), 'project.json'), 'utf8')); }
  catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
}

async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = path + '.' + randomUUID() + '.tmp';
  await writeFile(temporary, JSON.stringify(value), { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, path);
}

export async function readStore() {
  const index = await readIndex();
  // Support existing installs whose projects still live inline in projects.json.
  const inlineProjects = new Map((index.projects || []).map(project => [project.id, project]));
  const ids = [...new Set([...(index.projectIds || []), ...inlineProjects.keys()])];
  const projects = (await Promise.all(ids.map(async id => (await readProject(id)) || inlineProjects.get(id) || null))).filter(Boolean);
  return merge({ ...empty(), ...index, projects: [] }, { ...empty(), projects });
}

export function saveStore(incoming) {
  if (!incoming || !Array.isArray(incoming.projects) || !Array.isArray(incoming.library)) throw new Error('项目数据格式无效。');
  const operation = pending.then(async () => {
    const current = await readStore();
    const next = merge(current, incoming);
    const deletedProjectIds = [...new Set([...(current.deletedProjectIds || []), ...(incoming.deletedProjectIds || [])])];
    const projects = next.projects.filter(project => !deletedProjectIds.includes(project.id));
    for (const project of projects) await writeJsonAtomic(join(projectDirectory(project.id), 'project.json'), project);
    // The root file is a lightweight index; each project's full configuration and data stay with that project.
    const index = { projectIds: projects.map(project => project.id), library: next.library, ...Object.fromEntries(DELETION_FIELDS.map(field => [field, next[field] || []])) };
    await writeJsonAtomic(FILE, index);
    return { ...next, projects };
  });
  pending = operation.catch(() => {});
  return operation;
}
