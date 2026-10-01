import { prepareChatgptRuntime } from './prepare-chatgpt-runtime.mjs';
import { cp, mkdir, copyFile, rm, readFile, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const runtime = join(root, 'desktop-runtime');
await rm(runtime, { recursive: true, force: true });
await mkdir(runtime, { recursive: true });
for (const folder of ['server', 'dist', 'vendor/shuohao-skills-pinned/skills']) {
  await cp(join(root, folder), join(runtime, folder), { recursive: true });
}
const pythonRuntime = await prepareChatgptRuntime();
await cp(pythonRuntime, join(runtime, 'python'), { recursive: true });
await mkdir(join(runtime, 'scripts'), { recursive: true });
await copyFile(join(root, 'scripts/local-port.mjs'), join(runtime, 'scripts/local-port.mjs'));
await copyFile(join(root, 'package.json'), join(runtime, 'package.json'));
await copyFile(join(root, 'package-lock.json'), join(runtime, 'package-lock.json'));
await copyFile(process.execPath, join(runtime, process.platform === 'win32' ? 'node.exe' : 'node'));
const license = join(dirname(process.execPath), 'LICENSE');
try { await copyFile(license, join(runtime, 'NODE-LICENSE')); } catch {}
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
if (!pkg.dependencies?.['@openai/codex-sdk']) throw new Error('缺少 Codex SDK 依赖');
await new Promise((resolve, reject) => {
  const command = spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['ci', '--omit=dev', '--ignore-scripts'], { cwd: runtime, stdio: 'inherit', shell: process.platform === 'win32', windowsHide: true });
  command.on('error', reject);
  command.on('exit', code => code === 0 ? resolve() : reject(new Error('桌面运行环境依赖安装失败')));
});
const openaiModules = join(runtime, 'node_modules', '@openai');
for (const name of await readdir(openaiModules)) {
  if (/^codex-(?:darwin|linux|win32)-/.test(name)) await rm(join(openaiModules, name), { recursive: true, force: true });
}
console.log('桌面运行环境已准备好：' + runtime);
