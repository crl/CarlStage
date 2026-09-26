import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ollamaChat } from './ollama.mjs';

test('Ollama write_output uses the server-selected path and persists the deliverable', async t => {
  const workspace = await mkdtemp(join(tmpdir(), 'reelbench-ollama-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    const message = calls === 1
      ? { role: 'assistant', tool_calls: [{ function: { name: 'write_output', arguments: { content: '# 改编骨架\n\n主角与冲突' } } }] }
      : { role: 'assistant', content: '最终产物已写入，任务完成。' };
    return new Response(JSON.stringify({ message }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const result = await ollamaChat({ model: 'test-model', reasoningEffort: 'low' }, [{ role: 'user', content: '写一份骨架' }], { workspace, skill: 'novel-outline', outputPath: 'output/outline-skeleton.md' });
  assert.match(result, /任务完成/);
  assert.equal(await readFile(join(workspace, 'output', 'outline-skeleton.md'), 'utf8'), '# 改编骨架\n\n主角与冲突');
});
