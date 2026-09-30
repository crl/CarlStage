import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const bundle = await build({ entryPoints: ['src/db.ts'], bundle: true, platform: 'node', format: 'esm', write: false });
const { mergeStores } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);

test('旧项目媒体补录幂等，删除媒体和变更记录不会跨标签页复现', () => {
  const image = '/api/media/project1/11111111-1111-1111-1111-111111111111.png';
  const video = '/api/media/project1/22222222-2222-2222-2222-222222222222.mp4';
  const project = {
    id: 'project1', updatedAt: 1, referenceImages: [], assets: [], changes: [{ id: 'change1', section: 'cast' }],
    docs: { cast: [{ id: 'character1', name: '甲', image }], art: { scenes: [], props: [] }, storyboard: { shots: [{ id: 'shot1', scene: '庭院', video }] } }
  };
  const initial = mergeStores({ projects: [], library: [] }, { projects: [project], library: [] });
  assert.equal(initial.projects[0].assets.length, 2);
  const repeated = mergeStores(initial, initial);
  assert.equal(repeated.projects[0].assets.length, 2);

  const removed = mergeStores({ ...initial, deletedAssetIds: [initial.projects[0].assets[0].id], deletedImages: [], deletedChangeIds: ['change1'] }, initial);
  assert.equal(removed.projects[0].assets.length, 1);
  assert.equal(removed.projects[0].changes.length, 0);
  assert.match(initial.projects[0].assets[0].id, /^legacy-project1-/);
});

test('已删除的顾问记录不会从旧项目副本恢复', () => {
  const project = { id: 'project1', updatedAt: 1, referenceImages: [], assets: [], changes: [], consultations: [{ id: 'consult1', mode: 'talk', question: '问题', reply: '回复' }], docs: { cast: [], art: { scenes: [], props: [] }, storyboard: { shots: [] } } };
  const stale = { projects: [project], library: [] };
  const merged = mergeStores({ ...stale, deletedConsultationIds: ['consult1'] }, stale);
  assert.deepEqual(merged.projects[0].consultations, []);
});

test('旧格式迁移保留恢复副本；摘要不携带历史快照，历史详情按条读取', async () => {
  const root = await mkdtemp(join(tmpdir(), 'carlstage-store-'));
  const oldRoot = process.env.REELBENCH_DATA_DIR;
  process.env.REELBENCH_DATA_DIR = root;
  try {
    const store = await import(`./store.mjs?test=${Date.now()}`);
    const projectDir = join(root, 'project_old');
    await mkdir(projectDir, { recursive: true });
    const old = {
      id: 'project_old', kind: 'idea', name: '迁移测试', prompt: '测试', updatedAt: 10,
      episodeCount: 1, minDuration: 1, maxDuration: 2, adaptation: '抽核', ratio: '16:9', style: '写实', needCast: true, needArt: true,
      referenceImages: ['data:image/png;base64,' + 'r'.repeat(2000)], keep: '', createdAt: 1,
      docs: { outline: { core: '原内容', episodes: [{ title: '第一集' }] }, script: { episodes: [] }, cast: [{ id: 'c1', name: '角色甲', image: 'data:image/png;base64,abc' }], art: { scenes: [], props: [] }, storyboard: { shots: [] } },
      assets: [{ id: 'asset1', type: 'other', name: '素材', description: '' }],
      changes: Array.from({ length: 30 }, (_, index) => ({ id: `change${index}`, at: index, section: 'outline', label: `历史 ${index}`, before: { core: `before ${index}` }, after: { core: `after ${index}` } })),
      consultations: [], skillArtifacts: {}, sourceText: '原文'
    };
    await writeFile(join(projectDir, 'project.json'), JSON.stringify(old));
    await writeFile(join(root, 'projects.json'), JSON.stringify({ projects: [old], library: [] }));
    const summary = await store.readStoreSummary();
    assert.equal(summary.projects[0].name, old.name);
    assert.equal(summary.projects[0].docStats.outlineEpisodes, 1);
    assert.equal(summary.projects[0].revisions.changes != null, true);
    assert.equal(JSON.stringify(summary).includes('before 0'), false);
    assert.equal(JSON.parse(await readFile(join(root, 'projects.json'), 'utf8')).projects, undefined);
    assert.equal((await readFile(join(projectDir, 'project.json'), 'utf8')).length > 0, true);

    const loaded = await store.readProjectParts(old.id, ['doc-outline', 'assets', 'changes']);
    assert.equal(loaded.docs.outline.core, '原内容');
    assert.equal(loaded.assets[0].id, 'asset1');
    assert.equal(loaded.assets.some(asset => asset.name === '角色甲'), true);
    assert.equal(JSON.stringify(loaded).includes('before 0'), false);
    assert.deepEqual(loaded.referenceImages, []);
    const assetsOnly = await store.readProjectParts(old.id, ['assets']);
    assert.ok(Buffer.byteLength(JSON.stringify(assetsOnly)) < 5000);
    assert.equal((await store.readProjectParts(old.id, ['references'])).referenceImages[0].length, 2022);
    assert.equal(loaded.changes.length, 30);
    const detail = await store.readProjectParts(old.id, ['change:change4']);
    assert.equal(detail.changeDetails.change4.before.core, 'before 4');
    assert.equal(Object.keys(detail.docs).length, 0);
    const revisions = summary.projects[0].revisions;
    const changed = await store.saveProjectMutation(old.id, { expectedRevisions: revisions, updates: { 'doc-outline': { core: '编辑后', episodes: [{ title: '第一集' }] } }, addChanges: [{ id: 'new-change', at: 31, section: 'outline', label: '编辑', before: old.docs.outline, after: { core: '编辑后', episodes: [{ title: '第一集' }] } }] });
    assert.equal(changed.conflict, false);
    const latest = await store.readProjectParts(old.id, ['doc-outline', 'changes']);
    assert.equal(latest.docs.outline.core, '编辑后');
    assert.equal(latest.changes[0].before, undefined);
    assert.equal((await store.readProjectParts(old.id, ['change:new-change'])).changeDetails['new-change'].before.core, '原内容');
  } finally {
    process.env.REELBENCH_DATA_DIR = oldRoot;
    await rm(root, { recursive: true, force: true });
  }
});

test('同一分区检查冲突，不同文档分区可独立修改', async () => {
  const root = await mkdtemp(join(tmpdir(), 'carlstage-conflict-'));
  const oldRoot = process.env.REELBENCH_DATA_DIR;
  process.env.REELBENCH_DATA_DIR = root;
  try {
    const store = await import(`./store.mjs?conflict=${Date.now()}`);
    await store.saveStore({ projects: [{
      id: 'project_new', kind: 'idea', name: '冲突测试', prompt: '测试', updatedAt: 1, episodeCount: 1,
      docs: { outline: { core: '原', episodes: [] }, script: { episodes: [] }, cast: [], art: { scenes: [], props: [] }, storyboard: { shots: [] } },
      assets: [], changes: [], consultations: [], skillArtifacts: {}, referenceImages: []
    }], library: [] });
    const summary = await store.readStoreSummary();
    const expected = summary.projects[0].revisions;
    const a = await store.saveProjectMutation('project_new', { expectedRevisions: expected, updates: { 'doc-outline': { core: 'A' } }, addChanges: [{ id: 'history-a', at: 2, section: 'outline', label: 'A', before: {}, after: {} }] });
    const b = await store.saveProjectMutation('project_new', { expectedRevisions: expected, updates: { 'doc-cast': [{ id: 'c1' }] }, addChanges: [{ id: 'history-b', at: 3, section: 'cast', label: 'B', before: [], after: [{ id: 'c1' }] }] });
    const c = await store.saveProjectMutation('project_new', { expectedRevisions: expected, updates: { 'doc-outline': { core: 'C' } } });
    assert.equal(a.conflict, false);
    assert.equal(b.conflict, false);
    assert.equal(c.conflict, true);
    assert.deepEqual(c.conflicts, ['doc-outline']);
  } finally {
    process.env.REELBENCH_DATA_DIR = oldRoot;
    await rm(root, { recursive: true, force: true });
  }
});
