import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

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
