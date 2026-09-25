import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function freePort() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

test('网页服务保存 Codex 路径并在执行前检查文件', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'carlstage-web-'));
  const port = await freePort();
  const child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: process.cwd(),
    env: { ...process.env, REELBENCH_DATA_DIR: directory, REELBENCH_PORT: String(port) },
    windowsHide: true,
    stdio: 'ignore'
  });
  const base = 'http://127.0.0.1:' + port;
  try {
    let response;
    for (let i = 0; i < 100; i++) {
      try { response = await fetch(base + '/api/settings'); break; }
      catch { await new Promise(resolve => setTimeout(resolve, 50)); }
    }
    assert.ok(response?.ok, '本机网页服务应启动');
    const settings = await response.json();
    const path = join(directory, 'missing', process.platform === 'win32' ? 'codex.exe' : 'codex');
    settings.codex.executablePath = path;
    const saved = await fetch(base + '/api/settings', {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(settings)
    });
    assert.equal(saved.status, 200);
    assert.equal((await (await fetch(base + '/api/settings')).json()).codex.executablePath, path);
    const checked = await fetch(base + '/api/settings/codex/test', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(settings.codex)
    });
    assert.equal(checked.status, 502);
    assert.match((await checked.json()).error, /找不到配置的 Codex/);
  } finally {
    child.kill();
    await rm(directory, { recursive: true, force: true });
  }
});
