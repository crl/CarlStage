import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

test('内置服务缺少依赖、启动失败、端口冲突与关闭清理', async () => {
  const root = await mkdtemp(join(tmpdir(), 'carlstage-service-test-'));
  let manager;
  try {
    await mkdir(join(root, 'server/chatgpt-image-service'), { recursive: true });
    await mkdir(join(root, 'scripts'));
    await copyFile(new URL('./chatgpt-service.mjs', import.meta.url), join(root, 'server/chatgpt-service.mjs'));
    await copyFile(new URL('../scripts/local-port.mjs', import.meta.url), join(root, 'scripts/local-port.mjs'));
    await writeFile(join(root, 'server/settings.mjs'), 'export const SETTINGS_FILE = "settings.json";');
    manager = await import(pathToFileURL(join(root, 'server/chatgpt-service.mjs')));
    const config = { proxy: '', timeoutMinutes: 4 };
    await assert.rejects(() => manager.ensureChatgptService(config), /运行环境未准备/);
    await mkdir(join(root, 'python'));
    await copyFile(process.execPath, join(root, 'python/python.exe'));
    const source = join(root, 'server/chatgpt-image-service/service.py');
    await writeFile(source, 'process.exit(1);');
    await assert.rejects(() => manager.ensureChatgptService(config), /服务启动失败/);
    await writeFile(source, `const { createServer } = require('node:http');
      const server = createServer((req,res) => {
        if (req.headers['x-carlstage-service-token'] !== process.env.CARLSTAGE_CHATGPT_TOKEN) { res.writeHead(403); res.end(); return; }
        res.end(JSON.stringify({service:'carlstage-chatgpt-image',busy:false}));
      }).listen(Number(process.env.CARLSTAGE_CHATGPT_PORT),'127.0.0.1');
      process.stdin.resume(); process.stdin.on('end',()=>server.close(()=>process.exit(0)));`);
    const first = await manager.ensureChatgptService(config);
    const health = await fetch(first.baseUrl + '/health', { headers: first.headers });
    assert.equal((await health.json()).service, 'carlstage-chatgpt-image');
    assert.equal((await fetch(first.baseUrl + '/health')).status, 403);
    // A second independent manager must choose another port instead of adopting this process.
    const secondManager = await import(pathToFileURL(join(root, 'server/chatgpt-service.mjs')) + '?second');
    try {
      const second = await secondManager.ensureChatgptService(config);
      assert.notEqual(first.baseUrl, second.baseUrl);
    } finally { await secondManager.stopChatgptService(true); }
    await manager.stopChatgptService(true);
    await assert.rejects(() => fetch(first.baseUrl + '/health'));
    await assert.rejects(() => manager.ensureChatgptService(config), /正在关闭/);
  } finally {
    await manager?.stopChatgptService(true);
    await rm(root, { recursive: true, force: true });
  }
});
