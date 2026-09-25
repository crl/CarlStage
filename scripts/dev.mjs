import { spawn } from 'node:child_process';
import { chooseLocalPort } from './local-port.mjs';

const port = await chooseLocalPort();
const vitePort = await chooseLocalPort(5173, 5190, process.argv.includes('--fixed-vite-port') ? '5173' : process.env.REELBENCH_VITE_PORT);
const env = { ...process.env, REELBENCH_PORT: String(port), REELBENCH_VITE_PORT: String(vitePort) };
console.log('CarlStage API：http://127.0.0.1:' + port);
console.log('网页地址：http://127.0.0.1:' + vitePort);
const children = [
  spawn(process.execPath, ['server/index.mjs'], { stdio: 'inherit', windowsHide: true, env }),
  spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1'], { stdio: 'inherit', windowsHide: true, env })
];
for (const child of children) child.on('exit', () => { for (const other of children) if (other !== child && !other.killed) other.kill(); });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { for (const child of children) child.kill(); });
