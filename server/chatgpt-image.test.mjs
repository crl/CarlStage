import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateChatgptImage } from './chatgpt-image.mjs';
import { defaultSettings, normalizeSettings } from './settings.mjs';

test('ChatGPT 旧配置迁移为内置服务', () => {
  assert.deepEqual(normalizeSettings({ ...defaultSettings(), chatgptImage: { baseUrl: 'http://127.0.0.1:8317', timeoutMinutes: 4 } }).chatgptImage, { proxy: '', timeoutMinutes: 4 });
  assert.throws(() => normalizeSettings({ ...defaultSettings(), chatgptImage: { proxy: 'file:///invalid' } }));
});

test('八图依次上传并使用服务返回文件下载，不使用远程地址或输出路径', async () => {
  let uploads = 0;
  const fetcher = async (url, options) => {
    if (url.endsWith('/uploads/cleanup')) return Response.json({ ok: true });
    if (url.endsWith('/upload')) { uploads++; assert.equal(options.body.get('files').name, `reference-${uploads}.png`); return Response.json({ files: [{ path: `upload-${uploads}` }] }); }
    if (url.endsWith('/generate')) { const body = JSON.parse(options.body); assert.equal(body.prompt, '画面提示词'); assert.deepEqual(body.ref_images, Array.from({ length: 8 }, (_, i) => `upload-${i + 1}`)); return Response.json({ ok: true, images: [{ file: 'generated.png', path: 'ignored', url: 'ignored' }] }); }
    assert.equal(url, 'http://127.0.0.1:8317/files/generated.png'); return new Response('image');
  };
  assert.equal((await generateChatgptImage({ ...defaultSettings().chatgptImage, baseUrl: 'http://127.0.0.1:8317' }, '画面提示词', Array(8).fill('source'), async () => ({ bytes: Buffer.from('ref'), mime: 'image/png' }), new AbortController().signal, fetcher)).toString(), 'image');
});

test('外部错误不会泄露路径，取消后丢弃返回图片', async () => {
  await assert.rejects(() => generateChatgptImage({ ...defaultSettings().chatgptImage, baseUrl: 'http://127.0.0.1:8317' }, 'test', [], null, new AbortController().signal, async () => Response.json({ detail: 'private path' }, { status: 500 })), error => !error.message.includes('private path'));
  const controller = new AbortController();
  await assert.rejects(() => generateChatgptImage({ ...defaultSettings().chatgptImage, baseUrl: 'http://127.0.0.1:8317' }, 'test', [], null, controller.signal, async () => { controller.abort(); return Response.json({ images: [{ file: 'generated.png' }] }); }), /abort/i);
});

test('无参考图生成及下载失败提示', async () => {
  const config = { ...defaultSettings().chatgptImage, baseUrl: 'http://127.0.0.1:8317' };
  await assert.rejects(() => generateChatgptImage(config, 'test', [], null, new AbortController().signal, async (url, options) => {
    if (url.endsWith('/generate')) { assert.deepEqual(JSON.parse(options.body).ref_images, []); return Response.json({ images: [{ file: 'new.png' }] }); }
    return new Response(null, { status: 500 });
  }), /图片下载失败/);
});

test('参考图上传后取消会清理临时上传', async () => {
  const controller = new AbortController();
  let cleaned = false;
  await assert.rejects(() => generateChatgptImage({ ...defaultSettings().chatgptImage, baseUrl: 'http://127.0.0.1:8317' }, 'test', ['source'], async () => ({ bytes: Buffer.from('ref'), mime: 'image/png' }), controller.signal, async (url, options) => {
    if (url.endsWith('/upload')) { controller.abort(); return Response.json({ files: [{ path: 'upload-1' }] }); }
    if (url.endsWith('/uploads/cleanup')) { assert.deepEqual(JSON.parse(options.body).paths, ['upload-1']); cleaned = true; return Response.json({ ok: true }); }
    throw new Error('不应提交生成');
  }), /abort/i);
  assert.equal(cleaned, true);
});
