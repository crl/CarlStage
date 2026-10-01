import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { finished } from 'node:stream/promises';
import yazl from 'yazl';

const dataRoot = await mkdtemp(join(tmpdir(), 'carlstage-backup-'));
process.env.REELBENCH_DATA_DIR = dataRoot;
const [{ createProject, readStore, saveStore, saveStoreIndex }, backup, media] = await Promise.all([
  import('./store.mjs?project-backup-test'),
  import('./project-backup.mjs?project-backup-test'),
  import('./media.mjs?project-backup-test')
]);

test('项目备份可以完整还原，拒绝不匹配和恶意归档且取消不改动项目', async t => {
  t.after(async () => { await rm(dataRoot, { recursive: true, force: true }); });
  const id = 'backup-project-001';
  const filename = '12345678-1234-1234-1234-123456789abc.png';
  const libraryPath = media.mediaFilePath('library', filename);
  await mkdir(dirname(libraryPath), { recursive: true });
  await writeFile(libraryPath, Buffer.from('media-bytes'));
  await createProject({
    id, kind: 'idea', name: '备份测试项目', prompt: '项目正文', episodeCount: 1, minDuration: 1, maxDuration: 1,
    adaptation: '抽象', ratio: '16:9', style: '电影剧照', needCast: true, needArt: true, referenceImages: [], keep: '',
    createdAt: 1, updatedAt: 2, docs: { outline: { title: '大纲' }, script: {}, cast: [], art: {}, storyboard: {} },
    assets: [
      { id: 'asset-001', type: 'character', name: '角色', description: '', image: `/api/media/library/${filename}` },
      { id: 'asset-deleted', type: 'prop', name: '已删除素材', description: '' }
    ],
    changes: [
      { id: 'change-001', at: 1, section: 'outline', label: '初始版本', before: { title: '旧' }, after: { title: '大纲' } },
      { id: 'change-deleted', at: 2, section: 'outline', label: '已删除记录' }
    ],
    consultations: [], skillArtifacts: {}, sourceText: '原文', generatedSource: '扩写', skillProjectImported: true
  });
  const initialProject = (await readStore()).projects.find(project => project.id === id);
  await createProject({ ...initialProject, id: 'other-project-001', name: '另一个项目' });
  await saveStoreIndex({ deletedAssetIds: ['asset-deleted'], deletedChangeIds: ['change-deleted'] });
  await mkdir(join(dataRoot, id, 'proj'), { recursive: true });
  await writeFile(join(dataRoot, id, 'proj', 'index.html'), '<html>项目资源</html>');

  const response = new PassThrough();
  response.writeHead = () => {};
  const chunks = [];
  response.on('data', chunk => chunks.push(chunk));
  const complete = finished(response);
  await backup.writeProjectBackup(id, response);
  await complete;
  const archive = Buffer.concat(chunks);

  const current = (await readStore()).projects.find(project => project.id === id);
  await saveStore({ projects: [{ ...current, name: '被覆盖的名字', updatedAt: Date.now() + 60_000 }], library: [] });
  const staged = await backup.prepareProjectRestore(id, Readable.from(archive));
  assert.equal(staged.projectName, '备份测试项目');
  assert.equal(staged.targetName, '被覆盖的名字');

  await backup.cancelProjectRestore(staged.restoreId);
  assert.equal((await readStore()).projects.find(project => project.id === id).name, '被覆盖的名字');

  await assert.rejects(backup.prepareProjectRestore('other-project-001', Readable.from(archive)), /不属于当前项目/);
  await assert.rejects(backup.prepareProjectRestore(id, Readable.from(Buffer.from('not a zip archive'))));
  const sourceManifest = await readFile(join(dataRoot, id, 'manifest.json'));
  const integrityZip = new yazl.ZipFile();
  integrityZip.addBuffer(Buffer.from(JSON.stringify({ format: 'carlstage-project-backup', version: 1, projectId: id, files: [{ path: 'project/manifest.json', size: sourceManifest.length, sha256: '0'.repeat(64) }] })), 'backup-manifest.json');
  integrityZip.addBuffer(sourceManifest, 'project/manifest.json');
  integrityZip.end();
  const integrityChunks = [];
  integrityZip.outputStream.on('data', chunk => integrityChunks.push(chunk));
  await new Promise((resolve, reject) => { integrityZip.outputStream.once('end', resolve); integrityZip.outputStream.once('error', reject); });
  await assert.rejects(backup.prepareProjectRestore(id, Readable.from(Buffer.concat(integrityChunks))), /校验失败/);
  const hostileZip = new yazl.ZipFile();
  hostileZip.addBuffer(Buffer.from(JSON.stringify({ format: 'carlstage-project-backup', version: 1, projectId: id, files: [{ path: 'project/../../outside.txt', size: 0, sha256: '0'.repeat(64) }] })), 'backup-manifest.json');
  hostileZip.end();
  const hostileChunks = [];
  hostileZip.outputStream.on('data', chunk => hostileChunks.push(chunk));
  await new Promise((resolve, reject) => { hostileZip.outputStream.once('end', resolve); hostileZip.outputStream.once('error', reject); });
  await assert.rejects(backup.prepareProjectRestore(id, Readable.from(Buffer.concat(hostileChunks))), /路径/);
  assert.equal((await readStore()).projects.find(project => project.id === id).name, '被覆盖的名字');

  const restore = await backup.prepareProjectRestore(id, Readable.from(archive));
  await backup.commitProjectRestore(id, restore.restoreId);
  const restored = (await readStore()).projects.find(project => project.id === id);
  const other = (await readStore()).projects.find(project => project.id === 'other-project-001');
  assert.equal(restored.name, '备份测试项目');
  assert.equal(other.name, '另一个项目');
  assert.equal(restored.sourceText, '原文');
  assert.equal(restored.changes[0].label, '初始版本');
  assert.equal(restored.assets.some(asset => asset.id === 'asset-deleted'), false);
  assert.equal(restored.changes.some(change => change.id === 'change-deleted'), false);
  assert.equal(restored.skillProjectImported, true);
  assert.equal(restored.assets[0].image, `/api/media/${id}/${filename}`);
  assert.equal(await readFile(media.mediaFilePath(id, filename), 'utf8'), 'media-bytes');
  assert.equal(await readFile(join(dataRoot, id, 'proj', 'index.html'), 'utf8'), '<html>项目资源</html>');
});
