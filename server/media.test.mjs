import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { rm } from 'node:fs/promises';
import sharp from 'sharp';
import { defaultSettings } from './settings.mjs';
import { buildMediaWorkflow, copyMediaToLibrary, createMediaJob, cancelMediaJob, cancelProjectMediaJobs, discardMediaJobResult, getMediaJob, mediaFilePath, readMedia, removeProjectMedia } from './media.mjs';

const graph = { '1': { class_type: 'Text', inputs: { text: '' } }, '2': { class_type: 'LoadImage', inputs: { image: '' } }, '3': { class_type: 'SaveImage', inputs: { duration: 5 } } };
const pixel = `data:image/png;base64,${await sharp({ create: { width: 16, height: 9, channels: 3, background: '#777777' } }).png().toBuffer().then(bytes => bytes.toString('base64'))}`;
const imageSlots = inputs => Object.fromEntries(Object.entries(inputs).filter(([key]) => key.startsWith('images.image_')).map(([key, value]) => [key.slice('images.'.length), value]));
const finished = async id => { for (let i = 0; i < 100; i++) { const job = getMediaJob(id); if (['completed', 'failed'].includes(job.status)) return job; await new Promise(resolve => setTimeout(resolve, 30)); } throw new Error('任务未完成'); };
const until = async (id, predicate) => { for (let i = 0; i < 100; i++) { const job = getMediaJob(id); if (predicate(job)) return job; await new Promise(resolve => setTimeout(resolve, 20)); } throw new Error('任务状态未按预期变化'); };

test('分镜多参考生成保持编号并通过尺寸开关选择项目比例 latent', () => {
  const config = defaultSettings().comfy.imageEdit;
  for (const ratio of ['16:9', '9:16']) {
    const output = buildMediaWorkflow(config, 'imageEdit', { imageMode: 'compose', ratio, prompt: '@参考图1人物与@参考图2鞋、@参考图3门' }, 'person.png', ['shoe.png', 'door.png']);
    const images = imageSlots(output[config.promptNodeId].inputs);
    assert.equal(output[images.image_1[0]].inputs.image, 'person.png');
    assert.equal(output[images.image_2[0]].inputs.image, 'shoe.png');
    assert.equal(output[images.image_3[0]].inputs.image, 'door.png');
    assert.equal(images.image_4, undefined);
    assert.match(output[config.promptNodeId].inputs.prompt, /第1张参考图中的人物与第2张参考图中的鞋、第3张参考图中的门/);
    const samplerId = Object.keys(output).find(id => output[id].class_type === 'KSampler');
    const switchNode = output[output[samplerId].inputs.latent_image[0]];
    assert.equal(switchNode.class_type, 'ComfySwitchNode');
    assert.equal(switchNode.inputs.switch, true);
    const latent = output[switchNode.inputs.on_true[0]];
    assert.equal(latent.class_type, 'EmptyLatentImage');
    assert.equal(output[config.promptNodeId].inputs.resolution, Math.max(latent.inputs.width, latent.inputs.height));
    assert.equal(typeof latent.inputs.width, 'number');
    assert.equal(typeof latent.inputs.height, 'number');
    assert.ok(Math.abs(latent.inputs.width / latent.inputs.height - (ratio === '16:9' ? 16 / 9 : 9 / 16)) < 0.01);
    const selector = Object.values(output).find(node => node.class_type === 'ResolutionSelector');
    assert.equal(selector.inputs.aspect_ratio, ratio === '16:9' ? '16:9 (Widescreen)' : '9:16 (Portrait Widescreen)');
  }
});

test('图片与视频工作流只覆盖已映射的输入', () => {
  const settings = defaultSettings(); const image = settings.comfy.image;
  image.workflowJson = JSON.stringify(graph); image.promptNodeId = '1'; image.promptInput = 'text'; image.referenceNodeId = '2'; image.seedNodeId = ''; image.stepsNodeId = ''; image.cfgNodeId = ''; image.widthNodeId = ''; image.heightNodeId = '';
  const output = buildMediaWorkflow(image, 'image', { prompt: '人物肖像' }, 'file.png');
  assert.equal(output['1'].inputs.text, '人物肖像'); assert.equal(output['2'].inputs.image, 'file.png'); assert.equal(graph['1'].inputs.text, '');
  assert.throws(() => buildMediaWorkflow({ ...image, referenceNodeId: '' }, 'image', { prompt: '测试' }, 'file.png'), /参考图/);
});

test('图片工作流按项目画幅写入宽高与 Qwen 构图提示', () => {
  const config = defaultSettings().comfy.image;
  config.workflowJson = JSON.stringify({
    '1': { class_type: 'TextEncodeQwenImage21', inputs: { prompt: 'portrait', resolution: 768, images: {} } },
    '2': { class_type: 'EmptySD3LatentImage', inputs: { width: 768, height: 432 } }
  });
  config.promptNodeId = '1'; config.promptInput = 'prompt'; config.widthNodeId = '1'; config.widthInput = 'resolution'; config.heightNodeId = ''; config.seedNodeId = ''; config.stepsNodeId = ''; config.cfgNodeId = '';
  const portrait = buildMediaWorkflow(config, 'image', { prompt: '角色立绘', ratio: '9:16' });
  const landscape = buildMediaWorkflow(config, 'image', { prompt: '河岸全景', ratio: '16:9' });
  assert.deepEqual([portrait['2'].inputs.width, portrait['2'].inputs.height], [432, 768]);
  assert.deepEqual([landscape['2'].inputs.width, landscape['2'].inputs.height], [768, 432]);
  assert.match(portrait['1'].inputs.prompt, /9:16 画幅构图/);
  assert.match(landscape['1'].inputs.prompt, /16:9 画幅构图/);
});

test('Qwen 文生图和参考图编辑将反向提示词写入独立 negative_prompt 输入', () => {
  const settings = defaultSettings();
  for (const kind of ['image', 'imageEdit']) {
    const config = settings.comfy[kind];
    const graph = buildMediaWorkflow(config, kind, { prompt: '正向画面', negativePrompt: '不要文字，不要水印', ratio: '16:9', imageMode: kind === 'imageEdit' ? 'edit' : undefined }, kind === 'imageEdit' ? 'reference.png' : undefined);
    const node = graph[config.promptNodeId];
    assert.match(node.inputs.prompt, /正向画面/);
    assert.doesNotMatch(node.inputs.prompt, /不要文字|不要水印/);
    assert.equal(node.inputs.negative_prompt, '不要文字，不要水印');
  }
});

test('Qwen 工作流缺少 negative_prompt 输入时拒绝提交非空反向提示词', () => {
  const image = defaultSettings().comfy.image;
  image.workflowJson = JSON.stringify({ '1': { class_type: 'Text', inputs: { text: '' } } });
  image.promptNodeId = '1'; image.promptInput = 'text'; image.referenceNodeId = ''; image.seedNodeId = ''; image.stepsNodeId = ''; image.cfgNodeId = ''; image.widthNodeId = ''; image.heightNodeId = '';
  assert.throws(() => buildMediaWorkflow(image, 'image', { prompt: '正向画面', negativePrompt: '不要水印' }), /不支持 negative_prompt 输入/);
});

test('默认 Qwen 文生图和参考图编辑工作流将项目画幅写入真实 latent', () => {
  const settings = defaultSettings();
  for (const kind of ['image', 'imageEdit']) {
    const config = settings.comfy[kind];
    const graph = buildMediaWorkflow(config, kind, { prompt: '生成画面', ratio: '16:9', imageMode: kind === 'imageEdit' ? 'compose' : undefined }, kind === 'imageEdit' ? 'ref.png' : undefined);
    if (kind === 'image') {
      assert.deepEqual(graph['6'].inputs.latent_image, ['9', 0]);
      assert.deepEqual([graph['9'].inputs.width, graph['9'].inputs.height], [768, 432]);
      assert.equal(graph['9'].inputs.batch_size, 1);
    } else {
      const samplerId = config.stepsNodeId;
      const promptId = config.promptNodeId;
      const switchId = graph[samplerId].inputs.latent_image[0];
      const switchNode = graph[switchId];
      assert.equal(switchNode.class_type, 'ComfySwitchNode');
      assert.equal(switchNode.inputs.switch, true);
      assert.deepEqual(switchNode.inputs.on_false, [promptId, 2]);
      const latent = graph[switchNode.inputs.on_true[0]];
      assert.deepEqual([latent.inputs.width, latent.inputs.height], [1280, 720]);
      assert.equal(graph[promptId].inputs.resolution, 1280);
      const selector = Object.values(graph).find(node => node.class_type === 'ResolutionSelector');
      assert.equal(selector.inputs.aspect_ratio, '16:9 (Widescreen)');
    }
    if (kind === 'imageEdit') {
      assert.equal(graph[config.referenceNodeId].inputs.image, 'ref.png');
      assert.deepEqual(imageSlots(graph[config.promptNodeId].inputs).image_1, [config.referenceNodeId, 0]);
      assert.match(graph[config.promptNodeId].inputs.prompt, /生成画面/);
    }
    const portrait = buildMediaWorkflow(config, kind, { prompt: '生成画面', ratio: '9:16', imageMode: kind === 'imageEdit' ? 'compose' : undefined }, kind === 'imageEdit' ? 'ref.png' : undefined);
    if (kind === 'image') assert.deepEqual([portrait['9'].inputs.width, portrait['9'].inputs.height], [432, 768]);
    else {
      const samplerId = config.stepsNodeId;
      const switchId = portrait[samplerId].inputs.latent_image[0];
      const latent = portrait[portrait[switchId].inputs.on_true[0]];
      assert.deepEqual([latent.inputs.width, latent.inputs.height], [720, 1280]);
      const selector = Object.values(portrait).find(node => node.class_type === 'ResolutionSelector');
      assert.equal(selector.inputs.aspect_ratio, '9:16 (Portrait Widescreen)');
    }
  }
});

test('Qwen 编辑工作流将多张参考图分别绑定为 image 标记', () => {
  const config = defaultSettings().comfy.imageEdit;
  const workflow = buildMediaWorkflow(config, 'imageEdit', { prompt: '人物参考 <image1>，场景参考 <image2>', ratio: '16:9' }, 'first.png', ['second.png', 'third.png']);
  assert.equal(workflow[config.referenceNodeId].inputs.image, 'first.png');
  const images = imageSlots(workflow[config.promptNodeId].inputs);
  assert.deepEqual(images.image_1, [config.referenceNodeId, 0]);
  assert.equal(workflow[images.image_2[0]].inputs.image, 'second.png');
  assert.equal(workflow[images.image_3[0]].inputs.image, 'third.png');
  assert.match(workflow[config.promptNodeId].inputs.prompt, /<image1>、<image2>、<image3>/);
  assert.match(workflow[config.promptNodeId].inputs.prompt, /场景参考 <image2>/);
});

test('MiniMax H3 视频尺寸跟随项目画面比例', () => {
  const video = defaultSettings().comfy.video;
  const portrait = buildMediaWorkflow(video, 'video', { prompt: '镜头缓缓推进', duration: 3, ratio: '9:16' }, 'frame.png');
  const landscape = buildMediaWorkflow(video, 'video', { prompt: '镜头缓缓推进', duration: 3, ratio: '16:9' }, 'frame.png');
  assert.deepEqual([portrait['5'].inputs.width, portrait['5'].inputs.height], [288, 512]);
  assert.deepEqual([landscape['5'].inputs.width, landscape['5'].inputs.height], [512, 288]);
});

test('MiniMax H3 视频请求不受误带的生图模式字段拦截', () => {
  const settings = defaultSettings();
  settings.comfy.video.workflowJson = '{invalid';
  assert.throws(() => createMediaJob(settings, { projectId: 'videomodecheck', kind: 'video', prompt: '镜头推进', source: pixel, duration: 3, imageMode: 'edit' }), /工作流 JSON 格式不正确/);
});

test('分段视频逐图写入图片和递增切点，缺少映射时拒绝提交', () => {
  const settings = defaultSettings();
  settings.comfy.video.workflowJson = JSON.stringify({
    '1': { class_type: 'Text', inputs: { text: '' } },
    '2': { class_type: 'LoadImage', inputs: { image: '' } },
    '3': { class_type: 'Duration', inputs: { seconds: 5 } },
    '4': { class_type: 'LoadImage', inputs: { image: '' } },
    '5': { class_type: 'Cut', inputs: { seconds: 0 } }
  });
  settings.comfy.video.promptNodeId = '1'; settings.comfy.video.promptInput = 'text';
  settings.comfy.video.referenceNodeId = '2'; settings.comfy.video.durationNodeId = '3'; settings.comfy.video.durationInput = 'seconds'; settings.comfy.video.seedNodeId = '';
  settings.comfy.video.referenceSlots = [{ imageNodeId: '4', imageInput: 'image', timeNodeId: '5', timeInput: 'seconds' }];
  const graph = buildMediaWorkflow(settings.comfy.video, 'video', { prompt: '两镜', duration: 7, cutPoints: [0, 3] }, 'first.png', ['second.png']);
  assert.equal(graph['2'].inputs.image, 'first.png'); assert.equal(graph['4'].inputs.image, 'second.png'); assert.equal(graph['5'].inputs.seconds, 3);
  const input = { projectId: 'testmedia123', kind: 'video', prompt: '两镜', source: pixel, sources: [pixel, pixel], duration: 7 };
  assert.throws(() => createMediaJob(settings, { ...input, cutPoints: [0, 0] }), /严格递增/);
  assert.throws(() => createMediaJob({ ...settings, comfy: { ...settings.comfy, video: { ...settings.comfy.video, referenceSlots: [] } } }, { ...input, cutPoints: [0, 3] }), /多图/);
});

test('生图参考图数量、格式和引用顺序校验', () => {
  const settings = defaultSettings(); settings.imageProvider = 'gpt';
  const base = { projectId: 'testmedia123', kind: 'image', prompt: '测试', provider: 'gpt' };
  assert.throws(() => createMediaJob(settings, { ...base, sources: Array(5).fill(pixel) }), /最多选择 4 张/);
  assert.throws(() => createMediaJob(settings, { ...base, sources: ['https://example.com/image.png'] }), /参考图无效/);
  assert.throws(() => createMediaJob(settings, { ...base, sources: [pixel, pixel], provider: 'qwen' }), /引用顺序/);
});

test('模拟 ComfyUI 完成图片和首帧视频任务并保存文件', async t => {
  let currentKind = 'image';
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/upload/image') { for await (const _ of req) { /* consume multipart */ } res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ name: 'uploaded.png' })); return; }
    if (url.pathname === '/prompt') { const chunks = []; for await (const chunk of req) chunks.push(chunk); currentKind = JSON.parse(Buffer.concat(chunks).toString()).prompt['3'].inputs.duration === 7 ? 'video' : 'image'; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ prompt_id: 'mock-task' })); return; }
    if (url.pathname.startsWith('/history/')) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ 'mock-task': { outputs: { '3': { images: [{ filename: currentKind === 'video' ? 'generated.mp4' : 'generated.png', subfolder: '', type: 'output' }] } } } })); return; }
    if (url.pathname === '/view') { res.setHeader('content-type', currentKind === 'video' ? 'video/mp4' : 'image/png'); res.end(currentKind === 'video' ? Buffer.from('mock-video') : Buffer.from(pixel.split(',')[1], 'base64')); return; }
    res.writeHead(404); res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const settings = defaultSettings(); settings.comfy.baseUrl = `http://127.0.0.1:${server.address().port}`;
  const image = settings.comfy.image; image.workflowJson = JSON.stringify(graph); image.promptNodeId = '1'; image.promptInput = 'text'; image.referenceNodeId = '2'; image.seedNodeId = ''; image.stepsNodeId = ''; image.cfgNodeId = ''; image.widthNodeId = ''; image.heightNodeId = '';
  const projectId = 'testmedia123';
  t.after(async () => { await removeProjectMedia(projectId); });
  const started = createMediaJob(settings, { projectId, kind: 'image', prompt: '人物肖像', source: pixel });
  const result = await finished(started.id);
  assert.equal(result.status, 'completed', result.error);
  const landscapeSize = await sharp(await readMedia(projectId, result.result.url.split('/').pop())).metadata();
  assert.equal(landscapeSize.width, 1536);
  assert.equal(landscapeSize.height, 864);
  assert.match(result.result.url, /^\/api\/media\/testmedia123\//);
  const name = result.result.url.split('/').pop(); assert.ok((await readMedia(projectId, name)).length > 0);
  const copied = await copyMediaToLibrary(result.result.url);
  t.after(() => rm(mediaFilePath('library', copied.split('/').pop()), { force: true }));
  assert.ok((await readMedia('library', copied.split('/').pop())).length > 0);
  const multiple = createMediaJob(settings, { projectId, kind: 'image', prompt: '组合肖像', sources: [pixel, pixel], source: pixel });
  const multipleResult = await finished(multiple.id);
  assert.equal(multipleResult.status, 'completed', multipleResult.error);
  assert.equal(multiple.sources, undefined);
  const portrait = createMediaJob(settings, { projectId, kind: 'image', prompt: '竖版角色', ratio: '9:16' });
  const portraitResult = await finished(portrait.id);
  assert.equal(portraitResult.status, 'completed', portraitResult.error);
  const portraitSize = await sharp(await readMedia(projectId, portraitResult.result.url.split('/').pop())).metadata();
  assert.ok(Math.abs(portraitSize.width / portraitSize.height - 9 / 16) < 0.01);
  const video = settings.comfy.video; video.workflowJson = JSON.stringify(graph); video.promptNodeId = '1'; video.promptInput = 'text'; video.referenceNodeId = '2'; video.durationNodeId = '3'; video.durationInput = 'duration'; video.seedNodeId = '';
  const startedVideo = createMediaJob(settings, { projectId, kind: 'video', prompt: '镜头缓缓推进', source: result.result.url, duration: 7 });
  const videoResult = await finished(startedVideo.id);
  assert.equal(videoResult.status, 'completed', videoResult.error);
  assert.match(videoResult.result.url, /\.mp4$/);
  assert.equal((await readMedia(projectId, videoResult.result.url.split('/').pop())).toString(), 'mock-video');
  await discardMediaJobResult(startedVideo.id);
  await assert.rejects(readMedia(projectId, videoResult.result.url.split('/').pop()));
});

test('生图和生视频共用队列，排位更新且取消后不保存结果', async t => {
  const interrupted = [];
  const submitted = [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/upload/image') { for await (const _ of req) { /* consume upload */ } res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ name: 'reference.png' })); return; }
    if (url.pathname === '/prompt') {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const name = JSON.parse(Buffer.concat(chunks).toString()).prompt['1'].inputs.text;
      submitted.push(name);
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ prompt_id: name })); return;
    }
    if (url.pathname === '/queue' || url.pathname === '/interrupt') {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      if (url.pathname === '/interrupt') interrupted.push(JSON.parse(Buffer.concat(chunks).toString()).prompt_id);
      res.end(); return;
    }
    if (url.pathname.startsWith('/history/')) {
      const name = decodeURIComponent(url.pathname.split('/').pop());
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(name === 'first' ? {} : { [name]: { outputs: { '3': { images: [{ filename: name === 'video-final' ? 'generated.mp4' : 'generated.png' }] } } } })); return;
    }
    if (url.pathname === '/view') { const video = url.searchParams.get('filename')?.endsWith('.mp4'); res.setHeader('content-type', video ? 'video/mp4' : 'image/png'); res.end(video ? Buffer.from('mock-video') : Buffer.from(pixel.split(',')[1], 'base64')); return; }
    res.writeHead(404); res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const settings = defaultSettings(); settings.comfy.baseUrl = `http://127.0.0.1:${server.address().port}`;
  for (const kind of ['image', 'video']) { const config = settings.comfy[kind]; config.workflowJson = JSON.stringify(graph); config.promptNodeId = '1'; config.promptInput = 'text'; config.referenceNodeId = '2'; config.seedNodeId = ''; }
  for (const key of ['width', 'height', 'steps', 'cfg']) settings.comfy.image[`${key}NodeId`] = '';
  settings.comfy.video.durationNodeId = '3'; settings.comfy.video.durationInput = 'duration';
  const projectId = 'queueproject';
  t.after(async () => { await removeProjectMedia(projectId); });
  const first = createMediaJob(settings, { projectId, kind: 'image', prompt: 'first' });
  await until(first.id, job => job.status === 'running' && !!job.promptId);
  const second = createMediaJob(settings, { projectId, kind: 'video', prompt: 'second', source: pixel, duration: 4 });
  const third = createMediaJob(settings, { projectId, kind: 'image', prompt: 'third' });
  assert.equal(getMediaJob(second.id).queuePosition, 1);
  assert.equal(getMediaJob(third.id).queuePosition, 2);
  assert.equal((await cancelMediaJob(second.id)).status, 'cancelled');
  assert.equal(getMediaJob(third.id).queuePosition, 1);
  const fourth = createMediaJob(settings, { projectId, kind: 'video', prompt: 'video-final', source: pixel, duration: 4 });
  assert.equal(getMediaJob(fourth.id).queuePosition, 2);
  const removed = createMediaJob(settings, { projectId: 'queueddelete', kind: 'image', prompt: 'removed' });
  await cancelProjectMediaJobs('queueddelete');
  assert.equal(getMediaJob(removed.id).status, 'cancelled');
  assert.equal((await cancelMediaJob(first.id)).status, 'cancelled');
  assert.deepEqual(interrupted, ['first']);
  assert.equal(getMediaJob(first.id).result, undefined);
  assert.equal((await finished(third.id)).status, 'completed');
  assert.equal((await finished(fourth.id)).status, 'completed');
  assert.deepEqual(submitted, ['first', 'third', 'video-final']);
  assert.equal(getMediaJob(removed.id).result, undefined);
  const deleting = createMediaJob(settings, { projectId: 'activedelete', kind: 'image', prompt: 'first' });
  await until(deleting.id, job => job.status === 'running' && !!job.promptId);
  await cancelProjectMediaJobs('activedelete');
  assert.equal(getMediaJob(deleting.id).status, 'cancelled');
  assert.equal(getMediaJob(deleting.id).result, undefined);
  t.after(async () => { await removeProjectMedia('activedelete'); });
});

test('取消后才返回的媒体文件不会保存', async t => {
  let viewing = false;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/prompt') { for await (const _ of req) { /* consume prompt */ } res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ prompt_id: 'late-result' })); return; }
    if (url.pathname === '/history/late-result') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ 'late-result': { outputs: { '3': { images: [{ filename: 'late.png' }] } } } })); return; }
    if (url.pathname === '/view') { viewing = true; await new Promise(resolve => setTimeout(resolve, 80)); res.setHeader('content-type', 'image/png'); res.end(Buffer.from(pixel.split(',')[1], 'base64')); return; }
    if (url.pathname === '/queue' || url.pathname === '/interrupt') { for await (const _ of req) { /* consume cancellation */ } res.end(); return; }
    res.writeHead(404); res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const settings = defaultSettings(); settings.comfy.baseUrl = `http://127.0.0.1:${server.address().port}`;
  const image = settings.comfy.image; image.workflowJson = JSON.stringify(graph); image.promptNodeId = '1'; image.promptInput = 'text'; image.seedNodeId = '';
  for (const key of ['width', 'height', 'steps', 'cfg']) image[`${key}NodeId`] = '';
  const projectId = 'lateresult'; t.after(async () => { await removeProjectMedia(projectId); });
  const job = createMediaJob(settings, { projectId, kind: 'image', prompt: 'late' });
  await until(job.id, () => viewing);
  assert.equal((await cancelMediaJob(job.id)).status, 'cancelled');
  assert.equal(getMediaJob(job.id).result, undefined);
});
