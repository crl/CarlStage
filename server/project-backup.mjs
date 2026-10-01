import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import yazl from 'yazl';
import yauzl from 'yauzl';
import { mediaFilePath } from './media.mjs';
import { readStore, restoreProjectTombstones, rollbackStoreIndex, waitForStoreWrites } from './store.mjs';

const RUNS = resolve(process.env.REELBENCH_DATA_DIR || join(dirname(fileURLToPath(import.meta.url)), '..', '.local-runs'));
const BACKUP_FORMAT = 'carlstage-project-backup';
const MAX_UPLOAD = 2 * 1024 * 1024 * 1024;
const MAX_UNCOMPRESSED = 8 * 1024 * 1024 * 1024;
const MAX_FILE = 1024 * 1024 * 1024;
const MAX_ENTRIES = 100_000;
const MAX_MANIFEST = 16 * 1024 * 1024;
const sessions = new Map();

function projectRoot(id) {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{3,80}$/.test(id)) throw new Error('项目 ID 无效。');
  return join(RUNS, id);
}
function mediaRoot(id) { return join(RUNS, 'media', id); }
function imageKey(source) {
  let a = 2166136261, b = 0x9e3779b9;
  for (let i = 0; i < source.length; i++) { const code = source.charCodeAt(i); a = Math.imul(a ^ code, 16777619); b = Math.imul(b ^ code, 2246822519); }
  return source.length + ':' + (a >>> 0).toString(36) + ':' + (b >>> 0).toString(36);
}
function safeRelative(value) {
  const path = String(value || '').replace(/\\/g, '/');
  if (!path || path.startsWith('/') || /^[a-zA-Z]:/.test(path) || path.split('/').some(part => !part || part === '.' || part === '..' || part.includes(':'))) throw new Error('备份包含无效文件路径。');
  return path;
}
function inside(root, path) { return path.startsWith(resolve(root) + sep); }
async function listFiles(root, prefix, { omitTemps = false } = {}) {
  const files = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (omitTemps && entry.isDirectory() && /^\.(?:proj-import|proj-backup|backup-restore|backup-rollback)-/.test(entry.name)) continue;
      const full = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error('项目目录包含符号链接，无法安全备份。');
      if (entry.isDirectory()) await visit(full);
      else if (entry.isFile()) files.push({ path: `${prefix}/${relative(root, full).split(sep).join('/')}`, full });
    }
  }
  if (existsSync(root)) await visit(root);
  return files;
}
async function digestFile(path) {
  const hash = createHash('sha256'); let size = 0;
  for await (const chunk of createReadStream(path)) { size += chunk.length; hash.update(chunk); }
  return { size, sha256: hash.digest('hex') };
}
function mediaReferences(value, result = new Set()) {
  if (typeof value === 'string') {
    const match = value.match(/^\/api\/media\/(library|[a-zA-Z0-9_-]{3,80})\/([a-f0-9-]{36}\.(?:png|jpg|jpeg|webp|mp4|webm|mov|mp3|wav|flac|ogg))$/i);
    if (match) result.add(`${match[1]}/${match[2]}`);
  } else if (Array.isArray(value)) value.forEach(item => mediaReferences(item, result));
  else if (value && typeof value === 'object') Object.values(value).forEach(item => mediaReferences(item, result));
  return result;
}
async function projectForBackup(id) {
  const store = await readStore();
  const project = store.projects.find(item => item.id === id);
  if (!project) throw new Error('项目不存在。');
  const raw = await rawProjectParts(projectRoot(id));
  const references = raw.references || [];
  return {
    project,
    tombstones: {
      assets: (raw.assets || []).map(item => item.id).filter(value => store.deletedAssetIds?.includes(value)),
      changes: (raw.changes || []).map(item => item.id).filter(value => store.deletedChangeIds?.includes(value)),
      consultations: (raw.consultations || []).map(item => item.id).filter(value => store.deletedConsultationIds?.includes(value)),
      references: references.map(source => `${id}:${imageKey(source)}`).filter(value => store.deletedReferenceKeys?.includes(value))
    }
  };
}
async function rawProjectParts(root) {
  const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
  const result = {};
  for (const part of ['assets', 'changes', 'consultations', 'references']) {
    const revision = manifest.revisions?.[part];
    if (!revision) { result[part] = []; continue; }
    if (!/^[a-f0-9-]{36}$/.test(revision)) throw new Error('项目备份数据版本无效。');
    result[part] = JSON.parse(await readFile(join(root, 'parts', `${part}.${revision}.json`), 'utf8')) || [];
  }
  return result;
}
async function validateProjectTombstones(root, id, tombstones) {
  const allowed = await rawProjectParts(root);
  const arrays = tombstones && typeof tombstones === 'object' ? tombstones : {};
  const values = key => {
    if (arrays[key] === undefined) return [];
    if (!Array.isArray(arrays[key]) || arrays[key].length > MAX_ENTRIES || arrays[key].some(value => typeof value !== 'string' || value.length > 300)) throw new Error('备份的删除记录格式无效。');
    return arrays[key];
  };
  const only = (supplied, valid) => supplied.filter(value => valid.has(value));
  return {
    assets: only(values('assets'), new Set((allowed.assets || []).map(item => item.id))),
    changes: only(values('changes'), new Set((allowed.changes || []).map(item => item.id))),
    consultations: only(values('consultations'), new Set((allowed.consultations || []).map(item => item.id))),
    references: only(values('references'), new Set((allowed.references || []).map(source => `${id}:${imageKey(source)}`)))
  };
}

export async function writeProjectBackup(id, response, filename = 'project-backup.zip') {
  const { project, tombstones } = await projectForBackup(id);
  const projectFiles = await listFiles(projectRoot(id), 'project', { omitTemps: true });
  const mediaFiles = [];
  const mediaMap = {};
  for (const reference of mediaReferences(project)) {
    const [owner, name] = reference.split('/');
    const source = mediaFilePath(owner, name);
    try { if (!(await stat(source)).isFile()) continue; }
    catch (error) { if (error?.code === 'ENOENT') continue; throw error; }
    const destination = `media/${name}`;
    mediaMap[`/api/media/${reference}`] = `/api/media/${id}/${name}`;
    if (!mediaFiles.some(file => file.path === destination)) mediaFiles.push({ path: destination, full: source });
  }
  const files = [];
  for (const file of [...projectFiles, ...mediaFiles]) files.push({ path: file.path, ...(await digestFile(file.full)) });
  const manifest = { format: BACKUP_FORMAT, version: 1, projectId: id, projectName: project.name, createdAt: Date.now(), mediaMap, tombstones, files };
  const zip = new yazl.ZipFile();
  zip.addBuffer(Buffer.from(JSON.stringify(manifest)), 'backup-manifest.json', { compress: true });
  for (const file of [...projectFiles, ...mediaFiles]) zip.addFile(file.full, file.path, { compress: /\.(?:json|txt|md|html?|css|svg)$/i.test(file.path) });
  response.writeHead(200, { 'content-type': 'application/zip', 'cache-control': 'no-store', 'content-disposition': `attachment; filename="${filename}"` });
  zip.outputStream.on('error', error => response.destroy(error));
  zip.outputStream.pipe(response);
  zip.end();
}

function openZip(path) {
  return new Promise((resolveZip, reject) => yauzl.open(path, { lazyEntries: true, decodeStrings: true, validateEntrySizes: true, strictFileNames: true }, (error, zip) => error ? reject(error) : resolveZip(zip)));
}
function entryStream(zip, entry) {
  return new Promise((resolveStream, reject) => zip.openReadStream(entry, (error, stream) => error ? reject(error) : resolveStream(stream)));
}
async function bufferEntry(zip, entry) {
  if (entry.uncompressedSize > MAX_MANIFEST) throw new Error('备份清单过大。');
  const stream = await entryStream(zip, entry); const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}
function manifestValid(manifest, id) {
  if (!manifest || manifest.format !== BACKUP_FORMAT || manifest.version !== 1 || manifest.projectId !== id || !Array.isArray(manifest.files) || manifest.files.length > MAX_ENTRIES) throw new Error('备份格式无效，或备份不属于当前项目。');
  const seen = new Set(); let total = 0;
  for (const file of manifest.files) {
    const path = safeRelative(file.path);
    if (path === 'backup-manifest.json' || seen.has(path) || !/^[a-f0-9]{64}$/.test(file.sha256) || !Number.isSafeInteger(file.size) || file.size < 0 || file.size > MAX_FILE) throw new Error('备份清单中的文件信息无效。');
    if (!(path.startsWith('project/') || /^media\/[a-f0-9-]{36}\.(?:png|jpg|jpeg|webp|mp4|webm|mov|mp3|wav|flac|ogg)$/i.test(path))) throw new Error('备份包含不允许的文件。');
    seen.add(path); total += file.size;
    if (total > MAX_UNCOMPRESSED) throw new Error('备份解压后超过允许大小。');
  }
  return new Map(manifest.files.map(file => [file.path, file]));
}
function validMediaMap(value, id, expected) {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > MAX_ENTRIES) throw new Error('备份的媒体映射无效。');
  const result = {};
  for (const [from, to] of Object.entries(value)) {
    if (!/^\/api\/media\/(?:library|[a-zA-Z0-9_-]{3,80})\/[a-f0-9-]{36}\.(?:png|jpg|jpeg|webp|mp4|webm|mov|mp3|wav|flac|ogg)$/i.test(from)) throw new Error('备份的媒体映射无效。');
    const target = typeof to === 'string' && to.match(new RegExp(`^/api/media/${id}/([a-f0-9-]{36}\\.(?:png|jpg|jpeg|webp|mp4|webm|mov|mp3|wav|flac|ogg))$`, 'i'));
    if (!target || !expected.has(`media/${target[1]}`)) throw new Error('备份的媒体映射缺少对应文件。');
    result[from] = to;
  }
  return result;
}
async function extractAndVerify(zipPath, stagePath, id) {
  const zip = await openZip(zipPath);
  let manifest, expected, extracted = 0, total = 0;
  try {
    await new Promise((resolveEntries, rejectEntries) => {
      let count = 0; let settled = false;
      const fail = error => { if (settled) return; settled = true; rejectEntries(error); zip.close(); };
      zip.on('error', fail);
      zip.on('end', () => { if (!settled) { settled = true; resolveEntries(); } });
      zip.on('entry', entry => {
        (async () => {
          if (++count > MAX_ENTRIES + 1) throw new Error('备份文件数量超过允许上限。');
          const path = safeRelative(entry.fileName);
          if (path === 'backup-manifest.json') {
            if (manifest) throw new Error('备份清单重复。');
            manifest = JSON.parse((await bufferEntry(zip, entry)).toString('utf8'));
            expected = manifestValid(manifest, id);
            const stagedProject = join(stagePath, 'project');
            await mkdir(stagedProject, { recursive: true });
          } else {
            if (!manifest || !expected) throw new Error('ZIP 缺少首个备份清单。');
            const info = expected.get(path);
            if (!info || info.size !== entry.uncompressedSize) throw new Error('备份文件与清单不匹配。');
            const mode = (entry.externalFileAttributes >>> 16) & 0o170000;
            if (mode === 0o120000) throw new Error('备份不能包含符号链接。');
            total += entry.uncompressedSize;
            if (total > MAX_UNCOMPRESSED) throw new Error('备份解压后超过允许大小。');
            const target = resolve(stagePath, ...path.split('/'));
            if (!inside(stagePath, target)) throw new Error('备份包含无效文件路径。');
            await mkdir(dirname(target), { recursive: true });
            const stream = await entryStream(zip, entry); const hash = createHash('sha256'); let size = 0;
            const check = new Transform({ transform(chunk, encoding, callback) { size += chunk.length; hash.update(chunk); callback(null, chunk); } });
            await pipeline(stream, check, createWriteStream(target, { flags: 'wx' }));
            if (size !== info.size || hash.digest('hex') !== info.sha256) throw new Error('备份文件校验失败。');
            extracted++;
          }
        })().then(() => zip.readEntry(), fail);
      });
      zip.readEntry();
    });
    if (!manifest || extracted !== expected.size) throw new Error('备份文件不完整。');
    if (!expected.has('project/manifest.json') && !expected.has('project/project.json')) throw new Error('备份中缺少项目数据。');
    const mediaDirectory = join(stagePath, 'media');
    await mkdir(mediaDirectory, { recursive: true });
    manifest.mediaMap = validMediaMap(manifest.mediaMap, id, expected);
    await rewriteProjectMedia(join(stagePath, 'project'), manifest.mediaMap, id);
    const tombstones = await validateProjectTombstones(join(stagePath, 'project'), id, manifest.tombstones);
    return { projectName: String(manifest.projectName || '未命名项目').slice(0, 300), createdAt: Number(manifest.createdAt) || 0, tombstones };
  } finally { zip.close(); }
}
async function rewriteProjectMedia(root, mediaMap, id) {
  const files = await listFiles(root, '');
  const replacements = Object.entries(mediaMap).filter(([from, to]) => typeof from === 'string' && typeof to === 'string' && from.startsWith('/api/media/') && to.startsWith(`/api/media/${id}/`));
  if (!replacements.length) return;
  replacements.sort(([a], [b]) => b.length - a.length);
  const patternSize = Math.max(...replacements.map(([from]) => Buffer.byteLength(from)));
  for (const file of files) {
    if (!file.full.toLowerCase().endsWith('.json')) continue;
    const temporary = `${file.full}.${randomUUID()}.tmp`;
    let carry = '';
    const replace = value => {
      for (const [from, to] of replacements) value = value.split(from).join(to);
      return value;
    };
    const rewrite = new Transform({
      transform(chunk, encoding, callback) {
        const transformed = replace(carry + chunk.toString('latin1'));
        const splitAt = Math.max(0, transformed.length - (patternSize - 1));
        carry = transformed.slice(splitAt);
        callback(null, Buffer.from(transformed.slice(0, splitAt), 'latin1'));
      },
      flush(callback) { callback(null, Buffer.from(replace(carry), 'latin1')); }
    });
    try { await pipeline(createReadStream(file.full), rewrite, createWriteStream(temporary, { flags: 'wx', mode: 0o600 })); await rename(temporary, file.full); }
    catch (error) { await rm(temporary, { force: true }); throw error; }
  }
}
async function streamUpload(request, path) {
  let size = 0;
  const limit = new Transform({ transform(chunk, encoding, callback) { size += chunk.length; callback(size > MAX_UPLOAD ? new Error('备份 ZIP 超过 2 GB。') : null, chunk); } });
  await pipeline(request, limit, createWriteStream(path, { flags: 'wx' }));
}
function removeSession(token) {
  const session = sessions.get(token);
  if (!session) return;
  sessions.delete(token);
  void rm(session.root, { recursive: true, force: true }).catch(() => {});
}
export async function prepareProjectRestore(id, request) {
  for (const [token, session] of sessions) if (session.expiresAt < Date.now()) removeSession(token);
  if ([...sessions.values()].some(session => session.id === id)) throw new Error('该项目已有待确认的还原任务，请先取消或完成它。');
  const { project: current } = await projectForBackup(id);
  const token = randomUUID(); const root = join(RUNS, `.backup-restore-${token}`);
  await mkdir(root, { recursive: true });
  try {
    const archive = join(root, 'upload.zip');
    await streamUpload(request, archive);
    const info = await extractAndVerify(archive, root, id);
    await rm(archive, { force: true });
    const session = { id, root, projectName: info.projectName, createdAt: info.createdAt, tombstones: info.tombstones, expiresAt: Date.now() + 30 * 60 * 1000 };
    sessions.set(token, session);
    return { restoreId: token, projectId: id, projectName: info.projectName, targetName: current.name, createdAt: info.createdAt };
  } catch (error) { await rm(root, { recursive: true, force: true }); throw error; }
}
export async function cancelProjectRestore(token) { removeSession(token); return { ok: true }; }
export async function commitProjectRestore(id, token) {
  const session = sessions.get(token);
  if (!session || session.id !== id || session.expiresAt < Date.now()) { removeSession(token); throw new Error('还原暂存已失效，请重新选择备份。'); }
  await projectForBackup(id);
  const destination = projectRoot(id), stagedProject = join(session.root, 'project');
  const mediaDestination = mediaRoot(id), stagedMedia = join(session.root, 'media');
  const rollbackProject = join(RUNS, `.backup-rollback-${token}`);
  const rollbackMedia = join(RUNS, `.backup-media-rollback-${token}`);
  const hadProject = existsSync(destination), hadMedia = existsSync(mediaDestination);
  let movedProject = false, movedMedia = false, previousIndex;
  try {
    await waitForStoreWrites();
    await mkdir(dirname(mediaDestination), { recursive: true });
    if (hadProject) { await rename(destination, rollbackProject); movedProject = true; }
    if (hadMedia) { await rename(mediaDestination, rollbackMedia); movedMedia = true; }
    await rename(stagedProject, destination);
    await rename(stagedMedia, mediaDestination);
    previousIndex = await restoreProjectTombstones(id, session.tombstones);
    sessions.delete(token);
    await Promise.allSettled([
      rm(rollbackProject, { recursive: true, force: true }),
      rm(rollbackMedia, { recursive: true, force: true }),
      rm(session.root, { recursive: true, force: true })
    ]);
    return { ok: true, projectId: id, projectName: session.projectName };
  } catch (error) {
    if (previousIndex) await rollbackStoreIndex(previousIndex).catch(() => {});
    await rm(destination, { recursive: true, force: true }).catch(() => {});
    await rm(mediaDestination, { recursive: true, force: true }).catch(() => {});
    if (movedProject) await rename(rollbackProject, destination).catch(() => {});
    if (movedMedia) await rename(rollbackMedia, mediaDestination).catch(() => {});
    throw error;
  }
}
