import { createServer } from 'node:net';

function isAvailable(port) {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', error => error.code === 'EADDRINUSE' ? resolve(false) : reject(error));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}

export async function chooseLocalPort(start = 8787, end = 8800, requested = process.env.REELBENCH_PORT) {
  if (requested) {
    const port = Number(requested);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('REELBENCH_PORT 必须是 1024–65535 之间的端口。');
    if (!await isAvailable(port)) throw new Error('指定的本机端口 ' + port + ' 已被占用。');
    return port;
  }
  for (let port = start; port <= end; port++) if (await isAvailable(port)) return port;
  throw new Error(start + '–' + end + ' 端口均已被占用，请关闭旧服务或指定端口。');
}
