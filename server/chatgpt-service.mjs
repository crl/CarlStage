import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { chooseLocalPort } from '../scripts/local-port.mjs';
import { SETTINGS_FILE } from './settings.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
let child, endpoint, startup, failure = '', currentProxy = '';
let closing = false;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

export function chatgptServiceState() { return { ready: Boolean(endpoint), message: failure || (endpoint ? '内置 ChatGPT 服务已启动' : '内置 ChatGPT 服务正在启动') }; }

export async function stopChatgptService(permanent = false) {
  if (permanent) closing = true;
  const owned = child;
  child = undefined; endpoint = undefined;
  if (!owned || owned.exitCode !== null) return;
  owned.stdin.end();
  for (let i = 0; i < 40 && owned.exitCode === null; i++) await pause(100);
  if (owned.exitCode === null) {
    await new Promise(resolve => {
      const killer = spawn('taskkill', ['/PID', String(owned.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      killer.on('error', resolve); killer.on('exit', resolve);
    });
  }
}

export async function ensureChatgptService(config) {
  if (closing) throw new Error('ChatGPT 服务正在关闭。');
  if (startup) return startup;
  if (endpoint && config.proxy === currentProxy) return { ...config, ...endpoint };
  startup = (async () => {
    if (endpoint) {
      const status = await fetch(`${endpoint.baseUrl}/health`, { headers: endpoint.headers, signal: AbortSignal.timeout(3000) }).then(r => r.json()).catch(() => null);
      if (status?.busy) throw new Error('ChatGPT 正在登录或生成，请结束后再修改代理。');
      await stopChatgptService();
    }
    let python = join(root, 'python', 'python.exe');
    try { await access(python); } catch { python = join(root, '.local-runs', 'chatgpt-python', 'python.exe'); }
    try { await access(python); } catch { throw new Error('ChatGPT 运行环境未准备，请先运行 npm run chatgpt:prepare。'); }
    const port = await chooseLocalPort(8317, 8350, '');
    if (closing) throw new Error('ChatGPT 服务正在关闭。');
    const token = randomUUID();
    currentProxy = config.proxy || '';
    const owned = spawn(python, [join(root, 'server/chatgpt-image-service/service.py')], { windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'], env: { ...process.env, PYTHONIOENCODING: 'utf-8', CARLSTAGE_CHATGPT_DATA: join(dirname(SETTINGS_FILE), 'chatgpt-image'), CARLSTAGE_CHATGPT_TOKEN: token, CARLSTAGE_CHATGPT_PORT: String(port), CARLSTAGE_CHATGPT_PROXY: currentProxy } });
    child = owned;
    let failed = false;
    owned.on('error', () => { failed = true; failure = 'ChatGPT Python 服务无法启动。'; });
    owned.on('exit', () => { if (child === owned) { child = undefined; endpoint = undefined; failure = 'ChatGPT 服务已停止，请检查运行环境后重试。'; } });
    const candidate = { baseUrl: `http://127.0.0.1:${port}`, headers: { 'x-carlstage-service-token': token } };
    for (let i = 0; i < 100; i++) {
      if (closing || child !== owned) break;
      if (failed || owned.exitCode !== null) break;
      const result = await fetch(`${candidate.baseUrl}/health`, { headers: candidate.headers, signal: AbortSignal.timeout(500) }).then(r => r.json()).catch(() => null);
      if (result?.service === 'carlstage-chatgpt-image') { endpoint = candidate; failure = ''; return { ...config, ...candidate }; }
      await pause(100);
    }
    await stopChatgptService();
    throw new Error('ChatGPT 服务启动失败，请重新准备运行环境。');
  })();
  try { return await startup; } catch (error) { failure = error.message; throw error; } finally { startup = undefined; }
}
