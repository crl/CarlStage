import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const FILE = join(process.env.REELBENCH_DATA_DIR || join(ROOT, '.local-runs'), 'projects.json');
const empty = () => ({ projects: [], library: [] });
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

export function merge(a, b) {
  const fields = ['deletedProjectIds', 'deletedAssetIds', 'deletedImages', 'deletedReferenceKeys', 'deletedChangeIds', 'deletedConsultationIds'];
  const deleted = Object.fromEntries(fields.map(field => [field, [...new Set([...(a[field] || []), ...(b[field] || [])])]]));
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

export async function readStore() {
  try { return merge(empty(), JSON.parse(await readFile(FILE, 'utf8'))); }
  catch (error) { if (error?.code === 'ENOENT') return empty(); throw error; }
}

export function saveStore(incoming) {
  if (!incoming || !Array.isArray(incoming.projects) || !Array.isArray(incoming.library)) throw new Error('项目数据格式无效。');
  const operation = pending.then(async () => {
    const next = merge(await readStore(), incoming);
    await mkdir(dirname(FILE), { recursive: true });
    const temporary = FILE + '.' + randomUUID() + '.tmp';
    await writeFile(temporary, JSON.stringify(next), { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, FILE);
    return next;
  });
  pending = operation.catch(() => {});
  return operation;
}
