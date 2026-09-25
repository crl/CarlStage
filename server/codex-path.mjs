import { statSync } from 'node:fs';
import { delimiter, join } from 'node:path';

function isFile(path) {
  try { return statSync(path).isFile(); } catch { return false; }
}

export function resolveCodexPath(config = {}) {
  const configured = String(config.executablePath || '').trim();
  if (configured) {
    if (!isFile(configured)) throw new Error('找不到配置的 Codex 可执行文件，请检查设置中的路径。');
    return configured;
  }
  const candidates = [];
  if (process.platform === 'win32' && process.env.APPDATA) {
    candidates.push(join(process.env.APPDATA, 'npm', 'node_modules', '@openai', 'codex', 'node_modules', '@openai', 'codex-win32-x64', 'vendor', 'x86_64-pc-windows-msvc', 'bin', 'codex.exe'));
  }
  const binary = process.platform === 'win32' ? 'codex.exe' : 'codex';
  for (const folder of (process.env.PATH || '').split(delimiter)) if (folder) candidates.push(join(folder, binary));
  const found = candidates.find(isFile);
  if (found) return found;
  throw new Error('未找到 Codex CLI。请在设置中填写 codex.exe 的完整路径，再测试当前模型。');
}
