import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { mapSkillResult } from './map.mjs';
import { singleEpisodeOutlineWarning } from './quality.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'vendor', 'shuohao-skills-pinned', 'skills');
async function fixture(skill) {
  const dir = join(root, skill, 'examples');
  const file = (await readdir(dir)).find(name => name.endsWith('.json'));
  return JSON.parse(await readFile(join(dir, file), 'utf8'));
}

test('五个 skill 的 2.0 原生示例可映射到工作台编辑结构', async () => {
  const project = { style: '半写实' };
  const outline = mapSkillResult('outline', await fixture('novel-outline'), project);
  assert.ok(outline.core && outline.episodes[0]?.summary);
  assert.ok(outline.beats.length && outline.characters.length && outline.scenes.length);
  const cast = mapSkillResult('cast', await fixture('novel-characters'), project);
  assert.ok(cast[0]?.name && cast[0]?.description);
  assert.ok(cast[0]?.persona?.appearance && cast[0]?.voice?.prompt);
  const art = mapSkillResult('art', await fixture('novel-art'), project);
  assert.ok(art.scenes[0]?.name && art.props[0]?.name);
  assert.ok(art.scenes[0]?.anchors.length && art.scenes[0]?.prompt);
  const script = mapSkillResult('script', await fixture('novel-script'), project);
  assert.ok(script.episodes[0]?.scenes[0]?.beats.length);
  assert.ok(script.episodes[0]?.scenes[0]?.flow.length);
  for (const scene of script.episodes.flatMap(episode => episode.scenes)) assert.equal(scene.beats.length, scene.flow.length);
  const storyboard = mapSkillResult('storyboard', await fixture('novel-storyboard'), project);
  assert.ok(storyboard.shots[0]?.action && storyboard.shots[0]?.duration > 0);
  assert.ok(storyboard.shots[0]?.segmentId && storyboard.shots[0]?.episode);
});

test('仅单集大纲的固有结构门可作为明确提示', () => {
  const warning = '✗ 1 处违规（stage=full）：\n质量门未过：大爆点不在最后一集才首次出现（最早在第 1 集）';
  assert.equal(singleEpisodeOutlineWarning('outline', 1, warning), true);
  assert.equal(singleEpisodeOutlineWarning('outline', 2, warning), false);
  assert.equal(singleEpisodeOutlineWarning('script', 1, warning), false);
  assert.equal(singleEpisodeOutlineWarning('outline', 1, warning + '\n质量门未过：角色未登记'), false);
});
