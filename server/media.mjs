import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, copyFile, rm, open, rename } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { validateComfyUrl, validateWorkflow, validateMapping } from './settings.mjs';
import { generateGptImage } from './gpt-image.mjs';
import sharp from 'sharp';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const MEDIA = join(process.env.REELBENCH_DATA_DIR || join(ROOT, '.local-runs'), 'media');
const jobs = new Map();
const pending = [];
let activeJob = null;
const safeId = value => { if (!/^[a-zA-Z0-9_-]{3,80}$/.test(value)) throw new Error('项目 ID 无效。'); return value; };
const filePath = (projectId, name) => { safeId(projectId); if (!/^[a-f0-9-]{36}\.(png|jpg|jpeg|webp|mp4|webm|mov)$/.test(name)) throw new Error('媒体文件名无效。'); return join(MEDIA, projectId, name); };
const publicJob = job => {
  const { source, sources, config, controller, cancelPromise, runPromise, cancelled, ...visible } = job;
  return { ...visible, ...(job.status === 'queued' ? { queuePosition: pending.indexOf(job.id) + 1 } : {}) };
};
const wait = (ms, signal) => delay(ms, undefined, { signal });
const timedSignal = (job, ms) => AbortSignal.any([job.controller.signal, AbortSignal.timeout(ms)]);
function startNext() {
  if (activeJob) return;
  while (pending.length) {
    const id = pending.shift(); const job = jobs.get(id);
    if (!job || job.status !== 'queued') continue;
    activeJob = id;
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
  const width = ratio === '9:16' ? 864 : 1536;
  const height = ratio === '9:16' ? 1536 : 864;
  const image = sharp(bytes, { limitInputPixels: 100_000_000 });
  const metadata = await image.metadata();
  if (!metadata.width || !metadata.height) throw new Error('无法读取生成图片尺寸。');
  if (Math.abs(metadata.width / metadata.height - width / height) < 0.005) return sharp(bytes).png().toBuffer();
  return sharp(bytes, { limitInputPixels: 100_000_000 }).resize(width, height, { fit: 'cover', position: sharp.strategy.attention }).png().toBuffer();
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
    bytes = await readFile(filePath(match[1], match[2])); mime = `image/${extname(match[2]).slice(1).replace('jpg', 'jpeg')}`;
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
export function buildMediaWorkflow(config, kind, input, uploadedName, uploadedExtraNames = []) {
  validateWorkflow(config.workflowJson);
  if (!config.workflowJson) throw new Error(`请先在设置中导入${kind === 'video' ? 'MiniMax H3 生视频' : 'Qwen-Image-2.1 生图'}工作流。`);
  const graph = JSON.parse(config.workflowJson);
  setInput(graph, config, 'prompt', input.prompt, true);
  if (uploadedName) setInput(graph, config, 'reference', uploadedName, true);
  if (kind === 'video') {
    setInput(graph, config, 'duration', config.durationInput === 'length' ? Math.round(input.duration * 24) + 1 : input.duration, true);
    uploadedExtraNames.forEach((name, index) => { const slot = config.referenceSlots?.[index]; if (!slot) throw new Error('视频工作流缺少多图节点映射。'); validateMapping(graph, slot.imageNodeId, slot.imageInput, '多图图片'); validateMapping(graph, slot.timeNodeId, slot.timeInput, '多图切点'); graph[slot.imageNodeId].inputs[slot.imageInput] = name; graph[slot.timeNodeId].inputs[slot.timeInput] = input.cutPoints[index + 1]; });
    for (const node of Object.values(graph)) {
      if (node.class_type !== 'MiniMaxH3ImageToVideo' || !Number.isFinite(node.inputs?.width) || !Number.isFinite(node.inputs?.height)) continue;
      const longSide = Math.max(node.inputs.width, node.inputs.height);
      const shortSide = Math.min(node.inputs.width, node.inputs.height);
      [node.inputs.width, node.inputs.height] = input.ratio === '9:16' ? [shortSide, longSide] : [longSide, shortSide];
    }
  }
  if (config.seedNodeId) setInput(graph, config, 'seed', config.seed === -1 ? Math.floor(Math.random() * 2 ** 32) : config.seed);
  if (kind !== 'video') {
    const portrait = input.ratio === '9:16';
    const configuredWidth = config.width || 768;
    const configuredHeight = config.height || 432;
    const longSide = Math.max(configuredWidth, configuredHeight);
    const shortSide = Math.min(configuredWidth, configuredHeight);
    const width = portrait ? shortSide : longSide;
    const height = portrait ? longSide : shortSide;
    for (const key of ['width', 'height', 'steps', 'cfg']) {
      if (!config[`${key}NodeId`]) continue;
      const value = key === 'width' ? width : key === 'height' ? height : config[key];
      setInput(graph, config, key, value);
    }
    for (const node of Object.values(graph)) {
      if ((node.class_type === 'EmptySD3LatentImage' || node.class_type === 'EmptyLatentImage') && Number.isFinite(node.inputs?.width) && Number.isFinite(node.inputs?.height)) {
        const long = Math.max(node.inputs.width, node.inputs.height);
        const short = Math.min(node.inputs.width, node.inputs.height);
        [node.inputs.width, node.inputs.height] = portrait ? [short, long] : [long, short];
        node.inputs.batch_size = 1;
      }
      if (node.class_type === 'TextEncodeQwenImage21' && Number.isFinite(node.inputs?.resolution)) {
        node.inputs.resolution = Math.max(64, Math.min(2048, Math.round(portrait ? Math.min(configuredWidth, configuredHeight) : Math.max(configuredWidth, configuredHeight))));
        node.inputs.prompt = `${node.inputs.prompt || ''}\n画面采用 ${input.ratio === '9:16' ? '9:16 竖屏' : '16:9 横屏'}构图。`;
      }
    }
  }
  return graph;
}

async function execute(job) {
  try {
    if (job.cancelled) return;
    job.status = 'running'; job.message = '正在准备工作流…';
    if (job.kind === 'image' && job.provider === 'gpt') {
      job.message = 'GPT Image 2.5 正在生成…';
      const generated = await generateGptImage(job.config, job.prompt, job.sources, undefined, job.controller.signal, job.ratio);
      if (job.cancelled) return;
      const bytes = await normalizeImageRatio(generated, job.ratio);
      if (job.cancelled) return;
      const name = `${randomUUID()}.png`; const path = filePath(job.projectId, name);
      await mkdir(dirname(path), { recursive: true }); await writeFile(path, bytes);
      if (job.cancelled) { await rm(path, { force: true }); return; }
      job.result = { url: `/api/media/${job.projectId}/${name}`, mime: 'image/png', prompt: job.prompt, generatedAt: Date.now() };
      job.status = 'completed'; job.message = '生成完成，请预览并确认。'; return;
    }
    const origin = validateComfyUrl(job.config.comfy.baseUrl);
    const reference = job.kind === 'image' ? (job.sources.length > 1 ? job.source : job.sources[0]) : job.source;
    const uploadedName = reference ? await inputImage(reference, origin, job.controller.signal) : undefined;
    const uploadedExtraNames = job.kind === 'video' ? await Promise.all(job.sources.slice(1).map(source => inputImage(source, origin, job.controller.signal))) : [];
    if (job.cancelled) return;
    const workflowKind = job.kind === 'image' && reference && !job.config.comfy.image.referenceNodeId ? 'imageEdit' : job.kind;
    const graph = buildMediaWorkflow(job.config.comfy[workflowKind], workflowKind, job, uploadedName, uploadedExtraNames);
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
        const entries = Object.values(completed.outputs || {}).flatMap(node => job.kind === 'video' ? [...(node.videos || []), ...(node.gifs || []), ...(node.images || []).filter(item => /\.(mp4|webm|mov)$/i.test(item.filename || ''))] : node.images || []);
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
    if (bytes.length > (job.kind === 'video' ? 1024 : 40) * 1024 * 1024) throw new Error('生成文件过大，未能导入本机项目。');
    let extension = extname(output.filename).slice(1).toLowerCase();
    const allowed = job.kind === 'video' ? ['mp4', 'webm', 'mov'] : ['png', 'jpg', 'jpeg', 'webp'];
    if (!allowed.includes(extension)) throw new Error(`不支持的生成文件格式：${extension || '未知'}。`);
    if (job.kind === 'image') { bytes = await normalizeImageRatio(bytes, job.ratio); extension = 'png'; }
    if (job.cancelled) return;
    const name = `${randomUUID()}.${extension}`;
    const path = filePath(job.projectId, name);
    await mkdir(dirname(path), { recursive: true }); await writeFile(path, bytes);
    if (job.cancelled) { await rm(path, { force: true }); return; }
    job.result = { url: `/api/media/${job.projectId}/${name}`, mime: response.headers.get('content-type') || (job.kind === 'video' ? `video/${extension}` : `image/${extension}`), prompt: job.prompt, generatedAt: Date.now() };
    job.status = 'completed'; job.message = '生成完成，请预览并确认。';
  } catch (error) { if (job.cancelled) return; job.status = 'failed'; job.error = error instanceof TypeError ? '无法连接本机 ComfyUI。请确认服务地址与运行状态。' : error instanceof Error ? error.message : String(error); job.message = '生成失败'; }
  finally { await job.cancelPromise; if (activeJob === job.id) activeJob = null; queueMicrotask(startNext); }
}
export function createMediaJob(settings, input) {
  if (!['image', 'video'].includes(input.kind) || typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 8000) throw new Error('媒体生成请求无效。');
  safeId(input.projectId);
  const provider = input.kind === 'image' ? (input.provider || settings.imageProvider || 'qwen') : 'minimax';
  if (input.kind === 'image' && !['qwen', 'gpt'].includes(provider)) throw new Error('生图方式无效。');
  const sources = input.sources ?? (input.source ? [input.source] : []);
  if (!Array.isArray(sources) || sources.length > (input.kind === 'video' ? 8 : 4) || sources.some(source => typeof source !== 'string' || !validImageSource(source))) throw new Error(input.kind === 'video' ? '参考图无效，视频最多选择 8 张 PNG、JPEG 或 WebP 图片。' : '参考图无效，最多选择 4 张 PNG、JPEG 或 WebP 图片。');
  if (input.kind === 'image' && provider === 'qwen' && sources.length > 1 && (!validImageSource(input.source) || !input.source.startsWith('data:image/jpeg;base64,'))) throw new Error('多张参考图需要先合成参考板。');
  if (input.kind === 'video' && (!input.source || !Number.isFinite(input.duration) || input.duration < 1 || input.duration > 15)) throw new Error('MiniMax H3 需要首帧图片，时长须在 1–15 秒之间。');
  if (input.kind === 'video' && (sources[0] !== input.source || (sources.length > 1 && (!Array.isArray(input.cutPoints) || input.cutPoints.length !== sources.length || input.cutPoints[0] !== 0 || input.cutPoints.some((time, index) => !Number.isFinite(time) || time < 0 || time >= input.duration || (index > 0 && time <= input.cutPoints[index - 1])) || (settings.comfy.video.referenceSlots?.length || 0) < sources.length - 1)))) throw new Error('多图视频需要完整的图片节点映射和严格递增的切点。');
  if (input.ratio !== undefined && !['16:9', '9:16'].includes(input.ratio)) throw new Error('项目画面比例无效。');
  if (provider === 'qwen' || input.kind === 'video') {
    const reference = input.kind === 'image' ? (sources.length > 1 ? input.source : sources[0]) : input.source;
    const workflowKind = input.kind === 'image' && reference && !settings.comfy.image.referenceNodeId ? 'imageEdit' : input.kind;
    buildMediaWorkflow(settings.comfy[workflowKind], workflowKind, input, reference ? '__reference__' : undefined, input.kind === 'video' ? sources.slice(1).map((_, index) => `__reference_${index + 2}__`) : []);
  }
  const job = { id: randomUUID(), projectId: input.projectId, kind: input.kind, provider, prompt: input.prompt.trim(), duration: input.duration, ratio: input.ratio || '16:9', source: input.source, sources, cutPoints: input.cutPoints, status: 'queued', message: '等待执行…', config: structuredClone(settings), controller: new AbortController() };
  jobs.set(job.id, job); pending.push(job.id); queueMicrotask(startNext);
  return publicJob(job);
}
export function getMediaJob(id) { const job = jobs.get(id); return job ? publicJob(job) : null; }
export async function cancelMediaJob(id, message = '任务已取消。') {
  const job = jobs.get(id);
  if (!job) throw new Error('媒体任务不存在或服务已重启。');
  if (job.status === 'cancelled') { await job.cancelPromise; return publicJob(job); }
  if (!['queued', 'running'].includes(job.status)) return publicJob(job);
  const wasQueued = job.status === 'queued';
  job.cancelled = true; job.status = 'cancelled'; job.message = message;
  if (wasQueued) {
    const index = pending.indexOf(id); if (index !== -1) pending.splice(index, 1);
    queueMicrotask(startNext);
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
  const match = typeof url === 'string' && url.match(/^\/api\/media\/([a-zA-Z0-9_-]{3,80})\/([a-f0-9-]{36}\.(?:png|jpg|jpeg|webp|mp4|webm|mov))$/);
  if (!match) throw new Error('只能删除本应用保存的媒体文件。');
  await rm(filePath(match[1], match[2]), { force: true });
}
