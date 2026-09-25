import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { rm } from 'node:fs/promises';
import { defaultSettings } from './settings.mjs';
import { buildMediaWorkflow, copyMediaToLibrary, createMediaJob, discardMediaJobResult, getMediaJob, mediaFilePath, readMedia, removeProjectMedia } from './media.mjs';

const graph = { '1': { class_type: 'Text', inputs: { text: '' } }, '2': { class_type: 'LoadImage', inputs: { image: '' } }, '3': { class_type: 'SaveImage', inputs: { duration: 5 } } };
const pixel = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/R9sAAAAASUVORK5CYII=';
const finished = async id => { for (let i = 0; i < 100; i++) { const job = getMediaJob(id); if (['completed', 'failed'].includes(job.status)) return job; await new Promise(resolve => setTimeout(resolve, 30)); } throw new Error('任务未完成'); };

test('图片与视频工作流只覆盖已映射的输入', () => {
  const settings = defaultSettings(); const image = settings.comfy.image;
  image.workflowJson = JSON.stringify(graph); image.promptNodeId = '1'; image.referenceNodeId = '2';
  const output = buildMediaWorkflow(image, 'image', { prompt: '人物肖像' }, 'file.png');
  assert.equal(output['1'].inputs.text, '人物肖像'); assert.equal(output['2'].inputs.image, 'file.png'); assert.equal(graph['1'].inputs.text, '');
  assert.throws(() => buildMediaWorkflow({ ...image, referenceNodeId: '' }, 'image', { prompt: '测试' }, 'file.png'), /参考图/);
});

test('模拟 ComfyUI 完成图片和首帧视频任务并保存文件', async t => {
  let currentKind = 'image';
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/upload/image') { for await (const _ of req) { /* consume multipart */ } res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ name: 'uploaded.png' })); return; }
    if (url.pathname === '/prompt') { const chunks = []; for await (const chunk of req) chunks.push(chunk); currentKind = JSON.parse(Buffer.concat(chunks).toString()).prompt['3'].inputs.duration === 7 ? 'video' : 'image'; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ prompt_id: 'mock-task' })); return; }
    if (url.pathname.startsWith('/history/')) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ 'mock-task': { outputs: { '3': { [currentKind === 'video' ? 'videos' : 'images']: [{ filename: currentKind === 'video' ? 'generated.mp4' : 'generated.png', subfolder: '', type: 'output' }] } } } })); return; }
    if (url.pathname === '/view') { res.setHeader('content-type', currentKind === 'video' ? 'video/mp4' : 'image/png'); res.end(currentKind === 'video' ? Buffer.from('mock-video') : Buffer.from(pixel.split(',')[1], 'base64')); return; }
    res.writeHead(404); res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const settings = defaultSettings(); settings.comfy.baseUrl = `http://127.0.0.1:${server.address().port}`;
  const image = settings.comfy.image; image.workflowJson = JSON.stringify(graph); image.promptNodeId = '1'; image.referenceNodeId = '2';
  const projectId = 'testmedia123';
  t.after(async () => { await removeProjectMedia(projectId); });
  const started = createMediaJob(settings, { projectId, kind: 'image', prompt: '人物肖像', source: pixel });
  const result = await finished(started.id);
  assert.equal(result.status, 'completed', result.error);
  assert.match(result.result.url, /^\/api\/media\/testmedia123\//);
  const name = result.result.url.split('/').pop(); assert.ok((await readMedia(projectId, name)).length > 0);
  const copied = await copyMediaToLibrary(result.result.url);
  t.after(() => rm(mediaFilePath('library', copied.split('/').pop()), { force: true }));
  assert.ok((await readMedia('library', copied.split('/').pop())).length > 0);
  const video = settings.comfy.video; video.workflowJson = JSON.stringify(graph); video.promptNodeId = '1'; video.referenceNodeId = '2'; video.durationNodeId = '3';
  const startedVideo = createMediaJob(settings, { projectId, kind: 'video', prompt: '镜头缓缓推进', source: result.result.url, duration: 7 });
  const videoResult = await finished(startedVideo.id);
  assert.equal(videoResult.status, 'completed', videoResult.error);
  assert.match(videoResult.result.url, /\.mp4$/);
  assert.equal((await readMedia(projectId, videoResult.result.url.split('/').pop())).toString(), 'mock-video');
  await discardMediaJobResult(startedVideo.id);
  await assert.rejects(readMedia(projectId, videoResult.result.url.split('/').pop()));
});
