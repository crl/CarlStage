import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, relative, dirname, join } from 'node:path';
import { spawn } from 'node:child_process';

const origin = 'http://127.0.0.1:11434';
const tools = [
  { type: 'function', function: { name: 'read_file', description: '读取工作目录内的文件', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'write_file', description: '在工作目录内写入完整文件', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } } },
  { type: 'function', function: { name: 'write_output', description: '写入本次任务要求的最终交付文件；目标路径由系统固定，无需填写路径', parameters: { type: 'object', properties: { content: { type: 'string', description: '最终交付文件的完整内容' } }, required: ['content'] } } },
  { type: 'function', function: { name: 'run_skill', description: '执行当前 skill 的 seed、validate 或 render 脚本', parameters: { type: 'object', properties: { arguments: { type: 'array', items: { type: 'string' } } }, required: ['arguments'] } } },
];
function inside(root, path) {
  const target = resolve(root, path);
  const rel = relative(root, target);
  if (rel.startsWith('..') || resolve(root, rel) !== target) throw new Error('只能访问当前任务工作目录。');
  return target;
}
async function callTool(name, args, workspace, skill, outputPath) {
  if (name === 'read_file') return (await readFile(inside(workspace, args.path), 'utf8')).slice(0, 120000);
  if (name === 'write_file') { const path = inside(workspace, args.path); await mkdir(dirname(path), { recursive: true }); await writeFile(path, args.content, 'utf8'); return '已写入。'; }
  if (name === 'write_output') {
    if (!outputPath || typeof args.content !== 'string' || !args.content.trim()) throw new Error('最终产物内容为空或系统未配置目标文件。');
    const path = inside(workspace, outputPath); await mkdir(dirname(path), { recursive: true }); await writeFile(path, args.content, 'utf8');
    return `最终产物已写入 ${outputPath}（${Buffer.byteLength(args.content, 'utf8')} 字节）。`;
  }
  if (name === 'run_skill') {
    const script = join(workspace, '.agents', 'skills', skill, 'scripts', `${skill}.mjs`);
    const argv = args.arguments || [];
    if (!Array.isArray(argv) || !['seed', 'validate', 'render'].includes(argv[0]) || argv.some(arg => typeof arg !== 'string' || arg.length > 1000 || arg.startsWith('-') && !/^--[a-z-]+$/.test(arg))) throw new Error('Skill 命令无效。');
    for (const arg of argv.slice(1)) if (!arg.startsWith('--') && (arg.includes('/') || arg.includes('\\') || arg.endsWith('.json'))) inside(workspace, arg);
    return await new Promise((resolvePromise, reject) => {
      const child = spawn(process.execPath, [script, ...argv], { cwd: workspace, windowsHide: true });
      let output = ''; for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output = (output + chunk.toString()).slice(-30000); });
      child.on('error', reject); child.on('close', code => resolvePromise(`退出码 ${code}\n${output}`));
    });
  }
  throw new Error('未知工具。');
}
export async function ollamaChat(config, messages, { signal, workspace, skill, outputPath, onMessage, json = false } = {}) {
  const history = [...messages];
  for (let turn = 0; turn < 80; turn++) {
    const response = await fetch(`${origin}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: config.model, messages: history, stream: false, think: config.reasoningEffort !== 'low', ...(json ? { format: 'json' } : {}), ...(skill ? { tools } : {}) }), signal });
    if (!response.ok) throw new Error(`Ollama 请求失败（HTTP ${response.status}）：${(await response.text()).slice(0, 500)}`);
    const data = await response.json(); const answer = data.message;
    if (!answer) throw new Error('Ollama 未返回消息。');
    history.push(answer);
    if (answer.content) onMessage?.(answer.content);
    if (!answer.tool_calls?.length) return answer.content || '';
    for (const call of answer.tool_calls) {
      let result;
      try { const args = typeof call.function.arguments === 'string' ? JSON.parse(call.function.arguments) : call.function.arguments || {}; result = await callTool(call.function.name, args, workspace, skill, outputPath); }
      catch (error) { result = `错误：${error.message}`; }
      history.push({ role: 'tool', tool_name: call.function.name, content: result });
    }
  }
  throw new Error('Ollama 工具调用次数超过限制。');
}
