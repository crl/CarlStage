import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
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
    await saveStore({ projects: [], library: [], deletedProjectIds: ['one'] });
    assert.deepEqual((await readStore()).projects.map(project => project.id), ['two']);
    assert.equal(JSON.parse(await readFile(join(directory, 'projects.json'), 'utf8')).deletedProjectIds[0], 'one');
  } finally {
    delete process.env.REELBENCH_DATA_DIR;
    await rm(directory, { recursive: true, force: true });
  }
});
