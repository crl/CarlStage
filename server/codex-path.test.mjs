import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveCodexPath } from './codex-path.mjs';

test('优先使用设置里的 Codex 路径，并提示缺失文件', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'carlstage-codex-'));
  const path = join(dir, process.platform === 'win32' ? 'codex.exe' : 'codex');
  try {
    await writeFile(path, '');
    assert.equal(resolveCodexPath({ executablePath: path }), path);
    assert.throws(() => resolveCodexPath({ executablePath: join(dir, 'missing-codex.exe') }), /找不到配置/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
