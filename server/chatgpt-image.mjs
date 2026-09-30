import { ensureChatgptService } from './chatgpt-service.mjs';
import { validateComfyUrl } from './settings.mjs';

async function jsonResponse(response) {
  if (response.status === 409) throw new Error('ChatGPT 正在登录或生成，请关闭登录窗口并等待当前任务结束后重试。');
  if (!response.ok) throw new Error(`ChatGPT 生图服务返回 HTTP ${response.status}，请检查服务窗口。`);
  try { return await response.json(); } catch { throw new Error('ChatGPT 生图服务返回无效响应。'); }
}

export async function manageChatgptBrowser(action, config, fetcher = fetch) {
  if (fetcher === fetch) config = await ensureChatgptService(config);
  const origin = validateComfyUrl(config.baseUrl);
  try {
    const response = await fetcher(`${origin}${action === 'reset' ? '/session/reset' : action === 'login' ? '/login' : '/status'}`, { method: action === 'status' ? 'GET' : 'POST', headers: config.headers, signal: AbortSignal.timeout(90_000) });
    const result = await jsonResponse(response);
    return { message: action === 'status' ? `内置 ChatGPT 服务已启动 · ${result.busy ? '正在登录或生成，请等待当前操作结束' : result.message || '空闲'}` : result.message || '操作已完成' };
  } catch (error) { if (error.message.startsWith('ChatGPT')) throw error; throw new Error('无法连接 ChatGPT 生图服务，请确认已启动服务且地址正确。'); }
}

export async function generateChatgptImage(config, prompt, sources, sourceBytes, signal, fetcher = fetch) {
  if (fetcher === fetch) config = await ensureChatgptService(config);
  const origin = validateComfyUrl(config.baseUrl);
  const requestSignal = AbortSignal.any([signal, AbortSignal.timeout((config.timeoutMinutes * 60 + 180) * 1000)]);
  const paths = [];
  let submitted = false;
  const cancel = () => { if (submitted) void fetcher(`${origin}/cancel`, { method: 'POST', headers: config.headers, signal: AbortSignal.timeout(3000) }).catch(() => {}); };
  requestSignal.addEventListener('abort', cancel, { once: true });
  try {
    signal.throwIfAborted();
    // Upload individually to preserve attachment order and avoid duplicate upload filenames.
    for (const [index, source] of sources.entries()) {
      signal.throwIfAborted();
      const { bytes, mime } = await sourceBytes(source);
      if (bytes.length > 20 * 1024 * 1024) throw new Error('参考图不得超过 20 MB。');
      const body = new FormData();
      body.append('files', new Blob([bytes], { type: mime }), `reference-${index + 1}.${mime.split('/')[1]}`);
      const uploaded = await jsonResponse(await fetcher(`${origin}/upload`, { method: 'POST', headers: config.headers, body, signal: requestSignal }));
      if (!uploaded.files?.[0]?.path || typeof uploaded.files[0].path !== 'string') throw new Error('ChatGPT 参考图上传失败。');
      paths.push(uploaded.files[0].path);
    }
    signal.throwIfAborted();
    submitted = true;
    const result = await jsonResponse(await fetcher(`${origin}/generate`, { method: 'POST', headers: { ...config.headers, 'content-type': 'application/json' }, body: JSON.stringify({ prompt, ref_images: paths, timeout_sec: config.timeoutMinutes * 60 }), signal: requestSignal }));
    signal.throwIfAborted();
    const file = result.images?.[0]?.file;
    if (result.ok === false || typeof file !== 'string' || !/^[a-zA-Z0-9._-]+\.(png|jpe?g|webp)$/i.test(file)) throw new Error('ChatGPT 生图服务未返回有效图片。');
    const response = await fetcher(`${origin}/files/${encodeURIComponent(file)}`, { headers: config.headers, signal: requestSignal });
    if (!response.ok) throw new Error('ChatGPT 图片下载失败。');
    const bytes = Buffer.from(await response.arrayBuffer());
    signal.throwIfAborted();
    if (!bytes.length || bytes.length > 40 * 1024 * 1024) throw new Error('ChatGPT 返回的图片为空或超过 40 MB。');
    return bytes;
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    if (requestSignal.aborted) throw new Error('ChatGPT 服务请求超时，请检查服务状态。');
    if (/^(ChatGPT|参考图)/.test(error.message)) throw error;
    throw new Error('无法连接 ChatGPT 生图服务，请确认已启动服务且账号已登录。');
  } finally {
    requestSignal.removeEventListener('abort', cancel);
    if (paths.length) await fetcher(`${origin}/uploads/cleanup`, { method: 'POST', headers: { ...config.headers, 'content-type': 'application/json' }, body: JSON.stringify({ paths }), signal: AbortSignal.timeout(3000) }).catch(() => {});
  }
}
