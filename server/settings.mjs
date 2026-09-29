import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PRESETS } from './presets.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const SETTINGS_FILE = join(process.env.REELBENCH_DATA_DIR || join(ROOT, '.local-runs'), 'settings.json');
const imageDefaults = { workflowJson: '', promptNodeId: '', promptInput: 'text', referenceNodeId: '', referenceInput: 'image', seedNodeId: '', seedInput: 'seed', widthNodeId: '', widthInput: 'width', heightNodeId: '', heightInput: 'height', stepsNodeId: '', stepsInput: 'steps', cfgNodeId: '', cfgInput: 'cfg', width: 1024, height: 1024, steps: 20, cfg: 7, seed: -1 };
const videoDefaults = { workflowJson: '', promptNodeId: '', promptInput: 'text', referenceNodeId: '', referenceInput: 'image', durationNodeId: '', durationInput: 'duration', seedNodeId: '', seedInput: 'seed', duration: 5, seed: -1, referenceSlots: [] };
export function defaultSettings() { return { showCreativeTemplates: true, codex: { provider: 'codex', executablePath: '', model: process.env.REELBENCH_CODEX_MODEL || 'gpt-5.5', ollamaModel: 'gemma4:latest', reasoningEffort: 'low', timeoutMinutes: 45 }, imageProvider: 'qwen', gptImage: { model: 'gpt-image-2.5-sunburst', quality: 'medium', apiKey: '' }, comfy: { baseUrl: 'http://127.0.0.1:8188', image: { ...PRESETS.image }, imageEdit: { ...PRESETS.imageEdit }, video: { ...PRESETS.video } } }; }
export function publicSettings(settings) { return { ...settings, gptImage: { ...settings.gptImage, apiKey: undefined, hasApiKey: !!(settings.gptImage.apiKey || process.env.OPENAI_API_KEY) } }; }
export function getPreset(kind) { if (!Object.hasOwn(PRESETS, kind)) throw new Error('未知工作流预设。'); return structuredClone(PRESETS[kind]); }

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
    if (kind === 'imageEdit' && !result.referenceNodeId) throw new Error('参考图编辑工作流需要参考图节点 ID。');
    for (const [prefix, label] of [['prompt', '提示词'], ['reference', '参考图'], ['duration', '时长'], ['seed', '种子'], ['width', '宽度'], ['height', '高度'], ['steps', '采样步数'], ['cfg', 'CFG']]) {
      if (result[`${prefix}NodeId`]) validateMapping(graph, result[`${prefix}NodeId`], result[`${prefix}Input`], label);
    }
  }
  if (kind !== 'video') return { ...result, width: numberInRange(input.width, '宽度', 64, 8192), height: numberInRange(input.height, '高度', 64, 8192), steps: numberInRange(input.steps, '采样步数', 1, 200), cfg: numberInRange(input.cfg, 'CFG', 0, 100), seed: numberInRange(input.seed, '随机种子', -1, Number.MAX_SAFE_INTEGER) };
  const referenceSlots = input.referenceSlots ?? [];
  if (!Array.isArray(referenceSlots) || referenceSlots.length > 7) throw new Error('视频多图节点最多配置 7 个附加位置。');
  const slots = referenceSlots.map((slot, index) => {
    const mapped = { imageNodeId: String(slot?.imageNodeId || '').trim(), imageInput: String(slot?.imageInput || '').trim(), timeNodeId: String(slot?.timeNodeId || '').trim(), timeInput: String(slot?.timeInput || '').trim() };
    if (Object.values(mapped).some(value => !value)) throw new Error(`第 ${index + 2} 张参考图的图片和切点节点必须填写完整。`);
    if (workflowJson) { const graph = JSON.parse(workflowJson); validateMapping(graph, mapped.imageNodeId, mapped.imageInput, `第 ${index + 2} 张图片`); validateMapping(graph, mapped.timeNodeId, mapped.timeInput, `第 ${index + 2} 张切点`); }
    return mapped;
  });
  return { ...result, duration: numberInRange(input.duration, '视频时长', 1, 15), seed: numberInRange(input.seed, '随机种子', -1, Number.MAX_SAFE_INTEGER), referenceSlots: slots };
}
export function normalizeSettings(input) {
  if (!input || typeof input !== 'object') throw new Error('设置内容无效。');
  const defaults = defaultSettings(); const codex = { ...defaults.codex, ...input.codex }; const comfy = input.comfy || {};
  const model = String(codex.model || '').trim();
  const executablePath = String(codex.executablePath || '').trim();
  if (executablePath && (!isAbsolute(executablePath) || executablePath.length > 1000 || !/codex(?:\.exe)?$/i.test(executablePath))) throw new Error('请填写 Codex 可执行文件的绝对路径（codex.exe）。');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{1,79}$/.test(model)) throw new Error('Codex 模型名称无效。');
  if (!['codex', 'ollama'].includes(codex.provider)) throw new Error('请选择有效的模型服务。');
  const ollamaModel = String(codex.ollamaModel || '').trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,79}$/.test(ollamaModel)) throw new Error('Ollama 模型名称无效。');
  if (!['low', 'medium', 'high', 'xhigh'].includes(codex.reasoningEffort)) throw new Error('请选择有效的推理强度。');
  const legacyImage = comfy.image ? {} : comfy;
  const provider = input.imageProvider ?? defaults.imageProvider;
  if (!['qwen', 'gpt'].includes(provider)) throw new Error('请选择有效的生图方式。');
  const gpt = { ...defaults.gptImage, ...input.gptImage };
  if (!['gpt-image-2.5-sunburst', 'gpt-image-2.5-flare'].includes(gpt.model)) throw new Error('GPT Image 2.5 模型无效。');
  if (!['low', 'medium', 'high', 'xhigh', 'max'].includes(gpt.quality)) throw new Error('GPT Image 2.5 质量无效。');
  if (typeof gpt.apiKey !== 'string' || gpt.apiKey.length > 500) throw new Error('API Key 无效。');
  const image = normalizeWorkflow({ ...imageDefaults, ...legacyImage, ...comfy.image }, imageDefaults, 'image');
  const imageEdit = normalizeWorkflow({ ...PRESETS.imageEdit, ...comfy.imageEdit }, imageDefaults, 'imageEdit');
  for (const [kind, workflow] of [['image', image], ['imageEdit', imageEdit]]) {
    try {
      const graph = JSON.parse(workflow.workflowJson);
      const sampler = Object.values(graph).find(node => node.class_type === 'KSampler' && node.inputs?.latent_image?.[1] === 2);
      const textEncoder = sampler && graph[sampler.inputs.latent_image[0]];
      const bundledDefault = graph['1']?.class_type === 'UNETLoader' && graph['1'].inputs?.unet_name === 'qwen_image_2.1_int8_convrot.safetensors' && textEncoder?.class_type === 'TextEncodeQwenImage21' && !Object.values(graph).some(node => ['EmptySD3LatentImage', 'EmptyLatentImage'].includes(node.class_type));
      const bundledLegacyEdit = kind === 'imageEdit'
        && graph['1']?.class_type === 'UNETLoader'
        && graph['1'].inputs?.unet_name === 'qwen_image_2.1_int8_convrot.safetensors'
        && graph['5']?.class_type === 'TextEncodeQwenImage21'
        && graph['6']?.class_type === 'KSampler'
        && graph['6'].inputs?.latent_image?.[0] === '10'
        && graph['9']?.class_type === 'LoadImage'
        && graph['10']?.class_type === 'EmptySD3LatentImage';
      if (bundledDefault || bundledLegacyEdit) Object.assign(workflow, PRESETS[kind]);
    } catch { /* Custom workflows are validated and preserved below. */ }
  }
  return { showCreativeTemplates: typeof input.showCreativeTemplates === 'boolean' ? input.showCreativeTemplates : defaults.showCreativeTemplates, codex: { provider: codex.provider, executablePath, model, ollamaModel, reasoningEffort: codex.reasoningEffort, timeoutMinutes: numberInRange(codex.timeoutMinutes, '任务超时分钟数', 1, 180) }, imageProvider: provider, gptImage: { model: gpt.model, quality: gpt.quality, apiKey: gpt.apiKey }, comfy: { baseUrl: validateComfyUrl(comfy.baseUrl || defaults.comfy.baseUrl), image, imageEdit, video: normalizeWorkflow({ ...PRESETS.video, ...comfy.video }, videoDefaults, 'video') } };
}
export async function loadSettings() { try { return normalizeSettings(JSON.parse(await readFile(SETTINGS_FILE, 'utf8'))); } catch (error) { if (error?.code === 'ENOENT') return defaultSettings(); throw error; } }
export async function saveSettings(value) { const normalized = normalizeSettings(value); await mkdir(dirname(SETTINGS_FILE), { recursive: true }); await writeFile(SETTINGS_FILE, JSON.stringify(normalized, null, 2), { encoding: 'utf8', mode: 0o600 }); return normalized; }
export async function testComfyConnection(baseUrl) { const origin = validateComfyUrl(baseUrl); const response = await fetch(`${origin}/system_stats`, { signal: AbortSignal.timeout(5000) }); if (!response.ok) throw new Error(`ComfyUI 返回 HTTP ${response.status}。`); const stats = await response.json(); if (!stats || typeof stats !== 'object' || !stats.system) throw new Error('地址可访问，但没有返回 ComfyUI 的系统信息。'); return { ok: true, baseUrl: origin, version: stats.system.comfyui_version || '', devices: Array.isArray(stats.devices) ? stats.devices.map(d => d.name || d.type || '设备') : [] }; }
export async function checkComfyWorkflow(baseUrl, config) {
  validateWorkflow(config.workflowJson);
  if (!config.workflowJson) throw new Error('请先导入或恢复工作流。');
  const origin = validateComfyUrl(baseUrl);
  const graph = JSON.parse(config.workflowJson);
  const needed = [...new Set(Object.values(graph).map(node => node.class_type))];
  const missingNodes = [];
  for (const name of needed) {
    const response = await fetch(`${origin}/object_info/${encodeURIComponent(name)}`, { signal: AbortSignal.timeout(5000) });
    if (!response.ok || !(await response.json())[name]) missingNodes.push(name);
  }
  const folders = { UNETLoader: 'diffusion_models', CLIPLoader: 'text_encoders', VAELoader: 'vae' };
  const missingModels = [];
  for (const [className, folder] of Object.entries(folders)) {
    const response = await fetch(`${origin}/models/${folder}`, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(`无法读取 ComfyUI ${folder} 模型列表。`);
    const models = await response.json();
    for (const node of Object.values(graph).filter(node => node.class_type === className)) {
      const name = node.inputs.unet_name || node.inputs.clip_name || node.inputs.vae_name;
      if (!models.includes(name)) missingModels.push(`${folder}/${name}`);
    }
  }
  return { ok: !missingNodes.length && !missingModels.length, missingNodes, missingModels, nodeCount: needed.length };
}
export const checkComfyPreset = (baseUrl, kind) => checkComfyWorkflow(baseUrl, getPreset(kind));
