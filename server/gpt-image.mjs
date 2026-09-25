import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fetch as undiciFetch, ProxyAgent } from 'undici';
import { mediaFilePath } from './media.mjs';

function windowsProxy() {
  if (process.platform !== 'win32') return '';
  const result = spawnSync('reg.exe', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'], { encoding: 'utf8', windowsHide: true, timeout: 2000 });
  const text = result.stdout || '';
  if (!/ProxyEnable\s+REG_DWORD\s+0x1/i.test(text)) return '';
  const value = text.match(/ProxyServer\s+REG_SZ\s+([^\r\n]+)/i)?.[1]?.trim() || '';
  const address = value.includes(';') ? value.match(/(?:^|;)https=([^;]+)/i)?.[1] : value;
  return address ? (address.includes('://') ? address : `http://${address}`) : '';
}

function proxyDispatcher() {
  const value = process.env.HTTPS_PROXY || process.env.https_proxy || windowsProxy();
  if (!value) return undefined;
  const url = new URL(value);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('HTTP 代理地址无效。');
  return new ProxyAgent(value);
}

export function apiKey(settings) { return settings.gptImage.apiKey || process.env.OPENAI_API_KEY || ''; }

export async function sourceBytes(source) {
  if (/^data:image\/(png|jpeg|webp);base64,/i.test(source)) {
    const match = source.match(/^data:(image\/(?:png|jpeg|webp));base64,(.+)$/i);
    return { bytes: Buffer.from(match[2], 'base64'), mime: match[1].toLowerCase() };
  }
  const match = source.match(/^\/api\/media\/([a-zA-Z0-9_-]{3,80})\/([a-f0-9-]{36}\.(png|jpg|jpeg|webp))$/);
  if (!match) throw new Error('参考图必须是本机图片或上传的 PNG、JPEG、WebP。');
  return { bytes: await readFile(mediaFilePath(match[1], match[2])), mime: `image/${match[3].replace('jpg', 'jpeg')}` };
}

export async function generateGptImage(settings, prompt, sources = [], fetcher = undiciFetch, signal, ratio = '16:9') {
  const key = apiKey(settings);
  if (!key) throw new Error('请先在设置中配置 OpenAI API Key。');
  const model = settings.gptImage.model;
  const quality = settings.gptImage.quality;
  const size = ratio === '9:16' ? '1024x1536' : '1536x1024';
  const dispatcher = proxyDispatcher();
  const headers = { Authorization: `Bearer ${key}` };
  let body, url;
  if (sources.length) {
    body = new FormData();
    body.append('model', model); body.append('quality', quality); body.append('size', size); body.append('prompt', prompt);
    for (const [index, source] of sources.entries()) {
      signal?.throwIfAborted();
      const { bytes, mime } = await sourceBytes(source);
      if (bytes.length > 20 * 1024 * 1024) throw new Error('参考图不得超过 20 MB。');
      body.append('image[]', new Blob([bytes], { type: mime }), `reference-${index + 1}.${mime.split('/')[1]}`);
    }
    url = 'https://api.openai.com/v1/images/edits';
  } else {
    body = JSON.stringify({ model, quality, size, prompt });
    headers['content-type'] = 'application/json';
    url = 'https://api.openai.com/v1/images/generations';
  }
  let response, payload;
  try {
    response = await fetcher(url, { method: 'POST', headers, body, dispatcher, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(600_000)]) : AbortSignal.timeout(600_000) });
    payload = await response.json().catch(() => { throw new Error(`OpenAI 返回无法解析的响应（HTTP ${response.status}）。`); });
  } finally { await dispatcher?.close(); }
  if (!response.ok) throw new Error(`OpenAI 生图失败（HTTP ${response.status}）：${payload.error?.message || '请检查模型权限与 API 额度。'}`);
  const encoded = payload.data?.[0]?.b64_json;
  if (typeof encoded !== 'string' || !encoded) throw new Error('OpenAI 未返回图片数据。');
  const bytes = Buffer.from(encoded, 'base64');
  if (!bytes.length || bytes.length > 40 * 1024 * 1024) throw new Error('OpenAI 返回的图片为空或超过 40 MB。');
  return bytes;
}
