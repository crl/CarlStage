import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, copyFile, rm, open, rename } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { validateComfyUrl, validateWorkflow, validateMapping } from './settings.mjs';
import { generateChatgptImage } from './chatgpt-image.mjs';
import { sourceBytes } from './gpt-image.mjs';
import { formatGptImagePrompt, generateGptImage } from './gpt-image.mjs';
import sharp from 'sharp';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const MEDIA = join(process.env.REELBENCH_DATA_DIR || join(ROOT, '.local-runs'), 'media');
const jobs = new Map();
const pending = { comfyui: [], other: [] };
const activeJobs = { comfyui: null, other: null };
const queueType = job => ['gpt', 'chatgpt'].includes(job.provider) ? 'other' : 'comfyui';
const imageRatios = new Set(['1:1', '9:16', '16:9', '3:4', '4:3', '3:2', '2:3', '4:5', '5:4', '21:9']);
const aspectOf = ratio => { const [width, height] = String(ratio || '16:9').split(':').map(Number); return width > 0 && height > 0 ? width / height : 16 / 9; };
const videoResolutionArea = (ratio, resolution) => resolution ** 2 * Math.max(aspectOf(ratio), 1 / aspectOf(ratio));
function imageDimensions(ratio, area = 1_327_104) {
  const [ratioWidth, ratioHeight] = String(ratio || '16:9').split(':').map(Number);
  const widthFactor = ratioWidth > 0 ? ratioWidth : 16; const heightFactor = ratioHeight > 0 ? ratioHeight : 9; const unit = 16;
  const scale = Math.max(1, Math.round(Math.sqrt(area / (widthFactor * heightFactor)) / unit)) * unit;
  let width = widthFactor * scale;
  let height = heightFactor * scale;
  if (!Number.isFinite(width) || !Number.isFinite(height)) { width = 1536; height = 864; }
  return { width, height };
}
// ResolutionSelector's enum depends on the installed ComfyUI node version.
// Set explicit latent dimensions for every ratio and only change the selector
// when its commonly supported labels are known.
const qwenRatioLabels = { '1:1': '1:1 (Square)', '9:16': '9:16 (Portrait Widescreen)', '16:9': '16:9 (Widescreen)', '3:4': '3:4 (Portrait)', '4:3': '4:3 (Landscape)', '3:2': '3:2 (Landscape)', '2:3': '2:3 (Portrait)' };
const safeId = value => { if (!/^[a-zA-Z0-9_-]{3,80}$/.test(value)) throw new Error('项目 ID 无效。'); return value; };
const filePath = (projectId, name) => { safeId(projectId); if (!/^[a-f0-9-]{36}\.(png|jpg|jpeg|webp|mp4|webm|mov|mp3|wav|flac|ogg)$/.test(name)) throw new Error('媒体文件名无效。'); return join(MEDIA, projectId, name); };
const publicJob = job => {
  const { source, sources, lyrics, config, controller, cancelPromise, runPromise, cancelled, ...visible } = job;
  const queue = queueType(job);
  return { ...visible, queueType: queue, ...(job.status === 'queued' ? { queuePosition: pending[queue].indexOf(job.id) + 1 } : {}) };
};
const wait = (ms, signal) => delay(ms, undefined, { signal });
const timedSignal = (job, ms) => AbortSignal.any([job.controller.signal, AbortSignal.timeout(ms)]);
function startNext(queue) {
  if (activeJobs[queue]) return;
  while (pending[queue].length) {
    const id = pending[queue].shift(); const job = jobs.get(id);
    if (!job || job.status !== 'queued') continue;
    activeJobs[queue] = id;
    job.runPromise = execute(job);
    return;
  }
}
const validImageSource = source => {
  if (typeof source !== 'string') return false;
  const data = source.match(/^data:image\/(?:png|jpeg|webp);base64,([a-zA-Z0-9+/=]+)$/);
  if (data) return Buffer.byteLength(data[1], 'base64') <= 20 * 1024 * 1024;
  return /^\/api\/media\/[a-zA-Z0-9_-]{3,80}\/[a-f0-9-]{36}\.(?:png|jpg|jpeg|webp)$/.test(source);
};

async function normalizeImageRatio(bytes, ratio) {
  const { width, height } = imageDimensions(ratio);
  const image = sharp(bytes, { limitInputPixels: 100_000_000 });
  const metadata = await image.metadata();
  if (!metadata.width || !metadata.height) throw new Error('无法读取生成图片尺寸。');
  return image.resize(width, height, { fit: 'cover', position: 'centre' }).png().toBuffer();
}

async function responseJson(response, label) {
  const text = await response.text();
  let data; try { data = JSON.parse(text); } catch { throw new Error(`${label}返回非 JSON：${text.slice(0, 300)}`); }
  if (!response.ok) throw new Error(`${label}失败（HTTP ${response.status}）：${JSON.stringify(data).slice(0, 500)}`);
  return data;
}
async function inputImage(source, origin, signal) {
  let bytes, mime;
  if (/^data:image\/(png|jpeg|webp);base64,/i.test(source)) {
    const match = source.match(/^data:(image\/(?:png|jpeg|webp));base64,(.+)$/i);
    mime = match[1].toLowerCase(); bytes = Buffer.from(match[2], 'base64');
  } else {
    const match = source.match(/^\/api\/media\/([a-zA-Z0-9_-]{3,80})\/([a-f0-9-]{36}\.(png|jpg|jpeg|webp))$/);
    if (!match) throw new Error('参考图必须是本机项目图片或上传的 PNG、JPEG、WebP。');
    try {
      bytes = await readFile(filePath(match[1], match[2]));
    } catch (error) {
      if (error?.code === 'ENOENT') throw new Error('参考图文件不存在或已被移动，请重新上传或从资产库重新导入。');
      throw error;
    }
    mime = `image/${extname(match[2]).slice(1).replace('jpg', 'jpeg')}`;
  }
  if (bytes.length > 20 * 1024 * 1024) throw new Error('参考图不得超过 20 MB。');
  const form = new FormData();
  form.append('image', new Blob([bytes], { type: mime }), `${randomUUID()}.${mime.split('/')[1]}`);
  form.append('overwrite', 'false');
  const data = await responseJson(await fetch(`${origin}/upload/image`, { method: 'POST', body: form, signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]) }), '参考图上传');
  if (!data.name) throw new Error('ComfyUI 未返回参考图文件名。');
  return data.name;
}
function setInput(graph, config, prefix, value, required = false) {
  const id = config[`${prefix}NodeId`]; const key = config[`${prefix}Input`];
  if (!id) { if (required) throw new Error(`请在设置中配置${prefix === 'prompt' ? '提示词' : prefix === 'reference' ? '参考图' : '时长'}节点。`); return; }
  validateMapping(graph, id, key, prefix);
  graph[id].inputs[key] = value;
}
function hasReferenceToVideoNode(config) {
  try { return Object.values(JSON.parse(config.workflowJson || '{}')).some(node => node?.class_type === 'MiniMaxH3ReferenceToVideo'); }
  catch { return false; }
}
function removeMinimaxGuideChain(graph) {
  const guides = new Set(Object.entries(graph).filter(([, node]) => node.class_type === 'MiniMaxH3AddGuide').map(([id]) => id));
  if (!guides.size) return;
  const guideOnlyNodes = new Set();
  const collectGuideInputs = (link, visited = new Set()) => {
    if (!Array.isArray(link) || typeof link[0] !== 'string' || visited.has(link[0]) || guides.has(link[0])) return;
    const id = link[0]; const node = graph[id]; if (!node || node.class_type === 'MiniMaxH3ReferenceToVideo' || node.class_type === 'VAELoader' || node.class_type === 'CLIPLoader') return;
    visited.add(id); guideOnlyNodes.add(id);
    for (const value of Object.values(node.inputs || {})) collectGuideInputs(value, visited);
  };
  for (const id of guides) { collectGuideInputs(graph[id].inputs?.image); collectGuideInputs(graph[id].inputs?.frame_idx); }
  const resolve = link => {
    let current = link; const visited = new Set();
    while (Array.isArray(current) && guides.has(String(current[0])) && !visited.has(String(current[0]))) {
      const id = String(current[0]); visited.add(id); current = graph[id]?.inputs?.positive;
    }
    return current;
  };
  for (const node of Object.values(graph)) for (const [key, value] of Object.entries(node.inputs || {})) {
    if (Array.isArray(value) && typeof value[0] === 'string') node.inputs[key] = resolve(value);
  }
  for (const id of guides) delete graph[id];
  while (guideOnlyNodes.size) {
    const referenced = new Set(Object.values(graph).flatMap(node => Object.values(node.inputs || {}).filter(value => Array.isArray(value) && typeof value[0] === 'string').map(value => value[0])));
    const unused = [...guideOnlyNodes].filter(id => !referenced.has(id));
    if (!unused.length) break;
    for (const id of unused) { delete graph[id]; guideOnlyNodes.delete(id); }
  }
}
export function buildMediaWorkflow(config, kind, input, uploadedName, uploadedExtraNames = []) {
  validateWorkflow(config.workflowJson);
  if (!config.workflowJson) throw new Error(`请先在设置中导入${kind === 'video' ? 'MiniMax H3 生视频' : 'Qwen-Image-2.1 生图'}工作流。`);
  const graph = JSON.parse(config.workflowJson);
  if (kind === 'audio') {
    setInput(graph, config, 'prompt', input.prompt, true);
    setInput(graph, config, 'lyrics', input.lyrics, true);
    setInput(graph, config, 'duration', input.duration, true);
    if (config.seedNodeId) setInput(graph, config, 'seed', config.seed === -1 ? Math.floor(Math.random() * 2 ** 32) : config.seed);
    return graph;
  }
  setInput(graph, config, 'prompt', input.prompt, true);
  const negativePrompt = typeof input.negativePrompt === 'string' ? input.negativePrompt.trim() : '';
  if (negativePrompt) {
    const promptNode = graph[config.promptNodeId];
    if (!promptNode?.inputs || !Object.hasOwn(promptNode.inputs, 'negative_prompt')) throw new Error('当前 Qwen 工作流提示词节点不支持 negative_prompt 输入，无法提交反向提示词。');
    promptNode.inputs.negative_prompt = negativePrompt;
  }
  if (uploadedName) setInput(graph, config, 'reference', uploadedName, true);
  if (kind === 'imageEdit' && uploadedName) {
    const promptNode = graph[config.promptNodeId];
    if (input.imageMode === 'compose' && promptNode?.class_type !== 'TextEncodeQwenImage21') throw new Error('分镜多参考图需要 TextEncodeQwenImage21 节点，请更新 Qwen 工作流。');
    // Qwen Image 2.1 consumes the image list in slot order. Keep this order
    // aligned with the selected references and preserve their original size.
    if (promptNode?.class_type === 'TextEncodeQwenImage21') {
      const inputs = promptNode.inputs;
      const flattenedImageKeys = Object.keys(inputs).filter(key => /^images\.image_\d+$/.test(key));
      const nestedImageSlots = Object.hasOwn(inputs, 'images') && flattenedImageKeys.length === 0;
      if (nestedImageSlots) inputs.images = {};
      else for (const key of flattenedImageKeys) delete inputs[key];
      const setReferenceSlot = (slot, link) => {
        if (nestedImageSlots) inputs.images[`image_${slot}`] = link;
        else inputs[`images.image_${slot}`] = link;
      };
      const referenceNodeId = String(config.referenceNodeId);
      setReferenceSlot(1, [referenceNodeId, 0]);
      let nextNodeId = Math.max(0, ...Object.keys(graph).map(id => Number(id)).filter(Number.isFinite)) + 1;
      uploadedExtraNames.forEach((name, index) => {
        const nodeId = String(nextNodeId++);
        graph[nodeId] = { class_type: 'LoadImage', inputs: { image: name } };
        setReferenceSlot(index + 2, [nodeId, 0]);
      });
      const originalPrompt = promptNode.inputs[config.promptInput] || '';
      if (input.imageMode === 'compose') {
        promptNode.inputs[config.promptInput] = originalPrompt.replace(/@参考图\s*(\d+)/g, '第$1张参考图中的').replace(/<image\d+>/g, '');
        const resolutionNode = Object.entries(graph).find(([, node]) => node.class_type === 'ResolutionSelector');
        const selectorId = resolutionNode?.[0] || String(nextNodeId++);
        if (!resolutionNode) graph[selectorId] = { class_type: 'ResolutionSelector', inputs: { aspect_ratio: '16:9 (Widescreen)', megapixels: 1, multiple: 32 } };
        if (qwenRatioLabels[input.ratio]) graph[selectorId].inputs.aspect_ratio = qwenRatioLabels[input.ratio];
        const samplerIds = Object.entries(graph).filter(([, node]) => node.class_type === 'KSampler' && String(node.inputs?.positive?.[0]) === String(config.promptNodeId));
        let sizeNodeId = Object.entries(graph).find(([, node]) => node.class_type === 'EmptyLatentImage' && Array.isArray(node.inputs?.width) && Array.isArray(node.inputs?.height))?.[0];
        if (!sizeNodeId) {
          sizeNodeId = String(nextNodeId++);
          graph[sizeNodeId] = { class_type: 'EmptyLatentImage', inputs: { width: [selectorId, 0], height: [selectorId, 1], batch_size: 1 } };
        } else {
          graph[sizeNodeId].inputs.width = [selectorId, 0];
          graph[sizeNodeId].inputs.height = [selectorId, 1];
          graph[sizeNodeId].inputs.batch_size = 1;
        }
        if (!samplerIds.length) throw new Error('分镜工作流缺少连接 Qwen 条件的 KSampler，无法保证输出画幅。');
        for (const [, sampler] of samplerIds) {
          const switchEntry = Object.entries(graph).find(([id, node]) => node.class_type === 'ComfySwitchNode' && String(sampler.inputs?.latent_image?.[0]) === id);
          if (switchEntry) {
            const [, switchNode] = switchEntry;
            switchNode.inputs.on_true = [sizeNodeId, 0];
            switchNode.inputs.switch = true;
          } else sampler.inputs.latent_image = [sizeNodeId, 0];
        }
        promptNode.inputs.resolution = 0;
      } else {
        const referenceTokens = Array.from({ length: uploadedExtraNames.length + 1 }, (_, index) => `<image${index + 1}>`).join('、');
        promptNode.inputs[config.promptInput] = `参考图依次对应 ${referenceTokens}。按照提示词中引用的图片标记使用对应参考图，并保留相关主体特征和关键视觉关系。\n${originalPrompt}`;
      }
    }
  }
  if (kind === 'video') {
    removeMinimaxGuideChain(graph);
    setInput(graph, config, 'duration', config.durationInput === 'length' ? Math.round(input.duration * 24) + 1 : input.duration, true);
    const referenceToVideo = Object.values(graph).find(node => node.class_type === 'MiniMaxH3ReferenceToVideo');
    if (config.lastFrameNodeId) {
      if (uploadedExtraNames.length !== 1) throw new Error('首尾帧工作流必须同时提供首帧和尾帧图片。');
      setInput(graph, config, 'lastFrame', uploadedExtraNames[0], true);
    } else if (referenceToVideo) {
      const referenceInputs = referenceToVideo.inputs;
      const priorSlots = new Map(Object.entries(referenceInputs).filter(([key]) => /^ref_images\.ref_image_\d+$/.test(key)));
      for (const key of priorSlots.keys()) delete referenceInputs[key];
      if (uploadedName) referenceInputs['ref_images.ref_image_0'] = [String(config.referenceNodeId), 0];
      let nextNodeId = Math.max(0, ...Object.keys(graph).map(id => Number(id)).filter(Number.isFinite)) + 1;
      uploadedExtraNames.forEach((name, index) => {
        const slotIndex = index + 1;
        const priorLink = priorSlots.get(`ref_images.ref_image_${slotIndex}`);
        let nodeId = Array.isArray(priorLink) ? String(priorLink[0]) : '';
        if (!graph[nodeId] || graph[nodeId].class_type !== 'LoadImage') {
          nodeId = String(nextNodeId++);
          graph[nodeId] = { class_type: 'LoadImage', inputs: { image: name } };
        } else graph[nodeId].inputs.image = name;
        referenceInputs[`ref_images.ref_image_${slotIndex}`] = [nodeId, 0];
      });
      const ratioLabels = { '1:1': '1:1 (Square)', '2:3': '2:3 (Portrait Photo)', '3:2': '3:2 (Photo)', '3:4': '3:4 (Portrait Standard)', '4:3': '4:3 (Standard)', '9:16': '9:16 (Portrait Widescreen)', '16:9': '16:9 (Widescreen)', '21:9': '21:9 (Ultrawide)', '4:5': '3:4 (Portrait Standard)', '5:4': '4:3 (Standard)' };
      const selector = Object.values(graph).find(node => node.class_type === 'ResolutionSelector');
      if (selector && ratioLabels[input.ratio]) selector.inputs.aspect_ratio = ratioLabels[input.ratio];
    } else {
      uploadedExtraNames.forEach((name, index) => { const slot = config.referenceSlots?.[index]; if (!slot) throw new Error('视频工作流缺少多图节点映射。'); validateMapping(graph, slot.imageNodeId, slot.imageInput, '多图图片'); validateMapping(graph, slot.timeNodeId, slot.timeInput, '多图切点'); graph[slot.imageNodeId].inputs[slot.imageInput] = name; graph[slot.timeNodeId].inputs[slot.timeInput] = input.cutPoints[index + 1]; });
    }
    const ratioLabels = { '1:1': '1:1 (Square)', '2:3': '2:3 (Portrait Photo)', '3:2': '3:2 (Photo)', '3:4': '3:4 (Portrait Standard)', '4:3': '4:3 (Standard)', '9:16': '9:16 (Portrait Widescreen)', '16:9': '16:9 (Widescreen)', '21:9': '21:9 (Ultrawide)', '4:5': '3:4 (Portrait Standard)', '5:4': '4:3 (Standard)' };
    const resolutionSelector = Object.values(graph).find(node => node.class_type === 'ResolutionSelector');
    if (resolutionSelector && ratioLabels[input.ratio]) resolutionSelector.inputs.aspect_ratio = ratioLabels[input.ratio];
    for (const node of Object.values(graph)) {
      if (referenceToVideo || node.class_type !== 'MiniMaxH3ImageToVideo' || !Number.isFinite(node.inputs?.width) || !Number.isFinite(node.inputs?.height)) continue;
      const area = Number.isFinite(input.videoResolution) ? videoResolutionArea(input.ratio, input.videoResolution) : node.inputs.width * node.inputs.height;
      [node.inputs.width, node.inputs.height] = Object.values(imageDimensions(input.ratio, area));
    }
    if (Number.isFinite(input.videoResolution)) {
      const selector = Object.values(graph).find(node => node.class_type === 'ResolutionSelector');
      if (selector) selector.inputs.megapixels = videoResolutionArea(input.ratio, input.videoResolution) / 1_000_000;
      else if (referenceToVideo && Number.isFinite(referenceToVideo.inputs?.width) && Number.isFinite(referenceToVideo.inputs?.height)) {
        [referenceToVideo.inputs.width, referenceToVideo.inputs.height] = Object.values(imageDimensions(input.ratio, videoResolutionArea(input.ratio, input.videoResolution)));
      }
    }
  }
  if (config.seedNodeId) setInput(graph, config, 'seed', config.seed === -1 ? Math.floor(Math.random() * 2 ** 32) : config.seed);
  if (kind !== 'video') {
    const configuredWidth = config.width || 768;
    const configuredHeight = config.height || 432;
    const selectedRatio = input.ratio || '16:9';
    const selector = Object.values(graph).find(node => node.class_type === 'ResolutionSelector');
    const baseArea = input.imageMode === 'compose' ? Number(selector?.inputs?.megapixels || 1) * 1_000_000 : configuredWidth * configuredHeight;
    const { width, height } = imageDimensions(selectedRatio, baseArea);
    for (const key of ['width', 'height', 'steps', 'cfg']) {
      if (!config[`${key}NodeId`]) continue;
      const value = key === 'width' ? width : key === 'height' ? height : config[key];
      setInput(graph, config, key, value);
    }
    for (const node of Object.values(graph)) {
      if ((node.class_type === 'EmptySD3LatentImage' || node.class_type === 'EmptyLatentImage') && (Number.isFinite(node.inputs?.width) || Array.isArray(node.inputs?.width)) && (Number.isFinite(node.inputs?.height) || Array.isArray(node.inputs?.height))) {
        [node.inputs.width, node.inputs.height] = [width, height];
        node.inputs.batch_size = 1;
      }
      if (node.class_type === 'TextEncodeQwenImage21' && Number.isFinite(node.inputs?.resolution)) {
        node.inputs.resolution = Math.max(64, Math.min(2048, Math.max(width, height)));
        node.inputs.prompt = `${node.inputs.prompt || ''}\n画面采用 ${selectedRatio} 画幅构图。`;
      }
    }
  }
  return graph;
}

async function execute(job) {
  try {
    if (job.cancelled) return;
    job.status = 'running'; job.message = '正在准备工作流…';
    if (job.kind === 'image' && ['gpt', 'chatgpt'].includes(job.provider)) {
      job.message = job.provider === 'chatgpt' ? 'ChatGPT 网页正在生成…' : 'GPT Image 2.5 正在生成…';
      const submittedPrompt = formatGptImagePrompt(job.prompt, job.negativePrompt);
      const generated = job.provider === 'chatgpt' ? await generateChatgptImage(job.config.chatgptImage, submittedPrompt, job.sources, sourceBytes, job.controller.signal) : await generateGptImage(job.config, submittedPrompt, job.sources, undefined, job.controller.signal, job.ratio);
      if (job.cancelled) return;
      const bytes = await normalizeImageRatio(generated, job.ratio);
      if (job.cancelled) return;
      const name = `${randomUUID()}.png`; const path = filePath(job.projectId, name);
      await mkdir(dirname(path), { recursive: true }); await writeFile(path, bytes);
      if (job.cancelled) { await rm(path, { force: true }); return; }
      job.result = { url: `/api/media/${job.projectId}/${name}`, mime: 'image/png', prompt: submittedPrompt, generatedAt: Date.now() };
      job.status = 'completed'; job.message = '生成完成，请预览并确认。'; return;
    }
    const origin = validateComfyUrl(job.config.comfy.baseUrl);
    const reference = job.kind === 'image' ? job.sources[0] : job.kind === 'video' ? job.source : undefined;
    const uploadedName = reference ? await inputImage(reference, origin, job.controller.signal) : undefined;
    const extraSources = job.kind === 'image' || job.kind === 'video' ? job.sources.slice(1) : [];
    const uploadedExtraNames = await Promise.all(extraSources.map(source => inputImage(source, origin, job.controller.signal)));
    if (job.cancelled) return;
    const workflowKind = job.kind === 'image' && reference && (job.imageMode === 'compose' || !job.config.comfy.image.referenceNodeId) ? 'imageEdit' : job.kind;
    const videoConfig = job.kind === 'video' && job.videoWorkflow === 'firstLast' ? job.config.comfy.videoFirstLast : job.config.comfy[workflowKind];
    const graph = buildMediaWorkflow(videoConfig, workflowKind, job, uploadedName, uploadedExtraNames);
    const auditPath = join(MEDIA, job.projectId, 'jobs', `${job.id}.json`);
    await mkdir(dirname(auditPath), { recursive: true });
    await writeFile(auditPath, JSON.stringify({ id: job.id, prompt: job.prompt, ratio: job.ratio, sources: job.sources, uploadedNames: [uploadedName, ...uploadedExtraNames], workflow: graph }, null, 2));
    job.message = '正在提交 ComfyUI 任务…';
    const submission = await responseJson(await fetch(`${origin}/prompt`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: graph, client_id: job.id }), signal: timedSignal(job, 30_000) }), 'ComfyUI 工作流提交');
    if (submission.node_errors && Object.keys(submission.node_errors).length) throw new Error(`工作流节点错误：${JSON.stringify(submission.node_errors).slice(0, 600)}`);
    if (!submission.prompt_id) throw new Error('ComfyUI 未返回任务 ID。');
    job.promptId = submission.prompt_id;
    if (job.cancelled) return;
    job.message = 'ComfyUI 正在生成…';
    const deadline = Date.now() + (job.kind === 'video' ? 90 : 30) * 60_000;
    let output;
    while (Date.now() < deadline) {
      const history = await responseJson(await fetch(`${origin}/history/${encodeURIComponent(job.promptId)}`, { signal: timedSignal(job, 15_000) }), 'ComfyUI 进度查询');
      if (job.cancelled) return;
      const completed = history[job.promptId];
      if (completed) {
        if (completed.status?.status_str === 'error') throw new Error(`ComfyUI 生成失败：${JSON.stringify(completed.status.messages || []).slice(0, 800)}`);
        const outputEntries = Object.entries(completed.outputs || {});
        const preferredClasses = job.kind === 'video' ? new Set(['SaveVideo', 'SaveAnimatedWEBP']) : job.kind === 'audio' ? new Set(['SaveAudio', 'SaveAudioAdvanced']) : new Set(['SaveImage', 'SaveImageAdvanced']);
        const preferredIds = new Set(Object.entries(graph).filter(([, node]) => preferredClasses.has(node.class_type)).map(([id]) => id));
        const orderedOutputs = [...outputEntries.filter(([id]) => preferredIds.has(id)), ...outputEntries.filter(([id]) => !preferredIds.has(id))];
        const entries = orderedOutputs.flatMap(([, node]) => job.kind === 'video' ? [...(node.videos || []), ...(node.gifs || []), ...(node.images || []).filter(item => /\.(mp4|webm|mov)$/i.test(item.filename || ''))] : job.kind === 'audio' ? [...(node.audio || []), ...(node.audios || []), ...(node.files || []).filter(item => /\.(mp3|wav|flac|ogg)$/i.test(item.filename || ''))] : node.images || []);
        output = entries.find(item => item.filename);
        if (!output) throw new Error('ComfyUI 已完成，但没有输出可读取的媒体文件。');
        break;
      }
      await wait(1500, job.controller.signal);
    }
    if (!output) throw new Error('ComfyUI 任务超时。');
    if (job.cancelled) return;
    job.message = '正在保存生成结果…';
    const params = new URLSearchParams({ filename: output.filename, subfolder: output.subfolder || '', type: output.type || 'output' });
    const response = await fetch(`${origin}/view?${params}`, { signal: timedSignal(job, 120_000) });
    if (!response.ok) throw new Error(`读取 ComfyUI 结果失败（HTTP ${response.status}）。`);
    let bytes = Buffer.from(await response.arrayBuffer());
    if (job.cancelled) return;
    if (bytes.length > (job.kind === 'video' ? 1024 : job.kind === 'audio' ? 200 : 40) * 1024 * 1024) throw new Error('生成文件过大，未能导入本机项目。');
    let extension = extname(output.filename).slice(1).toLowerCase();
    const allowed = job.kind === 'video' ? ['mp4', 'webm', 'mov'] : job.kind === 'audio' ? ['mp3', 'wav', 'flac', 'ogg'] : ['png', 'jpg', 'jpeg', 'webp'];
    if (!allowed.includes(extension)) throw new Error(`不支持的生成文件格式：${extension || '未知'}。`);
    if (job.kind === 'image') {
      const metadata = await sharp(bytes).metadata();
      await writeFile(auditPath, JSON.stringify({ id: job.id, promptId: job.promptId, prompt: job.prompt, ratio: job.ratio, sources: job.sources, uploadedNames: [uploadedName, ...uploadedExtraNames], workflow: graph, output, originalSize: { width: metadata.width, height: metadata.height } }, null, 2));
      bytes = await normalizeImageRatio(bytes, job.ratio); extension = 'png';
    }
    if (job.cancelled) return;
    const name = `${randomUUID()}.${extension}`;
    const path = filePath(job.projectId, name);
    await mkdir(dirname(path), { recursive: true }); await writeFile(path, bytes);
    if (job.cancelled) { await rm(path, { force: true }); return; }
    job.result = { url: `/api/media/${job.projectId}/${name}`, mime: response.headers.get('content-type') || (job.kind === 'video' ? `video/${extension}` : job.kind === 'audio' ? `audio/${extension === 'mp3' ? 'mpeg' : extension}` : `image/${extension}`), prompt: job.prompt, generatedAt: Date.now() };
    job.status = 'completed'; job.message = '生成完成，请预览并确认。';
  } catch (error) { if (job.cancelled) return; job.status = 'failed'; job.error = error instanceof TypeError ? '无法连接本机 ComfyUI。请确认服务地址与运行状态。' : error instanceof Error ? error.message : String(error); job.message = '生成失败'; }
  finally { await job.cancelPromise; const queue = queueType(job); if (activeJobs[queue] === job.id) activeJobs[queue] = null; queueMicrotask(() => startNext(queue)); }
}
export function createMediaJob(settings, input) {
  if (!['image', 'video', 'audio'].includes(input.kind) || typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 8000) throw new Error('媒体生成请求无效。');
  if (input.kind === 'audio' && (typeof input.lyrics !== 'string' || !input.lyrics.trim() || input.lyrics.length > 8000 || !Number.isFinite(input.duration) || input.duration < 1 || input.duration > 60 || !settings.comfy.audio.workflowJson)) throw new Error('文生音频需要有效的歌词、1–60 秒时长和已配置的工作流。');
  if (input.negativePrompt !== undefined && (input.kind !== 'image' || typeof input.negativePrompt !== 'string' || input.negativePrompt.length > 8000)) throw new Error('图片反向提示词无效。');
  safeId(input.projectId);
  const provider = input.kind === 'image' ? (input.provider || settings.imageProvider || 'qwen') : 'minimax';
  if (input.videoWorkflow !== undefined && (input.kind !== 'video' || input.videoWorkflow !== 'firstLast')) throw new Error('视频工作流类型无效。');
  if (input.kind === 'image' && !['qwen', 'gpt', 'chatgpt'].includes(provider)) throw new Error('生图方式无效。');
  if (input.kind === 'image' && input.imageMode !== undefined && !['edit', 'compose'].includes(input.imageMode)) throw new Error('生图模式无效。');
  const imageMode = input.kind === 'image' ? (input.imageMode || 'edit') : undefined;
  const sources = input.kind === 'audio' ? [] : input.sources ?? (input.source ? [input.source] : []);
  if (!Array.isArray(sources) || sources.length > 8 || sources.some(source => typeof source !== 'string' || !validImageSource(source))) throw new Error(input.kind === 'video' ? '参考图无效，视频最多选择 8 张 PNG、JPEG 或 WebP 图片。' : '参考图无效，最多选择 8 张 PNG、JPEG 或 WebP 图片。');
  if (input.kind === 'image' && provider === 'qwen' && sources.length > 1 && input.source !== sources[0]) throw new Error('多张参考图必须按提示词引用顺序提交。');
  if (input.kind === 'video' && (!input.source || !Number.isFinite(input.duration) || input.duration < 1 || input.duration > 15)) throw new Error('MiniMax H3 需要首帧图片，时长须在 1–15 秒之间。');
  if (input.videoResolution !== undefined && (input.kind !== 'video' || ![480, 720, 1080].includes(input.videoResolution))) throw new Error('MiniMax H3 分辨率无效。');
  const isReferenceToVideo = input.kind === 'video' && hasReferenceToVideoNode(settings.comfy.video);
  if (input.kind === 'video' && input.videoWorkflow === 'firstLast' && (sources.length !== 2 || sources[0] !== input.source || !settings.comfy.videoFirstLast.workflowJson || !settings.comfy.videoFirstLast.lastFrameNodeId)) throw new Error('MiniMax H3 首尾帧工作流需要已配置的工作流和两张首尾帧图片。');
  if (input.kind === 'video' && !input.videoWorkflow && (sources[0] !== input.source || (sources.length > 1 && (isReferenceToVideo ? sources.length > 8 : !Array.isArray(input.cutPoints) || input.cutPoints.length !== sources.length || input.cutPoints[0] !== 0 || input.cutPoints.some((time, index) => !Number.isFinite(time) || time < 0 || time >= input.duration || (index > 0 && time <= input.cutPoints[index - 1])) || (settings.comfy.video.referenceSlots?.length || 0) < sources.length - 1)))) throw new Error(isReferenceToVideo ? 'MiniMax H3 R2V 每段最多提交 8 张分镜参考图。' : '多图视频需要完整的图片节点映射和严格递增的切点。');
  if (input.ratio !== undefined && !imageRatios.has(input.ratio)) throw new Error('项目画面比例无效。');
  if (provider === 'qwen' || input.kind === 'video' || input.kind === 'audio') {
    const reference = input.kind === 'image' ? sources[0] : input.kind === 'video' ? input.source : undefined;
    const workflowKind = input.kind === 'image' && reference && (imageMode === 'compose' || !settings.comfy.image.referenceNodeId) ? 'imageEdit' : input.kind;
    const extraSources = (input.kind === 'image' || input.kind === 'video') ? sources.slice(1) : [];
    const workflowConfig = input.kind === 'video' && input.videoWorkflow === 'firstLast' ? settings.comfy.videoFirstLast : settings.comfy[workflowKind];
    buildMediaWorkflow(workflowConfig, workflowKind, { ...input, imageMode }, reference ? '__reference__' : undefined, extraSources.map((_, index) => `__reference_${index + 2}__`));
  }
  const job = { id: randomUUID(), projectId: input.projectId, kind: input.kind, provider, videoWorkflow: input.videoWorkflow, imageMode, prompt: input.prompt.trim(), lyrics: input.kind === 'audio' ? input.lyrics.trim() : undefined, negativePrompt: typeof input.negativePrompt === 'string' ? input.negativePrompt.trim() : '', duration: input.duration, videoResolution: input.videoResolution, ratio: input.ratio || '16:9', source: input.source, sources, cutPoints: input.cutPoints, status: 'queued', message: '等待执行…', config: structuredClone(settings), controller: new AbortController() };
  jobs.set(job.id, job); const queue = queueType(job); pending[queue].push(job.id); queueMicrotask(() => startNext(queue));
  return publicJob(job);
}
export function getMediaJob(id) { const job = jobs.get(id); return job ? publicJob(job) : null; }
export function hasActiveProjectMediaJobs(projectId) { return [...jobs.values()].some(job => job.projectId === projectId && ['queued', 'running'].includes(job.status)); }
export async function cancelMediaJob(id, message = '任务已取消。') {
  const job = jobs.get(id);
  if (!job) throw new Error('媒体任务不存在或服务已重启。');
  if (job.status === 'cancelled') { await job.cancelPromise; return publicJob(job); }
  if (!['queued', 'running'].includes(job.status)) return publicJob(job);
  const wasQueued = job.status === 'queued';
  job.cancelled = true; job.status = 'cancelled'; job.message = message;
  if (wasQueued) {
    const queue = queueType(job); const index = pending[queue].indexOf(id); if (index !== -1) pending[queue].splice(index, 1);
    queueMicrotask(() => startNext(queue));
    return publicJob(job);
  }
  job.cancelPromise = (async () => {
    if (job.promptId && job.provider !== 'gpt') {
      try {
        const origin = validateComfyUrl(job.config.comfy.baseUrl);
        const options = body => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(3000) });
        await Promise.allSettled([
          fetch(`${origin}/queue`, options({ delete: [job.promptId] })),
          fetch(`${origin}/interrupt`, options({ prompt_id: job.promptId }))
        ]);
      } catch { /* Local cancellation still proceeds if ComfyUI is unreachable. */ }
    }
    job.controller.abort();
  })();
  await job.cancelPromise;
  await job.runPromise;
  return publicJob(job);
}
export async function cancelProjectMediaJobs(projectId) { await Promise.all([...jobs.values()].filter(job => job.projectId === projectId && ['queued', 'running'].includes(job.status)).map(job => cancelMediaJob(job.id, '项目已删除，结果将被丢弃。'))); }
export async function readMedia(projectId, name) { return readFile(filePath(projectId, name)); }
export function mediaFilePath(projectId, name) { return filePath(projectId, name); }
export async function copyMediaToLibrary(sourceUrl) {
  const match = sourceUrl?.match(/^\/api\/media\/([a-zA-Z0-9_-]{3,80})\/([a-f0-9-]{36}\.(?:png|jpg|jpeg|webp))$/);
  if (!match) throw new Error('该图片不是本机生成的项目媒体。');
  const name = `${randomUUID()}${extname(match[2])}`;
  const target = filePath('library', name);
  await mkdir(dirname(target), { recursive: true }); await copyFile(filePath(match[1], match[2]), target);
  return `/api/media/library/${name}`;
}
export async function uploadLibraryMedia(stream, kind) {
  if (kind !== 'image' && kind !== 'video') throw new Error('媒体类型无效。');
  const limit = kind === 'image' ? 20 * 1024 * 1024 : 250 * 1024 * 1024;
  const directory = join(MEDIA, 'library');
  await mkdir(directory, { recursive: true });
  const id = randomUUID();
  const temporary = join(directory, `${id}.tmp`);
  const file = await open(temporary, 'wx+');
  let size = 0;
  try {
    for await (const chunk of stream) {
      size += chunk.length;
      if (size > limit) throw new Error(kind === 'image' ? '图片不得超过 20 MB。' : '视频不得超过 250 MB。');
      await file.write(chunk);
    }
    if (!size) throw new Error('文件为空。');
    const head = Buffer.alloc(32);
    await file.read(head, 0, 32, 0);
    const png = head.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'));
    const jpeg = head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
    const webp = head.toString('ascii', 0, 4) === 'RIFF' && head.toString('ascii', 8, 12) === 'WEBP';
    const mp4 = head.toString('ascii', 4, 8) === 'ftyp';
    const webm = head.subarray(0, 4).equals(Buffer.from('1a45dfa3', 'hex'));
    const extension = kind === 'image' ? (png ? 'png' : jpeg ? 'jpg' : webp ? 'webp' : '') : (mp4 ? 'mp4' : webm ? 'webm' : '');
    if (!extension) throw new Error(kind === 'image' ? '只支持 PNG、JPEG、WebP 图片。' : '只支持 MP4、WebM 视频。');
    await file.close();
    await rename(temporary, filePath('library', `${id}.${extension}`));
    return `/api/media/library/${id}.${extension}`;
  } catch (error) {
    await file.close().catch(() => {});
    await rm(temporary, { force: true });
    throw error;
  }
}
export async function discardMediaJobResult(id) {
  const job = jobs.get(id);
  if (!job || job.status !== 'completed' || !job.result?.url) throw new Error('没有可放弃的生成结果。');
  const name = job.result.url.split('/').pop();
  await rm(filePath(job.projectId, name), { force: true });
  jobs.delete(id);
}
export async function removeProjectMedia(projectId) {
  if (projectId === 'library') throw new Error('不能删除全局资产媒体目录。');
  const target = resolve(MEDIA, safeId(projectId));
  if (!target.startsWith(`${resolve(MEDIA)}${process.platform === 'win32' ? '\\' : '/'}`)) throw new Error('媒体目录不在工作区内。');
  await rm(target, { recursive: true, force: true });
}
export async function removeMediaUrl(url) {
  const match = typeof url === 'string' && url.match(/^\/api\/media\/([a-zA-Z0-9_-]{3,80})\/([a-f0-9-]{36}\.(?:png|jpg|jpeg|webp|mp4|webm|mov|mp3|wav|flac|ogg))$/);
  if (!match) throw new Error('只能删除本应用保存的媒体文件。');
  await rm(filePath(match[1], match[2]), { force: true });
}
