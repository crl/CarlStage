import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, readFile, cp, rm, stat, copyFile, appendFile } from 'node:fs/promises';
import { existsSync, createReadStream, createWriteStream } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { Codex } from '@openai/codex-sdk';
import { ollamaChat } from './ollama.mjs';
import { mapSkillResult } from './map.mjs';
import { singleEpisodeOutlineWarning } from './quality.mjs';
import { loadSettings, normalizeSettings, saveSettings, publicSettings, getPreset, checkComfyWorkflow, testComfyConnection, validateWorkflow } from './settings.mjs';
import { createMediaJob, getMediaJob, cancelMediaJob, mediaFilePath, copyMediaToLibrary, uploadLibraryMedia, discardMediaJobResult, cancelProjectMediaJobs, removeProjectMedia, removeMediaUrl } from './media.mjs';
import { resolveCodexPath } from './codex-path.mjs';
import { readStore, saveStore } from './store.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RUNS = process.env.REELBENCH_DATA_DIR || join(ROOT, '.local-runs');
const VENDOR = join(ROOT, 'vendor', 'shuohao-skills-pinned', 'skills');
const DIST = join(ROOT, 'dist');
const VERSION = 'ca1c30be78bde70fa84d3817453c71e0ef25b751';
const SKILLS = { outline: 'novel-outline', cast: 'novel-characters', art: 'novel-art', script: 'novel-script', storyboard: 'novel-storyboard' };
const NAMES = { outline: 'outline', cast: 'cast', art: 'art', script: 'script', storyboard: 'storyboard' };
const jobs = new Map();
const activeProjects = new Set();
const codexFor = config => new Codex({ codexPathOverride: resolveCodexPath(config) });
let settings = await loadSettings();

function send(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
}
async function body(req, limit = 25 * 1024 * 1024) {
  let size = 0; const chunks = [];
  for await (const chunk of req) { size += chunk.length; if (size > limit) throw new Error('请求内容超过允许大小。'); chunks.push(chunk); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
function publicJob(job) { const { controller, project, workspace, thread, config, ...visible } = job; return { ...visible, provider: config.provider }; }
function projectPath(id) { if (!/^[a-zA-Z0-9_-]{3,80}$/.test(id)) throw new Error('项目 ID 无效。'); return join(RUNS, id); }
function outputDir(job) { return job.project.skillProjectImported ? job.workspace : join(job.workspace, 'output'); }
function outputRel(job, name) { return job.project.skillProjectImported ? name : `output/${name}`; }
function safePackagePath(root, relativePath) {
  const clean = String(relativePath || '').replace(/\\/g, '/');
  if (!clean || clean.startsWith('/') || /^[a-zA-Z]:/.test(clean) || clean.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('文件路径无效。');
  const path = resolve(root, ...clean.split('/'));
  if (!path.startsWith(resolve(root) + '\\') && !path.startsWith(resolve(root) + '/')) throw new Error('文件路径无效。');
  return path;
}
const packageMime = { html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8', js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8', json: 'application/json; charset=utf-8', md: 'text/markdown; charset=utf-8', txt: 'text/plain; charset=utf-8', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', woff: 'font/woff', woff2: 'font/woff2' };
function skillRecordsPath(job) { return join(job.workspace, 'skill-records', SKILLS[job.section]); }
function timestampFilePart(at = Date.now()) { return new Date(at).toISOString().replace(/[:.]/g, '-'); }
async function archiveFile(job, source, label) {
  if (!existsSync(source)) return;
  const directory = skillRecordsPath(job);
  await mkdir(directory, { recursive: true });
  await copyFile(source, join(directory, `${timestampFilePart()}-${job.id.slice(0, 8)}-${label}`));
}
async function recordJob(job) {
  try {
    const directory = skillRecordsPath(job);
    await mkdir(directory, { recursive: true });
    if (job.phase === 'skeleton' && job.skeleton) {
      await writeFile(join(directory, `${timestampFilePart()}-${job.id.slice(0, 8)}-outline-skeleton.md`), job.skeleton, 'utf8');
    }
    if (job.status === 'completed' && job.result?.raw) {
      const outputName = `${timestampFilePart(job.result.generatedAt)}-${job.id.slice(0, 8)}-${NAMES[job.section]}.json`;
      await writeFile(join(directory, outputName), JSON.stringify(job.result.raw, null, 2), 'utf8');
    }
    await appendFile(join(directory, 'runs.jsonl'), `${JSON.stringify({ id: job.id, at: Date.now(), phase: job.phase, status: job.status, provider: job.config.provider, message: job.message, error: job.error, validation: job.validation })}\n`, 'utf8');
  } catch (error) {
    job.recordWarning = `Skill 记录未能保存：${error instanceof Error ? error.message : String(error)}`;
  }
}
async function prepare(job) {
  const workspace = job.project.skillProjectImported ? join(projectPath(job.project.id), 'proj') : projectPath(job.project.id);
  job.workspace = workspace;
  const skills = join(workspace, '.agents', 'skills');
  await mkdir(skills, { recursive: true });
  const skillName = SKILLS[job.section];
  await cp(join(VENDOR, skillName), join(skills, skillName), { recursive: true, force: true });
  const output = outputDir(job);
  await mkdir(output, { recursive: true });
  const outputFile = join(output, `${NAMES[job.section]}.json`);
  await archiveFile(job, outputFile, `previous-${NAMES[job.section]}.json`);
  await rm(outputFile, { force: true });
  const p = job.project;
  await writeFile(join(workspace, 'source.txt'), p.kind === 'novel' ? p.sourceText : p.generatedSource || p.prompt, 'utf8');
  if (p.kind === 'idea') await writeFile(join(workspace, 'original-prompt.txt'), p.prompt, 'utf8');
  else await rm(join(workspace, 'original-prompt.txt'), { force: true });
  if (job.section === 'outline') {
    const skeleton = join(output, 'outline-skeleton.md');
    await archiveFile(job, skeleton, 'previous-outline-skeleton.md');
    await rm(skeleton, { force: true });
    await archiveFile(job, join(workspace, 'story-source.txt'), 'previous-story-source.txt');
    await rm(join(workspace, 'story-source.txt'), { force: true });
  }
  await writeFile(join(workspace, 'project.json'), JSON.stringify({ name: p.name, kind: p.kind, genre: p.genre, episodeCount: p.episodeCount, minDuration: p.minDuration, maxDuration: p.maxDuration, adaptation: p.adaptation, ratio: p.ratio, style: p.style, keep: p.keep }, null, 2));
  await writeFile(join(workspace, 'current-docs.json'), JSON.stringify(p.docs, null, 2));
  const artifacts = p.skillArtifacts || {};
  for (const [key, artifact] of Object.entries(artifacts)) {
    if (!SKILLS[key] || !artifact?.raw) continue;
    const inputPath = join(workspace, `${NAMES[key]}.json`);
    const nextInput = JSON.stringify(artifact.raw, null, 2);
    if (existsSync(inputPath) && await readFile(inputPath, 'utf8') !== nextInput) await archiveFile(job, inputPath, `previous-input-${NAMES[key]}.json`);
    await writeFile(inputPath, nextInput);
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
  const base = `请执行 $${skill}。完整遵守 .agents/skills/${skill}/SKILL.md；必要时运行其中的 seed、validate、render。只在当前工作目录操作，不修改网站源码。项目设置在 project.json，输入在 source.txt；current-docs.json 是用户目前确认并可能手工编辑过的页面内容，生成时应参考，若与较旧的原生上游 JSON 冲突，以用户最新编辑为准并修正原生上游内容。题材：${p.genre || '剧情'}；目标 ${p.episodeCount} 集，每集 ${p.minDuration}–${p.maxDuration} 分钟；改编幅度：${p.adaptation}；必须保留：${p.keep || '无'}。${upstream(job.section) ? `上游产物：${upstream(job.section)}。` : ''}${['script', 'storyboard'].includes(job.section) ? '如有多集，按 skill 要求每批最多处理 3 集，最终合并成一个完整 JSON。' : ''}输出完整原生 JSON 到 ${outputRel(job, `${NAMES[job.section]}.json`)}，并自行运行质量门直到通过。完成后用中文简述结果和校验。`;
  if (job.section !== 'outline') return base;
  if (phase === 'skeleton') return `项目正在执行大纲前的人审。请按 $novel-outline 的要求，先读取 source.txt 和 project.json，产生可供用户审阅的改编骨架：故事内核、保留/删减/合并、主角与冲突、集数节奏。写入 ${outputRel(job, 'outline-skeleton.md')}。此轮只做骨架，不继续完成分集大纲。${p.kind === 'idea' ? 'original-prompt.txt 是用户原创创意；source.txt 可能是上次扩写的素材。请在此基础上整理成可改编的故事素材，写入 story-source.txt，并清楚标注扩写部分。' : ''}`;
  return `${base} 用户已审阅并确认 ${outputRel(job, 'outline-skeleton.md')}。请按已确认骨架完成原生大纲。${p.kind === 'idea' ? '使用已生成的 story-source.txt 作为扩写素材，同时保留 source.txt 原始创意。' : ''}`;
}
async function runTurn(job, prompt) {
  if (job.config.provider === 'ollama') {
    const skill = SKILLS[job.section];
    const outputPath = job.phase === 'skeleton' ? outputRel(job, 'outline-skeleton.md') : outputRel(job, `${NAMES[job.section]}.json`);
    await ollamaChat({ ...job.config, model: job.config.ollamaModel }, [
      { role: 'system', content: `你是影视创作代理。先调用 read_file 阅读 .agents/skills/${skill}/SKILL.md 和所需文件，再用工具完成任务。推理强度：${job.config.reasoningEffort}。必须按 skill 要求运行脚本。最终交付内容必须调用 write_output 工具保存；该工具会自动写入正确文件，无需自行指定路径。只有收到“最终产物已写入”的工具结果后，才能说明任务完成。` },
      { role: 'user', content: prompt },
    ], { signal: job.controller.signal, workspace: job.workspace, skill, outputPath, onMessage: value => { job.message = value.slice(-1200); } });
    return;
  }
  const stream = await job.thread.runStreamed(prompt, { signal: job.controller.signal });
  let completed = false;
  let lastError = '';
  for await (const event of stream.events) {
    if (event.type === 'item.completed' && event.item.type === 'agent_message') job.message = event.item.text.slice(-1200);
    if (event.type === 'item.started' && event.item.type === 'command_execution') job.message = `正在运行：${event.item.command.slice(0, 160)}`;
    if (event.type === 'turn.completed') completed = true;
    if (event.type === 'turn.failed') throw new Error(event.error?.message || `${job.config.provider === 'ollama' ? 'Ollama' : 'Codex'} 生成失败。`);
    if (event.type === 'error') { lastError = event.message; job.message = event.message; }
  }
  if (!completed) throw new Error(lastError || `${job.config.provider === 'ollama' ? 'Ollama' : 'Codex'} 未能完成生成。`);
}
function validate(job, file) {
  return new Promise(resolvePromise => {
    const skill = SKILLS[job.section];
    const script = join(job.workspace, '.agents', 'skills', skill, 'scripts', `${skill}.mjs`);
    const args = [script, 'validate', file];
    const has = key => existsSync(join(job.workspace, `${key}.json`));
    if (job.section === 'cast' && existsSync(join(job.workspace, 'source.txt'))) args.push(join(job.workspace, 'source.txt'));
    if (job.section === 'art' && has('cast')) args.push('--cast', join(job.workspace, 'cast.json'));
    if (job.section === 'script') { if (has('outline')) args.push('--outline', join(job.workspace, 'outline.json')); if (has('art')) args.push('--art', join(job.workspace, 'art.json')); }
    if (job.section === 'storyboard') for (const key of ['script', 'outline', 'cast']) if (has(key)) args.push(`--${key}`, join(job.workspace, `${key}.json`));
    const child = spawn(process.execPath, args, { cwd: job.workspace, windowsHide: true });
    let output = ''; for (const stream of [child.stdout, child.stderr]) stream.on('data', b => { output = (output + b.toString()).slice(-16000); });
    child.on('error', e => resolvePromise({ ok: false, output: e.message }));
    child.on('close', code => resolvePromise({ ok: code === 0, output }));
  });
}
async function renderStageReports(job, jsonPath) {
  if (!job.project.skillProjectImported) return;
  const skill = SKILLS[job.section];
  const script = join(job.workspace, '.agents', 'skills', skill, 'scripts', `${skill}.mjs`);
  const args = [script, 'render', jsonPath, '--html'];
  const mdArgs = [script, 'render', jsonPath, '--md'];
  const addExisting = (target, keys) => { for (const key of keys) if (existsSync(join(job.workspace, `${key}.json`))) target.push(`--${key}`, join(job.workspace, `${key}.json`)); };
  if (job.section === 'script') { addExisting(args, ['outline', 'art', 'cast']); addExisting(mdArgs, ['outline', 'art']); }
  if (job.section === 'storyboard') { addExisting(args, ['script', 'outline', 'art']); addExisting(mdArgs, ['script', 'outline', 'art']); }
  const run = (commandArgs, filename) => new Promise(resolvePromise => {
    const child = spawn(process.execPath, commandArgs, { cwd: job.workspace, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output = (output + chunk).slice(-6000); });
    child.on('error', error => resolvePromise({ ok: false, error: error.message }));
    child.on('close', async code => {
      if (code !== 0) return resolvePromise({ ok: false, error: output });
      try { await writeFile(join(job.workspace, filename), output, 'utf8'); resolvePromise({ ok: true }); }
      catch (error) { resolvePromise({ ok: false, error: error instanceof Error ? error.message : String(error) }); }
    });
  });
  const reportName = job.section === 'cast' ? 'cast-report.html' : `${NAMES[job.section]}-report.html`;
  const [html, markdown] = await Promise.all([run(args, reportName), run(mdArgs, `${NAMES[job.section]}.md`)]);
  const failures = [html, markdown].filter(result => !result.ok);
  if (failures.length) job.reportWarning = `JSON 已生成，但阶段报告渲染失败：${failures.map(item => item.error).join('\n').slice(-1200)}`;
}
async function execute(job, phase = 'final') {
  const timeout = setTimeout(() => { job.timedOut = true; job.controller.abort(); }, job.config.timeoutMinutes * 60_000);
  try {
    job.status = 'running'; job.phase = phase; job.message = phase === 'skeleton' ? '正在生成大纲骨架…' : `${job.config.provider === 'ollama' ? 'Ollama' : 'Codex'} 正在执行 skill…`;
    const workspace = job.workspace || await prepare(job);
    if (job.config.provider === 'codex') job.thread ||= codexFor(job.config).startThread({ model: job.config.model, modelReasoningEffort: job.config.reasoningEffort, workingDirectory: workspace, skipGitRepoCheck: true, sandboxMode: 'workspace-write', approvalPolicy: 'never', networkAccessEnabled: false });
    await runTurn(job, promptFor(job, phase));
    if (job.controller.signal.aborted) throw new Error('任务已取消。');
    if (phase === 'skeleton') {
      const skeletonPath = join(outputDir(job), 'outline-skeleton.md');
      if (!existsSync(skeletonPath)) throw new Error(job.config.provider === 'ollama' ? 'Ollama 没有写入大纲骨架。请重试；任务完成回复不会代替实际文件。' : '大纲骨架文件未生成，请重试。');
      job.skeleton = await readFile(skeletonPath, 'utf8');
      job.status = 'awaiting_confirmation'; job.message = '请审阅并确认大纲骨架。'; return;
    }
    const file = join(outputDir(job), `${NAMES[job.section]}.json`);
    if (!existsSync(file)) throw new Error(job.config.provider === 'ollama' ? `Ollama 没有写入 ${NAMES[job.section]}.json。请重试；任务完成回复不会代替实际文件。` : `${NAMES[job.section]}.json 文件未生成，请重试。`);
    let raw;
    let checked = { ok: false, output: '' };
    let singleEpisodeException;
    const maxValidationAttempts = job.config.provider === 'ollama' ? 3 : 1;
    for (let attempt = 0; attempt < maxValidationAttempts; attempt++) {
      if (attempt > 0) {
        job.message = `质量门未通过，Ollama 正在按实际校验结果修正（${attempt}/${maxValidationAttempts - 1}）…`;
        await runTurn(job, `上一次生成的 ${NAMES[job.section]}.json 未通过服务端质量门。请先读取当前 JSON 和 .agents/skills/${SKILLS[job.section]}/SKILL.md，按下方校验器的每一条错误修正原文件。必须通过 write_output 保存完整的修正后 JSON，再运行 skill 的 validate 工具确认。不可只回复说明，也不可声称未经验证的内容已通过。\n\n服务端校验结果：\n${checked.output}`);
        if (job.controller.signal.aborted) throw new Error('任务已取消。');
      }
      try {
        raw = JSON.parse(await readFile(file, 'utf8'));
        checked = await validate(job, file);
      } catch (error) {
        checked = { ok: false, output: `输出 JSON 无法解析：${error instanceof Error ? error.message : String(error)}` };
      }
      job.validation = checked.output;
      singleEpisodeException = singleEpisodeOutlineWarning(job.section, job.project.episodeCount, checked.output);
      if (checked.ok || singleEpisodeException) break;
    }
    if (!checked.ok && !singleEpisodeException) throw new Error(job.config.provider === 'ollama' ? 'Ollama 自动修正后仍未通过 Skill 质量门，请查看实际校验明细。' : 'Skill 质量门未通过，请查看校验结果。');
    await renderStageReports(job, file);
    const expansion = job.section === 'outline' && job.project.kind === 'idea' && existsSync(join(workspace, 'story-source.txt'))
      ? await readFile(join(workspace, 'story-source.txt'), 'utf8') : undefined;
    job.result = { mapped: mapSkillResult(job.section, raw, job.project), raw, skillVersion: VERSION, generatedAt: Date.now(), sourceExpansion: expansion };
    job.status = 'completed';
    await recordJob(job);
    job.validationWarning = singleEpisodeException ? '单集项目无法满足“大爆点早于最终集”的结构门；其余质量门已通过。' : undefined;
    job.message = singleEpisodeException ? '已生成，存在单集结构质量门例外，请审阅后决定是否写入。' : '已生成并通过校验，请预览后确认写入。';
  } catch (e) {
    job.status = job.timedOut ? 'failed' : job.controller.signal.aborted ? 'cancelled' : 'failed';
    job.error = job.timedOut ? `${job.config.provider === 'ollama' ? 'Ollama' : 'Codex'} 任务超过 ${job.config.timeoutMinutes} 分钟。` : e instanceof Error ? e.message : String(e);
  } finally {
    clearTimeout(timeout);
    if (job.status !== 'completed') await recordJob(job);
    if (job.status !== 'awaiting_confirmation') activeProjects.delete(job.project.id);
  }
}
async function consult(project, mode, message) {
  const workspace = projectPath(project.id);
  await mkdir(workspace, { recursive: true });
  const config = { ...settings.codex };
  const thread = config.provider === 'codex' ? codexFor(config).startThread({ model: config.model, modelReasoningEffort: config.reasoningEffort, workingDirectory: workspace, skipGitRepoCheck: true, sandboxMode: 'read-only', approvalPolicy: 'never', networkAccessEnabled: false }) : null;
  const schema = mode === 'edit' ? { type: 'object', properties: { reply: { type: 'string' }, scene: { type: 'object', properties: { title: { type: 'string' }, location: { type: 'string' }, description: { type: 'string' }, beats: { type: 'array', items: { type: 'string' } } }, required: ['title', 'location', 'description', 'beats'], additionalProperties: false } }, required: ['reply', 'scene'], additionalProperties: false } : { type: 'object', properties: { reply: { type: 'string' } }, required: ['reply'], additionalProperties: false };
  const prompt = `你是影视创作顾问。项目与当前剧本 JSON：${JSON.stringify({ name: project.name, prompt: project.prompt, script: project.docs.script }).slice(0, 100000)}。用户请求：${message}。${mode === 'edit' ? '给出修改建议和一个具体的新增场景供预览，不写入文件。' : '讨论并给出具体建议，不写入文件。'}使用中文。只返回符合此 JSON Schema 的 JSON：${JSON.stringify(schema)}`;
  const output = thread ? (await thread.run(prompt, { outputSchema: schema })).finalResponse : await ollamaChat({ ...config, model: config.ollamaModel }, [{ role: 'user', content: prompt }], { signal: AbortSignal.timeout(config.timeoutMinutes * 60_000), json: true });
  return JSON.parse(output);
}

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/api/health') return send(res, 200, { ok: true, skillVersion: VERSION });
    if (req.method === 'GET' && url.pathname === '/api/store') return send(res, 200, await readStore());
    if (req.method === 'PUT' && url.pathname === '/api/store') return send(res, 200, await saveStore(await body(req, 200 * 1024 * 1024)));
    const projStart = url.pathname.match(/^\/api\/projects\/([a-zA-Z0-9_-]{3,80})\/proj\/import\/start$/);
    if (req.method === 'POST' && projStart) {
      const importId = randomUUID();
      await mkdir(join(projectPath(projStart[1]), `.proj-import-${importId}`), { recursive: true });
      return send(res, 201, { importId });
    }
    const projUpload = url.pathname.match(/^\/api\/projects\/([a-zA-Z0-9_-]{3,80})\/proj\/import\/([a-f0-9-]{36})$/);
    if (req.method === 'PUT' && projUpload) {
      try {
        const root = join(projectPath(projUpload[1]), `.proj-import-${projUpload[2]}`);
        if (!existsSync(root)) return send(res, 404, { error: '导入任务不存在。' });
        const target = safePackagePath(root, url.searchParams.get('path'));
        await mkdir(dirname(target), { recursive: true });
        let size = 0;
        const output = createWriteStream(target, { flags: 'w' });
        for await (const chunk of req) { size += chunk.length; if (size > 250 * 1024 * 1024) throw new Error('单个文件不能超过 250 MB。'); output.write(chunk); }
        const done = new Promise((resolvePromise, reject) => { output.once('finish', resolvePromise); output.once('error', reject); });
        output.end();
        await done;
        return send(res, 200, { ok: true });
      } catch (e) { return send(res, 400, { error: e instanceof Error ? e.message : String(e) }); }
    }
    const projFinish = url.pathname.match(/^\/api\/projects\/([a-zA-Z0-9_-]{3,80})\/proj\/import\/([a-f0-9-]{36})\/finish$/);
    if (req.method === 'POST' && projFinish) {
      const id = projFinish[1];
      const root = join(projectPath(id), `.proj-import-${projFinish[2]}`);
      try {
        if (activeProjects.has(id)) throw new Error('该项目有正在运行的生成任务，请任务结束或取消后再导入。');
        const index = join(root, 'index.html');
        if (!existsSync(index)) throw new Error('选择的目录中没有根目录 index.html。');
        const candidates = { outline: ['outline.json'], cast: ['cast.json', 'characters.json'], art: ['art.json'], script: ['script.json'], storyboard: ['storyboard.json'] };
        const current = (await readStore()).projects.find(project => project.id === id);
        if (!current) throw new Error('当前项目不存在。');
        const docs = { ...current.docs };
        const skillArtifacts = { ...(current.skillArtifacts || {}) };
        let found = 0;
        for (const [section, names] of Object.entries(candidates)) {
          let file;
          for (const name of names) { const candidate = join(root, name); if (existsSync(candidate)) { file = candidate; break; } }
          if (!file) continue;
          const raw = JSON.parse(await readFile(file, 'utf8'));
          docs[section] = mapSkillResult(section, raw, current);
          skillArtifacts[section] = { raw, skillVersion: VERSION, generatedAt: Date.now() };
          found++;
        }
        if (!found) throw new Error('目录中没有可识别的 outline.json、cast.json、art.json、script.json 或 storyboard.json。');
        let sourceText;
        const sourcePath = join(root, 'source.txt');
        if (existsSync(sourcePath)) sourceText = await readFile(sourcePath, 'utf8');
        const destination = join(projectPath(id), 'proj');
        const backup = join(projectPath(id), `.proj-backup-${Date.now()}`);
        const hasBackup = existsSync(destination);
        if (hasBackup) await cp(destination, backup, { recursive: true, force: true, errorOnExist: false });
        try {
          await mkdir(destination, { recursive: true });
          await cp(root, destination, { recursive: true, force: true, errorOnExist: false });
        } catch (error) {
          if (hasBackup && existsSync(backup)) {
            await cp(backup, destination, { recursive: true, force: true, errorOnExist: false });
          }
          throw error;
        }
        setImmediate(() => { void rm(root, { recursive: true, force: true }).catch(() => {}); });
        const latest = await readStore();
        await saveStore({ ...latest, projects: latest.projects.map(project => project.id === id ? { ...project, skillProjectImported: true, docs, skillArtifacts, updatedAt: Date.now() } : project) });
        return send(res, 200, { docs, skillArtifacts, sourceText, sourceName: sourceText ? 'source.txt' : undefined });
      } catch (e) { return send(res, 400, { error: e instanceof Error ? e.message : String(e) }); }
    }
    const packageMatch = url.pathname.match(/^\/api\/projects\/([a-zA-Z0-9_-]{3,80})\/proj\/(.*)$/);
    if (req.method === 'GET' && packageMatch) {
      try {
        const root = join(projectPath(packageMatch[1]), 'proj');
        const path = safePackagePath(root, decodeURIComponent(packageMatch[2] || 'index.html'));
        const info = await stat(path);
        const ext = path.split('.').pop()?.toLowerCase();
        if (ext === 'html' || ext === 'htm') {
          const source = await readFile(path, 'utf8');
          const copyToastScript = `<script>(() => { const toast = () => { try { window.parent.dispatchEvent(new CustomEvent('carlstage:toast', { detail: '已复制' })); } catch {} let node = document.getElementById('carlstage-copy-toast'); if (!node) { node = document.createElement('div'); node.id = 'carlstage-copy-toast'; node.textContent = '已复制'; Object.assign(node.style, { position: 'fixed', top: '20px', left: '50%', transform: 'translateX(-50%)', zIndex: '2147483647', padding: '10px 18px', color: '#fff', background: '#242424', border: '1px solid #555', borderRadius: '8px', font: '14px sans-serif', boxShadow: '0 4px 16px #0008', opacity: '0', transition: 'opacity .15s' }); document.body.appendChild(node); } node.textContent = '已复制'; node.style.opacity = '1'; clearTimeout(node._hideTimer); node._hideTimer = setTimeout(() => { node.style.opacity = '0'; }, 2200); }; const clipboard = navigator.clipboard; if (!clipboard) return; for (const method of ['writeText', 'write']) { const original = clipboard[method]?.bind(clipboard); if (!original) continue; try { clipboard[method] = async (...args) => { const result = await original(...args); toast(); return result; }; } catch {} } })();</script>`;
          const html = /<\/body\s*>/i.test(source) ? source.replace(/<\/body\s*>/i, `${copyToastScript}</body>`) : `${source}${copyToastScript}`;
          const data = Buffer.from(html);
          res.writeHead(200, { 'content-type': packageMime[ext] || 'text/html; charset=utf-8', 'content-length': data.length, 'cache-control': 'no-store' });
          res.end(data); return;
        }
        res.writeHead(200, { 'content-type': packageMime[ext] || 'application/octet-stream', 'content-length': info.size, 'cache-control': 'no-store' });
        createReadStream(path).pipe(res); return;
      } catch { return send(res, 404, { error: '项目文件不存在。' }); }
    }
    if (req.method === 'GET' && url.pathname === '/api/settings') return send(res, 200, publicSettings(settings));
    if (req.method === 'PUT' && url.pathname === '/api/settings') {
      try { const update = await body(req); settings = await saveSettings({ ...update, gptImage: { ...update.gptImage, apiKey: update.gptImage?.apiKey ?? settings.gptImage.apiKey } }); return send(res, 200, publicSettings(settings)); }
      catch (e) { return send(res, 400, { error: e instanceof Error ? e.message : String(e) }); }
    }
    const presetMatch = url.pathname.match(/^\/api\/settings\/presets\/(image|imageEdit|video)$/);
    if (req.method === 'GET' && presetMatch) return send(res, 200, getPreset(presetMatch[1]));
    if (req.method === 'POST' && url.pathname === '/api/settings/presets/check') {
      try { const { baseUrl, workflow } = await body(req); return send(res, 200, await checkComfyWorkflow(baseUrl, workflow)); }
      catch (e) { return send(res, 502, { error: e instanceof Error ? e.message : String(e) }); }
    }
    if (req.method === 'POST' && url.pathname === '/api/settings/codex/test') {
      try {
        const candidate = normalizeSettings({ ...settings, codex: { ...settings.codex, ...await body(req) } }).codex;
        const reply = candidate.provider === 'ollama' ? await ollamaChat({ ...candidate, model: candidate.ollamaModel }, [{ role: 'user', content: '只回复 OK。' }], { signal: AbortSignal.timeout(180_000) }) : (await codexFor(candidate).startThread({ model: candidate.model, modelReasoningEffort: candidate.reasoningEffort, workingDirectory: ROOT, sandboxMode: 'read-only', approvalPolicy: 'never', networkAccessEnabled: false }).run('只回复 OK，不读取或修改文件。', { signal: AbortSignal.timeout(180_000) })).finalResponse;
        return send(res, 200, { ok: true, model: candidate.provider === 'ollama' ? candidate.ollamaModel : candidate.model, reply: reply.slice(0, 100) });
      } catch (e) { return send(res, 502, { error: `Codex 测试失败：${e instanceof Error ? e.message : String(e)}` }); }
    }
    if (req.method === 'POST' && url.pathname === '/api/settings/comfy/test') {
      try { const { baseUrl } = await body(req); return send(res, 200, await testComfyConnection(baseUrl)); }
      catch (e) { return send(res, 502, { error: `ComfyUI 连接失败：${e instanceof Error ? e.message : String(e)}` }); }
    }
    if (req.method === 'POST' && url.pathname === '/api/settings/workflow/check') {
      try { const { workflowJson, promptNodeId, promptInput } = await body(req); return send(res, 200, validateWorkflow(workflowJson, promptNodeId, promptInput)); }
      catch (e) { return send(res, 400, { error: e instanceof Error ? e.message : String(e) }); }
    }
    if (req.method === 'POST' && url.pathname === '/api/media/jobs') {
      try { return send(res, 202, createMediaJob(settings, await body(req))); }
      catch (e) { return send(res, 400, { error: e instanceof Error ? e.message : String(e) }); }
    }
    const mediaJobMatch = url.pathname.match(/^\/api\/media\/jobs\/([a-f0-9-]{36})$/);
    const mediaCancelMatch = url.pathname.match(/^\/api\/media\/jobs\/([a-f0-9-]{36})\/cancel$/);
    if (req.method === 'POST' && mediaCancelMatch) { try { return send(res, 200, await cancelMediaJob(mediaCancelMatch[1])); } catch (e) { return send(res, 404, { error: e instanceof Error ? e.message : String(e) }); } }
    if (req.method === 'GET' && mediaJobMatch) { const job = getMediaJob(mediaJobMatch[1]); return job ? send(res, 200, job) : send(res, 404, { error: '任务不存在或服务已重启。' }); }
    if (req.method === 'POST' && mediaJobMatch) { try { await discardMediaJobResult(mediaJobMatch[1]); return send(res, 200, { ok: true }); } catch (e) { return send(res, 400, { error: e instanceof Error ? e.message : String(e) }); } }
    if (req.method === 'POST' && url.pathname === '/api/media/library-copy') {
      try { const { url: sourceUrl } = await body(req); return send(res, 200, { url: await copyMediaToLibrary(sourceUrl) }); }
      catch (e) { return send(res, 400, { error: e instanceof Error ? e.message : String(e) }); }
    }
    if (req.method === 'POST' && url.pathname === '/api/media/library-upload') {
      try { return send(res, 201, { url: await uploadLibraryMedia(req, url.searchParams.get('kind')) }); }
      catch (e) { return send(res, 400, { error: e instanceof Error ? e.message : String(e) }); }
    }
    if (req.method === 'POST' && url.pathname === '/api/media/delete') {
      try { const { url: mediaUrl } = await body(req); await removeMediaUrl(mediaUrl); return send(res, 200, { ok: true }); }
      catch (e) { return send(res, 400, { error: e instanceof Error ? e.message : String(e) }); }
    }
    const mediaFileMatch = url.pathname.match(/^\/api\/media\/([a-zA-Z0-9_-]{3,80})\/([a-f0-9-]{36}\.(?:png|jpg|jpeg|webp|mp4|webm|mov))$/);
    if (req.method === 'GET' && mediaFileMatch) {
      try {
        const path = mediaFilePath(mediaFileMatch[1], mediaFileMatch[2]);
        const info = await stat(path);
        const ext = mediaFileMatch[2].split('.').pop();
        const mime = ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime' })[ext];
        const range = req.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
        if (range) {
          const start = Number(range[1]); const end = range[2] ? Math.min(Number(range[2]), info.size - 1) : info.size - 1;
          if (start >= info.size || end < start) { res.writeHead(416, { 'content-range': `bytes */${info.size}` }); res.end(); return; }
          res.writeHead(206, { 'content-type': mime, 'content-length': end - start + 1, 'content-range': `bytes ${start}-${end}/${info.size}`, 'accept-ranges': 'bytes', 'cache-control': 'private, max-age=3600' });
          createReadStream(path, { start, end }).pipe(res); return;
        }
        res.writeHead(200, { 'content-type': mime, 'content-length': info.size, 'accept-ranges': 'bytes', 'cache-control': 'private, max-age=3600' });
        createReadStream(path).pipe(res); return;
      } catch { return send(res, 404, { error: '本机媒体文件不存在。' }); }
    }
    if (req.method === 'POST' && url.pathname === '/api/jobs') {
      const { project, section } = await body(req);
      if (!project || !SKILLS[section] || typeof project.id !== 'string') return send(res, 400, { error: '生成请求无效。' });
      projectPath(project.id);
      if (activeProjects.has(project.id)) return send(res, 409, { error: '该项目已有运行中的任务。' });
      if (['cast', 'art', 'script'].includes(section) && !project.skillArtifacts?.outline?.raw) return send(res, 400, { error: '请先用 Codex 生成并确认大纲，再生成此阶段。' });
      if (section === 'storyboard' && !project.skillArtifacts?.script?.raw) return send(res, 400, { error: '请先用 Codex 生成并确认剧本，再生成分镜。' });
      const job = { id: randomUUID(), project, section, status: 'queued', message: '等待启动…', controller: new AbortController(), config: { ...settings.codex } };
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
      await cancelProjectMediaJobs(id);
      await rm(projectPath(id), { recursive: true, force: true });
      await removeProjectMedia(id);
      return send(res, 200, { ok: true });
    }
    if (req.method === 'GET' && !url.pathname.startsWith('/api/')) {
      const asset = url.pathname.startsWith('/assets/') && /^\/assets\/[a-zA-Z0-9._-]+$/.test(url.pathname) ? url.pathname.slice(1) : 'index.html';
      const path = join(DIST, asset);
      try {
        const info = await stat(path);
        const ext = asset.split('.').pop();
        const mime = ({ html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8', svg: 'image/svg+xml', png: 'image/png', ico: 'image/x-icon' })[ext] || 'application/octet-stream';
        res.writeHead(200, { 'content-type': mime, 'content-length': info.size, 'cache-control': asset === 'index.html' ? 'no-store' : 'public, max-age=31536000, immutable' });
        createReadStream(path).pipe(res); return;
      } catch { return send(res, 404, { error: '前端文件不存在，请先运行 npm run build。' }); }
    }
    send(res, 404, { error: '接口不存在。' });
  } catch (e) { send(res, 500, { error: e instanceof Error ? e.message : String(e) }); }
}).listen(Number(process.env.REELBENCH_PORT || 8787), '127.0.0.1', () => console.log('Codex 本机服务：http://127.0.0.1:' + (process.env.REELBENCH_PORT || 8787)));
