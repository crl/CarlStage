import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
export const pythonRuntime = join(root, '.local-runs', 'chatgpt-python');
const version = '3.13.7';
function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve() : reject(new Error('ChatGPT Python 运行环境准备失败。')));
  });
}
async function download(url, file, hash) {
  await run('powershell.exe', ['-NoProfile', '-Command', '& { param($url,$file) $ErrorActionPreference="Stop"; Invoke-WebRequest -Uri $url -OutFile $file -TimeoutSec 120 }', url, file]);
  const bytes = await readFile(file);
  if (hash && createHash('sha256').update(bytes).digest('hex') !== hash) throw new Error('Python 运行环境校验失败。');
  await writeFile(file, bytes);
}
export async function prepareChatgptRuntime() {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('内置 ChatGPT 运行环境目前支持 Windows x64。');
  const requirements = await readFile(join(root, 'server/chatgpt-image-service/requirements.txt'), 'utf8');
  const signature = createHash('sha256').update(version + requirements).digest('hex');
  const marker = join(pythonRuntime, 'ready.txt');
  try { if ((await readFile(marker, 'utf8')) === signature) { await access(join(pythonRuntime, 'python.exe')); return pythonRuntime; } } catch {}
  await mkdir(pythonRuntime, { recursive: true });
  const archive = join(pythonRuntime, 'python.zip');
  await download(`https://www.python.org/ftp/python/${version}/python-${version}-embed-amd64.zip`, archive);
  await run('powershell.exe', ['-NoProfile', '-Command', '& { param($archive,$destination) Expand-Archive -LiteralPath $archive -DestinationPath $destination -Force }', archive, pythonRuntime]);
  await writeFile(join(pythonRuntime, 'python313._pth'), 'python313.zip\n.\nLib/site-packages\nimport site\n');
  const metadataPath = join(pythonRuntime, 'pip-metadata.json');
  await download('https://pypi.org/pypi/pip/25.2/json', metadataPath);
  const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
  const wheel = metadata.urls.find(entry => entry.filename.endsWith('.whl'));
  const wheelPath = join(pythonRuntime, 'pip.zip');
  await download(wheel.url, wheelPath, wheel.digests.sha256);
  const packages = join(pythonRuntime, 'Lib/site-packages');
  await mkdir(packages, { recursive: true });
  const python = join(pythonRuntime, 'python.exe');
  await run(python, ['-c', 'import sys,zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])', wheelPath, packages]);
  await run(python, ['-m', 'pip', 'install', '--disable-pip-version-check', '--only-binary=:all:', '--upgrade', '--target', packages, '-r', join(root, 'server/chatgpt-image-service/requirements.txt')]);
  await run(python, ['-c', 'import fastapi,uvicorn,playwright.sync_api']);
  await writeFile(marker, signature);
  return pythonRuntime;
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await prepareChatgptRuntime();
