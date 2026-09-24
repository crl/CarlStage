import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const SETTINGS_FILE = join(ROOT, '.local-runs', 'settings.json');
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh']);

export function defaultSettings() {
  return {
    codex: {
      model: process.env.REELBENCH_CODEX_MODEL || 'gpt-5.5',
      reasoningEffort: 'low',
      timeoutMinutes: 45
    },
    comfy: {
      baseUrl: 'http://127.0.0.1:8188',
      workflowJson: '',
      promptNodeId: '',
      promptInput: 'text',
      seedNodeId: '',
      seedInput: 'seed',
      width: 1024,
      height: 1024,
      steps: 20,
      cfg: 7,
      seed: -1
    }
  };
}

export function validateComfyUrl(value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('请填写 ComfyUI 地址。');
  let url;
  try { url = new URL(value.trim()); } catch { throw new Error('ComfyUI 地址不是有效 URL。'); }
  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) {
    throw new Error('ComfyUI 仅支持本机 HTTP 地址，例如 http://127.0.0.1:8188。');
  }
  return url.origin;
}

export function validateWorkflow(workflowJson, promptNodeId, promptInput) {
  if (!workflowJson) return { nodeCount: 0 };
  let workflow;
  try { workflow = JSON.parse(workflowJson); } catch { throw new Error('工作流 JSON 格式不正确。'); }
  if (!workflow || Array.isArray(workflow) || typeof workflow !== 'object' || !Object.keys(workflow).length ||
      Object.values(workflow).some(node => !node || typeof node !== 'object' || typeof node.class_type !== 'string' || !node.inputs || typeof node.inputs !== 'object')) {
    throw new Error('请导入 ComfyUI 的 API 格式工作流 JSON（节点需包含 class_type 和 inputs）。');
  }
  if (promptNodeId && (!workflow[promptNodeId] || !(promptInput in workflow[promptNodeId].inputs))) {
    throw new Error('提示词节点 ID 或输入字段在工作流中不存在。');
  }
  return { nodeCount: Object.keys(workflow).length };
}

const numberInRange = (value, name, min, max) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) throw new Error(`${name}应在 ${min}–${max} 之间。`);
  return n;
};

export function normalizeSettings(input) {
  if (!input || typeof input !== 'object') throw new Error('设置内容无效。');
  const codex = input.codex || {};
  const comfy = input.comfy || {};
  const model = String(codex.model || '').trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{1,79}$/.test(model)) throw new Error('Codex 模型名称无效。');
  if (!EFFORTS.has(codex.reasoningEffort)) throw new Error('请选择有效的推理强度。');
  const baseUrl = validateComfyUrl(comfy.baseUrl);
  const workflowJson = String(comfy.workflowJson || '').trim();
  if (workflowJson.length > 2_000_000) throw new Error('工作流 JSON 不得超过 2 MB。');
  const promptNodeId = String(comfy.promptNodeId || '').trim();
  const promptInput = String(comfy.promptInput || 'text').trim();
  const seedNodeId = String(comfy.seedNodeId || '').trim();
  const seedInput = String(comfy.seedInput || 'seed').trim();
  if (workflowJson) {
    validateWorkflow(workflowJson, promptNodeId, promptInput);
    if (seedNodeId) {
      const workflow = JSON.parse(workflowJson);
      if (!workflow[seedNodeId] || !(seedInput in workflow[seedNodeId].inputs)) throw new Error('种子节点 ID 或输入字段在工作流中不存在。');
    }
  }
  return {
    codex: {
      model,
      reasoningEffort: codex.reasoningEffort,
      timeoutMinutes: numberInRange(codex.timeoutMinutes, '任务超时分钟数', 1, 180)
    },
    comfy: {
      baseUrl,
      workflowJson,
      promptNodeId,
      promptInput,
      seedNodeId,
      seedInput,
      width: numberInRange(comfy.width, '宽度', 64, 8192),
      height: numberInRange(comfy.height, '高度', 64, 8192),
      steps: numberInRange(comfy.steps, '采样步数', 1, 200),
      cfg: numberInRange(comfy.cfg, 'CFG', 0, 100),
      seed: numberInRange(comfy.seed, '随机种子', -1, Number.MAX_SAFE_INTEGER)
    }
  };
}

export async function loadSettings() {
  try { return normalizeSettings(JSON.parse(await readFile(SETTINGS_FILE, 'utf8'))); }
  catch (error) {
    if (error?.code === 'ENOENT') return defaultSettings();
    throw error;
  }
}

export async function saveSettings(value) {
  const normalized = normalizeSettings(value);
  await mkdir(dirname(SETTINGS_FILE), { recursive: true });
  await writeFile(SETTINGS_FILE, JSON.stringify(normalized, null, 2), { encoding: 'utf8', mode: 0o600 });
  return normalized;
}

export async function testComfyConnection(baseUrl) {
  const origin = validateComfyUrl(baseUrl);
  const response = await fetch(`${origin}/system_stats`, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`ComfyUI 返回 HTTP ${response.status}。`);
  const stats = await response.json();
  if (!stats || typeof stats !== 'object' || !stats.system) throw new Error('地址可访问，但没有返回 ComfyUI 的系统信息。');
  return { ok: true, baseUrl: origin, version: stats.system.comfyui_version || '', devices: Array.isArray(stats.devices) ? stats.devices.map(d => d.name || d.type || '设备') : [] };
}
