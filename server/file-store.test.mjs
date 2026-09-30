import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('项目写入本机文件，跨窗口合并并保留删除标记', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'carlstage-store-'));
  process.env.REELBENCH_DATA_DIR = directory;
  try {
    const { readStore, saveStore } = await import('./store.mjs?test=' + Date.now());
    await saveStore({ projects: [{ id: 'one', updatedAt: 1, assets: [], changes: [], referenceImages: [] }], library: [] });
    await saveStore({ projects: [{ id: 'two', updatedAt: 2, assets: [], changes: [], referenceImages: [] }], library: [] });
    assert.deepEqual((await readStore()).projects.map(project => project.id), ['two', 'one']);
    const index = JSON.parse(await readFile(join(directory, 'projects.json'), 'utf8'));
    assert.deepEqual(index.projectIds, ['two', 'one']);
    assert.equal(index.projects, undefined);
    const manifest = JSON.parse(await readFile(join(directory, 'one', 'manifest.json'), 'utf8'));
    assert.ok(manifest.revisions['doc-outline']);
    assert.equal(JSON.parse(await readFile(join(directory, 'one', 'parts', `meta.${manifest.revisions.meta}.json`), 'utf8')).id, 'one');
    await saveStore({ projects: [], library: [], deletedProjectIds: ['one'] });
    assert.deepEqual((await readStore()).projects.map(project => project.id), ['two']);
    assert.equal(JSON.parse(await readFile(join(directory, 'projects.json'), 'utf8')).deletedProjectIds[0], 'one');
  } finally {
    delete process.env.REELBENCH_DATA_DIR;
    await rm(directory, { recursive: true, force: true });
  }
});

test('只读取资产库时也能识别旧分镜图片与历史版本', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'carlstage-storyboard-assets-'));
  process.env.REELBENCH_DATA_DIR = directory;
  try {
    const { saveStore, readProjectParts } = await import('./store.mjs?storyboard=' + Date.now());
    const assets = [
      { id: 'current', type: 'other', image: '/current.png', sourceItemId: 'shot-1' },
      { id: 'history', type: 'other', image: '/history.png', sourceItemId: 'shot-1' },
      { id: 'video', type: 'other', video: '/video.mp4', sourceItemId: 'shot-1' },
      { id: 'unrelated', type: 'other', image: '/unrelated.png', name: 'E01-01-02' },
    ];
    await saveStore({ projects: [{ id: 'project-1', updatedAt: 1, docs: { storyboard: { shots: [{ id: 'shot-1', image: '/current.png' }] } }, assets, changes: [], referenceImages: [] }], library: [] });
    const manifest = JSON.parse(await readFile(join(directory, 'project-1', 'manifest.json'), 'utf8'));
    // 模拟升级前已保存的资产分区，不加载分镜文档。
    await writeFile(join(directory, 'project-1', 'parts', `assets.${manifest.revisions.assets}.json`), JSON.stringify(assets));
    const loaded = await readProjectParts('project-1', ['assets']);
    assert.deepEqual(loaded.assets.map(asset => asset.type), ['storyboard', 'storyboard', 'other', 'other']);
    assert.equal(loaded.docs.storyboard, undefined);
  } finally {
    delete process.env.REELBENCH_DATA_DIR;
    await rm(directory, { recursive: true, force: true });
  }
});
