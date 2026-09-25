import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const SETTINGS_FILE = join(ROOT, '.local-runs', 'settings.json');
const imageDefaults = { workflowJson: '', promptNodeId: '', promptInput: 'text', referenceNodeId: '', referenceInput: 'image', seedNodeId: '', seedInput: 'seed', widthNodeId: '', widthInput: 'width', heightNodeId: '', heightInput: 'height', stepsNodeId: '', stepsInput: 'steps', cfgNodeId: '', cfgInput: 'cfg', width: 1024, height: 1024, steps: 20, cfg: 7, seed: -1 };
const videoDefaults = { workflowJson: '', promptNodeId: '', promptInput: 'text', referenceNodeId: '', referenceInput: 'image', durationNodeId: '', durationInput: 'duration', seedNodeId: '', seedInput: 'seed', duration: 5, seed: -1 };
export function defaultSettings() { return { codex: { model: process.env.REELBENCH_CODEX_MODEL || 'gpt-5.5', reasoningEffort: 'low', timeoutMinutes: 45 }, comfy: { baseUrl: 'http://127.0.0.1:8188', image: { ...imageDefaults }, video: { ...videoDefaults } } }; }

export function validateComfyUrl(value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('请填写 ComfyUI 地址。');
  let url;
  try { url = new URL(value.trim()); } catch { throw new Error('ComfyUI 地址不是有效 URL。'); }
  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) throw new Error('ComfyUI 仅支持本机 HTTP 地址，例如 http://127.0.0.1:8188。');
  return url.origin;
}
export function validateMapping(workflow, nodeId, input, label) {
  if (!workflow[nodeId] || !Object.hasOwn(workflow[nodeId].inputs, input)) throw new Error(`${label}节点 ID 或输入字段在工作流中不存在。`);
}
export function validateWorkflow(workflowJson, promptNodeId = '', promptInput = 'text') {
  if (!workflowJson) return { nodeCount: 0 };
  let workflow;
  try { workflow = JSON.parse(workflowJson); } catch { throw new Error('工作流 JSON 格式不正确。'); }
  if (!workflow || Array.isArray(workflow) || typeof workflow !== 'object' || !Object.keys(workflow).length || Object.values(workflow).some(node => !node || typeof node !== 'object' || typeof node.class_type !== 'string' || !node.inputs || typeof node.inputs !== 'object' || Array.isArray(node.inputs))) throw new Error('请导入 ComfyUI 的 API 格式工作流 JSON（节点需包含 class_type 和 inputs）。');
  if (promptNodeId) validateMapping(workflow, promptNodeId, promptInput, '提示词');
  return { nodeCount: Object.keys(workflow).length };
}
const numberInRange = (value, name, min, max) => { const n = Number(value); if (!Number.isFinite(n) || n < min || n > max) throw new Error(`${name}应在 ${min}–${max} 之间。`); return n; };
function normalizeWorkflow(input, defaults, kind) {
  const workflowJson = String(input.workflowJson || '').trim();
  if (workflowJson.length > 2_000_000) throw new Error('工作流 JSON 不得超过 2 MB。');
  const result = { workflowJson };
  for (const key of Object.keys(defaults).filter(key => key.endsWith('NodeId') || key.endsWith('Input'))) result[key] = String(input[key] ?? defaults[key]).trim();
  if (workflowJson) {
    validateWorkflow(workflowJson);
    const graph = JSON.parse(workflowJson);
    if (!result.promptNodeId) throw new Error('请填写提示词节点 ID。');
    if (kind === 'video' && (!result.referenceNodeId || !result.durationNodeId)) throw new Error('视频工作流需要首帧图片和时长节点 ID。');
    for (const [prefix, label] of [['prompt', '提示词'], ['reference', '参考图'], ['duration', '时长'], ['seed', '种子'], ['width', '宽度'], ['height', '高度'], ['steps', '采样步数'], ['cfg', 'CFG']]) {
      if (result[`${prefix}NodeId`]) validateMapping(graph, result[`${prefix}NodeId`], result[`${prefix}Input`], label);
    }
  }
  if (kind === 'image') return { ...result, width: numberInRange(input.width, '宽度', 64, 8192), height: numberInRange(input.height, '高度', 64, 8192), steps: numberInRange(input.steps, '采样步数', 1, 200), cfg: numberInRange(input.cfg, 'CFG', 0, 100), seed: numberInRange(input.seed, '随机种子', -1, Number.MAX_SAFE_INTEGER) };
  return { ...result, duration: numberInRange(input.duration, '视频时长', 1, 15), seed: numberInRange(input.seed, '随机种子', -1, Number.MAX_SAFE_INTEGER) };
}
export function normalizeSettings(input) {
  if (!input || typeof input !== 'object') throw new Error('设置内容无效。');
  const defaults = defaultSettings(); const codex = { ...defaults.codex, ...input.codex }; const comfy = input.comfy || {};
  const model = String(codex.model || '').trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{1,79}$/.test(model)) throw new Error('Codex 模型名称无效。');
  if (!['low', 'medium', 'high', 'xhigh'].includes(codex.reasoningEffort)) throw new Error('请选择有效的推理强度。');
  const legacyImage = comfy.image ? {} : comfy;
  return { codex: { model, reasoningEffort: codex.reasoningEffort, timeoutMinutes: numberInRange(codex.timeoutMinutes, '任务超时分钟数', 1, 180) }, comfy: { baseUrl: validateComfyUrl(comfy.baseUrl || defaults.comfy.baseUrl), image: normalizeWorkflow({ ...imageDefaults, ...legacyImage, ...comfy.image }, imageDefaults, 'image'), video: normalizeWorkflow({ ...videoDefaults, ...comfy.video }, videoDefaults, 'video') } };
}
export async function loadSettings() { try { return normalizeSettings(JSON.parse(await readFile(SETTINGS_FILE, 'utf8'))); } catch (error) { if (error?.code === 'ENOENT') return defaultSettings(); throw error; } }
export async function saveSettings(value) { const normalized = normalizeSettings(value); await mkdir(dirname(SETTINGS_FILE), { recursive: true }); await writeFile(SETTINGS_FILE, JSON.stringify(normalized, null, 2), { encoding: 'utf8', mode: 0o600 }); return normalized; }
export async function testComfyConnection(baseUrl) { const origin = validateComfyUrl(baseUrl); const response = await fetch(`${origin}/system_stats`, { signal: AbortSignal.timeout(5000) }); if (!response.ok) throw new Error(`ComfyUI 返回 HTTP ${response.status}。`); const stats = await response.json(); if (!stats || typeof stats !== 'object' || !stats.system) throw new Error('地址可访问，但没有返回 ComfyUI 的系统信息。'); return { ok: true, baseUrl: origin, version: stats.system.comfyui_version || '', devices: Array.isArray(stats.devices) ? stats.devices.map(d => d.name || d.type || '设备') : [] }; }
