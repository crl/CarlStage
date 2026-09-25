import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, copyFile, rm } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateComfyUrl, validateWorkflow, validateMapping } from './settings.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const MEDIA = join(ROOT, '.local-runs', 'media');
const jobs = new Map();
let activeJob = null;
const safeId = value => { if (!/^[a-zA-Z0-9_-]{3,80}$/.test(value)) throw new Error('项目 ID 无效。'); return value; };
const filePath = (projectId, name) => { safeId(projectId); if (!/^[a-f0-9-]{36}\.(png|jpg|jpeg|webp|mp4|webm|mov)$/.test(name)) throw new Error('媒体文件名无效。'); return join(MEDIA, projectId, name); };
const publicJob = job => { const { source, config, ...visible } = job; return visible; };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function responseJson(response, label) {
  const text = await response.text();
  let data; try { data = JSON.parse(text); } catch { throw new Error(`${label}返回非 JSON：${text.slice(0, 300)}`); }
  if (!response.ok) throw new Error(`${label}失败（HTTP ${response.status}）：${JSON.stringify(data).slice(0, 500)}`);
  return data;
}
async function inputImage(source, origin) {
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
  const data = await responseJson(await fetch(`${origin}/upload/image`, { method: 'POST', body: form, signal: AbortSignal.timeout(30_000) }), '参考图上传');
  if (!data.name) throw new Error('ComfyUI 未返回参考图文件名。');
  return data.name;
}
function setInput(graph, config, prefix, value, required = false) {
  const id = config[`${prefix}NodeId`]; const key = config[`${prefix}Input`];
  if (!id) { if (required) throw new Error(`请在设置中配置${prefix === 'prompt' ? '提示词' : prefix === 'reference' ? '参考图' : '时长'}节点。`); return; }
  validateMapping(graph, id, key, prefix);
  graph[id].inputs[key] = value;
}
export function buildMediaWorkflow(config, kind, input, uploadedName) {
  validateWorkflow(config.workflowJson);
  if (!config.workflowJson) throw new Error(`请先在设置中导入${kind === 'image' ? 'Qwen-Image-2.1 生图' : 'MiniMax H3 生视频'}工作流。`);
  const graph = JSON.parse(config.workflowJson);
  setInput(graph, config, 'prompt', input.prompt, true);
  if (uploadedName) setInput(graph, config, 'reference', uploadedName, true);
  if (kind === 'video') setInput(graph, config, 'duration', input.duration, true);
  if (config.seedNodeId) setInput(graph, config, 'seed', config.seed === -1 ? Math.floor(Math.random() * 2 ** 32) : config.seed);
  if (kind === 'image') for (const key of ['width', 'height', 'steps', 'cfg']) if (config[`${key}NodeId`]) setInput(graph, config, key, config[key]);
  return graph;
}

async function execute(job) {
  try {
    const origin = validateComfyUrl(job.config.baseUrl);
    job.status = 'running'; job.message = '正在准备工作流…';
    const uploadedName = job.source ? await inputImage(job.source, origin) : undefined;
    const graph = buildMediaWorkflow(job.config[job.kind], job.kind, job, uploadedName);
    job.message = '正在提交 ComfyUI 任务…';
    const submission = await responseJson(await fetch(`${origin}/prompt`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: graph, client_id: job.id }), signal: AbortSignal.timeout(30_000) }), 'ComfyUI 工作流提交');
    if (submission.node_errors && Object.keys(submission.node_errors).length) throw new Error(`工作流节点错误：${JSON.stringify(submission.node_errors).slice(0, 600)}`);
    if (!submission.prompt_id) throw new Error('ComfyUI 未返回任务 ID。');
    job.promptId = submission.prompt_id; job.message = 'ComfyUI 正在生成…';
    const deadline = Date.now() + (job.kind === 'video' ? 90 : 30) * 60_000;
    let output;
    while (Date.now() < deadline) {
      const history = await responseJson(await fetch(`${origin}/history/${encodeURIComponent(job.promptId)}`, { signal: AbortSignal.timeout(15_000) }), 'ComfyUI 进度查询');
      const completed = history[job.promptId];
      if (completed) {
        if (completed.status?.status_str === 'error') throw new Error(`ComfyUI 生成失败：${JSON.stringify(completed.status.messages || []).slice(0, 800)}`);
        const entries = Object.values(completed.outputs || {}).flatMap(node => job.kind === 'video' ? [...(node.videos || []), ...(node.gifs || [])] : node.images || []);
        output = entries.find(item => item.filename);
        if (!output) throw new Error('ComfyUI 已完成，但没有输出可读取的媒体文件。');
        break;
      }
      await wait(1500);
    }
    if (!output) throw new Error('ComfyUI 任务超时。');
    if (job.cancelled) return;
    job.message = '正在保存生成结果…';
    const params = new URLSearchParams({ filename: output.filename, subfolder: output.subfolder || '', type: output.type || 'output' });
    const response = await fetch(`${origin}/view?${params}`, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error(`读取 ComfyUI 结果失败（HTTP ${response.status}）。`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > (job.kind === 'video' ? 1024 : 40) * 1024 * 1024) throw new Error('生成文件过大，未能导入本机项目。');
    const extension = extname(output.filename).slice(1).toLowerCase();
    const allowed = job.kind === 'video' ? ['mp4', 'webm', 'mov'] : ['png', 'jpg', 'jpeg', 'webp'];
    if (!allowed.includes(extension)) throw new Error(`不支持的生成文件格式：${extension || '未知'}。`);
    const name = `${randomUUID()}.${extension}`;
    const path = filePath(job.projectId, name);
    await mkdir(dirname(path), { recursive: true }); await writeFile(path, bytes);
    if (job.cancelled) { await rm(path, { force: true }); return; }
    job.result = { url: `/api/media/${job.projectId}/${name}`, mime: response.headers.get('content-type') || (job.kind === 'video' ? `video/${extension}` : `image/${extension}`), prompt: job.prompt, generatedAt: Date.now() };
    job.status = 'completed'; job.message = '生成完成，请预览并确认。';
  } catch (error) { if (job.cancelled) return; job.status = 'failed'; job.error = error instanceof TypeError ? '无法连接本机 ComfyUI。请确认服务地址与运行状态。' : error instanceof Error ? error.message : String(error); job.message = '生成失败'; }
  finally { activeJob = null; }
}
export function createMediaJob(settings, input) {
  if (activeJob) throw new Error('已有本地生图或生视频任务正在运行，请稍后重试。');
  if (!['image', 'video'].includes(input.kind) || typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 8000) throw new Error('媒体生成请求无效。');
  safeId(input.projectId);
  if (input.kind === 'video' && (!input.source || !Number.isFinite(input.duration) || input.duration < 1 || input.duration > 15)) throw new Error('MiniMax H3 需要首帧图片，时长须在 1–15 秒之间。');
  buildMediaWorkflow(settings.comfy[input.kind], input.kind, input, input.source ? '__reference__' : undefined);
  const job = { id: randomUUID(), projectId: input.projectId, kind: input.kind, prompt: input.prompt.trim(), duration: input.duration, source: input.source, status: 'queued', message: '等待提交…', config: structuredClone(settings.comfy) };
  jobs.set(job.id, job); activeJob = job.id; void execute(job);
  return publicJob(job);
}
export function getMediaJob(id) { const job = jobs.get(id); return job ? publicJob(job) : null; }
export function cancelProjectMediaJobs(projectId) { for (const job of jobs.values()) if (job.projectId === projectId && ['queued', 'running'].includes(job.status)) { job.cancelled = true; job.status = 'cancelled'; job.message = '项目已删除，结果将被丢弃。'; } }
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
