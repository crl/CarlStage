import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, readFile, cp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { Codex } from '@openai/codex-sdk';
import { mapSkillResult } from './map.mjs';
import { singleEpisodeOutlineWarning } from './quality.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RUNS = join(ROOT, '.local-runs');
const VENDOR = join(ROOT, 'vendor', 'shuohao-skills-pinned', 'skills');
const VERSION = 'ca1c30be78bde70fa84d3817453c71e0ef25b751';
const MODEL = process.env.REELBENCH_CODEX_MODEL || 'gpt-5.5';
const SKILLS = { outline: 'novel-outline', cast: 'novel-characters', art: 'novel-art', script: 'novel-script', storyboard: 'novel-storyboard' };
const NAMES = { outline: 'outline', cast: 'cast', art: 'art', script: 'script', storyboard: 'storyboard' };
const jobs = new Map();
const activeProjects = new Set();
const globalCodex = process.platform === 'win32' && process.env.APPDATA
  ? join(process.env.APPDATA, 'npm', 'node_modules', '@openai', 'codex', 'node_modules', '@openai', 'codex-win32-x64', 'vendor', 'x86_64-pc-windows-msvc', 'bin', 'codex.exe')
  : '';
const codex = new Codex(globalCodex && existsSync(globalCodex) ? { codexPathOverride: globalCodex } : undefined);

function send(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
}
async function body(req) {
  let size = 0; const chunks = [];
  for await (const chunk of req) { size += chunk.length; if (size > 25 * 1024 * 1024) throw new Error('请求内容超过 25 MB。'); chunks.push(chunk); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
function publicJob(job) { const { controller, project, workspace, thread, ...visible } = job; return visible; }
function projectPath(id) { if (!/^[a-zA-Z0-9_-]{3,80}$/.test(id)) throw new Error('项目 ID 无效。'); return join(RUNS, id); }
async function prepare(job) {
  const workspace = join(projectPath(job.project.id), job.id);
  const skills = join(workspace, '.agents', 'skills');
  await mkdir(skills, { recursive: true });
  const skillName = SKILLS[job.section];
  await cp(join(VENDOR, skillName), join(skills, skillName), { recursive: true, force: true });
  await mkdir(join(workspace, 'output'), { recursive: true });
  const p = job.project;
  await writeFile(join(workspace, 'source.txt'), p.kind === 'novel' ? p.sourceText : p.generatedSource || p.prompt, 'utf8');
  if (p.kind === 'idea') await writeFile(join(workspace, 'original-prompt.txt'), p.prompt, 'utf8');
  await writeFile(join(workspace, 'project.json'), JSON.stringify({ name: p.name, kind: p.kind, genre: p.genre, episodeCount: p.episodeCount, minDuration: p.minDuration, maxDuration: p.maxDuration, adaptation: p.adaptation, ratio: p.ratio, style: p.style, keep: p.keep }, null, 2));
  await writeFile(join(workspace, 'current-docs.json'), JSON.stringify(p.docs, null, 2));
  const artifacts = p.skillArtifacts || {};
  for (const [key, artifact] of Object.entries(artifacts)) {
    if (SKILLS[key] && artifact?.raw) await writeFile(join(workspace, `${NAMES[key]}.json`), JSON.stringify(artifact.raw, null, 2));
  }
  job.workspace = workspace;
  return workspace;
}
function upstream(section) {
  return ({ outline: '', cast: 'outline.json', art: 'outline.json、cast.json（存在时）', script: 'outline.json、art.json、cast.json（存在时）', storyboard: 'script.json、outline.json、cast.json（存在时）' })[section];
}
function promptFor(job, phase) {
  const skill = SKILLS[job.section];
  const p = job.project;
  const base = `请执行 $${skill}。完整遵守 .agents/skills/${skill}/SKILL.md；必要时运行其中的 seed、validate、render。只在当前工作目录操作，不修改网站源码。项目设置在 project.json，输入在 source.txt；current-docs.json 是用户目前确认并可能手工编辑过的页面内容，生成时应参考，若与较旧的原生上游 JSON 冲突，以用户最新编辑为准并修正原生上游内容。题材：${p.genre || '剧情'}；目标 ${p.episodeCount} 集，每集 ${p.minDuration}–${p.maxDuration} 分钟；改编幅度：${p.adaptation}；必须保留：${p.keep || '无'}。${upstream(job.section) ? `上游产物：${upstream(job.section)}。` : ''}${['script', 'storyboard'].includes(job.section) ? '如有多集，按 skill 要求每批最多处理 3 集，最终合并成一个完整 JSON。' : ''}输出完整原生 JSON 到 output/${NAMES[job.section]}.json，并自行运行质量门直到通过。完成后用中文简述结果和校验。`;
  if (job.section !== 'outline') return base;
  if (phase === 'skeleton') return `项目正在执行大纲前的人审。请按 $novel-outline 的要求，先读取 source.txt 和 project.json，产生可供用户审阅的改编骨架：故事内核、保留/删减/合并、主角与冲突、集数节奏。写入 output/outline-skeleton.md。此轮只做骨架，不继续完成分集大纲。${p.kind === 'idea' ? 'original-prompt.txt 是用户原创创意；source.txt 可能是上次扩写的素材。请在此基础上整理成可改编的故事素材，写入 story-source.txt，并清楚标注扩写部分。' : ''}`;
  return `${base} 用户已审阅并确认 output/outline-skeleton.md。请按已确认骨架完成原生大纲。${p.kind === 'idea' ? '使用已生成的 story-source.txt 作为扩写素材，同时保留 source.txt 原始创意。' : ''}`;
}
async function runTurn(job, prompt) {
  const stream = await job.thread.runStreamed(prompt, { signal: job.controller.signal });
  let completed = false;
  let lastError = '';
  for await (const event of stream.events) {
    if (event.type === 'item.completed' && event.item.type === 'agent_message') job.message = event.item.text.slice(-1200);
    if (event.type === 'item.started' && event.item.type === 'command_execution') job.message = `正在运行：${event.item.command.slice(0, 160)}`;
    if (event.type === 'turn.completed') completed = true;
    if (event.type === 'turn.failed') throw new Error(event.error?.message || 'Codex 生成失败。');
    if (event.type === 'error') { lastError = event.message; job.message = event.message; }
  }
  if (!completed) throw new Error(lastError || 'Codex 未能完成生成。');
}
function validate(job, file) {
  return new Promise(resolvePromise => {
    const skill = SKILLS[job.section];
    const script = join(job.workspace, '.agents', 'skills', skill, 'scripts', `${skill}.mjs`);
    const args = [script, 'validate', file];
    const has = key => existsSync(join(job.workspace, `${key}.json`));
    if (job.section === 'cast') args.push(join(job.workspace, 'source.txt'));
    if (job.section === 'art' && has('cast')) args.push('--cast', join(job.workspace, 'cast.json'));
    if (job.section === 'script') { if (has('outline')) args.push('--outline', join(job.workspace, 'outline.json')); if (has('art')) args.push('--art', join(job.workspace, 'art.json')); }
    if (job.section === 'storyboard') for (const key of ['script', 'outline', 'cast']) if (has(key)) args.push(`--${key}`, join(job.workspace, `${key}.json`));
    const child = spawn(process.execPath, args, { cwd: job.workspace, windowsHide: true });
    let output = ''; for (const stream of [child.stdout, child.stderr]) stream.on('data', b => { output = (output + b.toString()).slice(-16000); });
    child.on('error', e => resolvePromise({ ok: false, output: e.message }));
    child.on('close', code => resolvePromise({ ok: code === 0, output }));
  });
}
async function execute(job, phase = 'final') {
  try {
    job.status = 'running'; job.phase = phase; job.message = phase === 'skeleton' ? '正在生成大纲骨架…' : 'Codex 正在执行 skill…';
    const workspace = job.workspace || await prepare(job);
    job.thread ||= codex.startThread({ model: MODEL, workingDirectory: workspace, skipGitRepoCheck: true, sandboxMode: 'workspace-write', approvalPolicy: 'never', networkAccessEnabled: false });
    await runTurn(job, promptFor(job, phase));
    if (job.controller.signal.aborted) throw new Error('任务已取消。');
    if (phase === 'skeleton') {
      job.skeleton = await readFile(join(workspace, 'output', 'outline-skeleton.md'), 'utf8');
      job.status = 'awaiting_confirmation'; job.message = '请审阅并确认大纲骨架。'; return;
    }
    const file = join(workspace, 'output', `${NAMES[job.section]}.json`);
    const raw = JSON.parse(await readFile(file, 'utf8'));
    const checked = await validate(job, file);
    job.validation = checked.output;
    const singleEpisodeException = singleEpisodeOutlineWarning(job.section, job.project.episodeCount, checked.output);
    if (!checked.ok && !singleEpisodeException) throw new Error('Skill 质量门未通过，请查看校验结果。');
    const expansion = job.section === 'outline' && job.project.kind === 'idea' && existsSync(join(workspace, 'story-source.txt'))
      ? await readFile(join(workspace, 'story-source.txt'), 'utf8') : undefined;
    job.result = { mapped: mapSkillResult(job.section, raw, job.project), raw, skillVersion: VERSION, generatedAt: Date.now(), sourceExpansion: expansion };
    job.status = 'completed';
    job.validationWarning = singleEpisodeException ? '单集项目无法满足“大爆点早于最终集”的结构门；其余质量门已通过。' : undefined;
    job.message = singleEpisodeException ? '已生成，存在单集结构质量门例外，请审阅后决定是否写入。' : '已生成并通过校验，请预览后确认写入。';
  } catch (e) {
    job.status = job.controller.signal.aborted ? 'cancelled' : 'failed';
    job.error = e instanceof Error ? e.message : String(e);
  } finally {
    if (job.status !== 'awaiting_confirmation') activeProjects.delete(job.project.id);
  }
}
async function consult(project, mode, message) {
  const workspace = projectPath(project.id);
  await mkdir(workspace, { recursive: true });
  const thread = codex.startThread({ model: MODEL, workingDirectory: workspace, skipGitRepoCheck: true, sandboxMode: 'read-only', approvalPolicy: 'never', networkAccessEnabled: false });
  const schema = mode === 'edit' ? { type: 'object', properties: { reply: { type: 'string' }, scene: { type: 'object', properties: { title: { type: 'string' }, location: { type: 'string' }, description: { type: 'string' }, beats: { type: 'array', items: { type: 'string' } } }, required: ['title', 'location', 'description', 'beats'], additionalProperties: false } }, required: ['reply', 'scene'], additionalProperties: false } : { type: 'object', properties: { reply: { type: 'string' } }, required: ['reply'], additionalProperties: false };
  const result = await thread.run(`你是影视创作顾问。项目与当前剧本 JSON：${JSON.stringify({ name: project.name, prompt: project.prompt, script: project.docs.script }).slice(0, 100000)}。用户请求：${message}。${mode === 'edit' ? '给出修改建议和一个具体的新增场景供预览，不写入文件。' : '讨论并给出具体建议，不写入文件。'}使用中文。`, { outputSchema: schema });
  return JSON.parse(result.finalResponse);
}

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/api/health') return send(res, 200, { ok: true, skillVersion: VERSION });
    if (req.method === 'POST' && url.pathname === '/api/jobs') {
      const { project, section } = await body(req);
      if (!project || !SKILLS[section] || typeof project.id !== 'string') return send(res, 400, { error: '生成请求无效。' });
      projectPath(project.id);
      if (activeProjects.has(project.id)) return send(res, 409, { error: '该项目已有运行中的任务。' });
      if (['cast', 'art', 'script'].includes(section) && !project.skillArtifacts?.outline?.raw) return send(res, 400, { error: '请先用 Codex 生成并确认大纲，再生成此阶段。' });
      if (section === 'storyboard' && !project.skillArtifacts?.script?.raw) return send(res, 400, { error: '请先用 Codex 生成并确认剧本，再生成分镜。' });
      const job = { id: randomUUID(), project, section, status: 'queued', message: '等待启动…', controller: new AbortController() };
      jobs.set(job.id, job); activeProjects.add(project.id); void execute(job, section === 'outline' ? 'skeleton' : 'final');
      return send(res, 202, publicJob(job));
    }
    const match = url.pathname.match(/^\/api\/jobs\/([a-f0-9-]+)(?:\/(continue|cancel))?$/);
    if (match) {
      const job = jobs.get(match[1]); if (!job) return send(res, 404, { error: '任务不存在或服务已重启。' });
      if (req.method === 'GET' && !match[2]) return send(res, 200, publicJob(job));
      if (req.method === 'POST' && match[2] === 'continue' && job.status === 'awaiting_confirmation') { void execute(job); return send(res, 202, publicJob(job)); }
      if (req.method === 'POST' && match[2] === 'cancel' && ['queued', 'running', 'awaiting_confirmation'].includes(job.status)) { job.controller.abort(); job.status = 'cancelled'; activeProjects.delete(job.project.id); return send(res, 200, publicJob(job)); }
    }
    if (req.method === 'POST' && url.pathname === '/api/consult') {
      const { project, mode, message } = await body(req);
      if (!project?.id || !['talk', 'edit'].includes(mode) || !message?.trim()) return send(res, 400, { error: '顾问请求无效。' });
      return send(res, 200, await consult(project, mode, message));
    }
    const projectMatch = url.pathname.match(/^\/api\/projects\/([a-zA-Z0-9_-]{3,80})$/);
    if (req.method === 'DELETE' && projectMatch) {
      const id = projectMatch[1];
      for (const job of jobs.values()) if (job.project.id === id) { job.controller.abort(); jobs.delete(job.id); }
      activeProjects.delete(id);
      await rm(projectPath(id), { recursive: true, force: true });
      return send(res, 200, { ok: true });
    }
    send(res, 404, { error: '接口不存在。' });
  } catch (e) { send(res, 500, { error: e instanceof Error ? e.message : String(e) }); }
}).listen(8787, '127.0.0.1', () => console.log('Codex 本机服务：http://127.0.0.1:8787'));
