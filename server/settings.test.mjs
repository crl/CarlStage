import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultSettings, normalizeSettings, validateComfyUrl, validateWorkflow } from './settings.mjs';

test('ComfyUI 地址仅允许本机 HTTP', () => {
  assert.equal(validateComfyUrl('http://localhost:8188/'), 'http://localhost:8188');
  for (const url of ['https://example.com', 'http://192.168.1.2:8188', 'file:///etc/passwd', 'http://127.0.0.1:8188/admin']) {
    assert.throws(() => validateComfyUrl(url));
  }
});

test('设置校验 API 工作流节点与参数范围', () => {
  const settings = defaultSettings();
  settings.comfy.image.workflowJson = JSON.stringify({ '6': { class_type: 'CLIPTextEncode', inputs: { text: '测试' } }, '3': { class_type: 'KSampler', inputs: { seed: 1 } } });
  settings.comfy.image.promptNodeId = '6';
  settings.comfy.image.promptInput = 'text';
  settings.comfy.image.seedNodeId = '3';
  settings.comfy.image.stepsNodeId = '';
  settings.comfy.image.cfgNodeId = '';
  settings.comfy.image.widthNodeId = '';
  settings.comfy.image.heightNodeId = '';
  assert.equal(validateWorkflow(settings.comfy.image.workflowJson, '6', 'text').nodeCount, 2);
  assert.equal(normalizeSettings(settings).comfy.baseUrl, 'http://127.0.0.1:8188');
  assert.throws(() => normalizeSettings({ ...settings, comfy: { ...settings.comfy, image: { ...settings.comfy.image, seedNodeId: '99' } } }), /种子节点/);
  assert.throws(() => normalizeSettings({ ...settings, codex: { ...settings.codex, timeoutMinutes: 0 } }), /超时/);
  assert.throws(() => validateWorkflow('{"nodes": []}', '', 'text'), /API 格式/);
});

test('默认 MiniMax H3 工作流使用 R2V 并映射提示词、首图、时长和随机种子', () => {
  const video = defaultSettings().comfy.video;
  const graph = JSON.parse(video.workflowJson);
  assert.ok(Object.values(graph).some(node => node.class_type === 'MiniMaxH3ReferenceToVideo'));
  assert.deepEqual([video.promptNodeId, video.promptInput], ['138', 'value']);
  assert.deepEqual([video.referenceNodeId, video.referenceInput], ['137', 'image']);
  assert.deepEqual([video.durationNodeId, video.durationInput], ['136', 'length']);
  assert.deepEqual([video.seedNodeId, video.seedInput], ['129', 'noise_seed']);
  assert.deepEqual(video.referenceSlots, []);
  assert.doesNotThrow(() => normalizeSettings(defaultSettings()));
});

test('工作流文件名随设置保存，并兼容没有文件名的旧设置', () => {
  const settings = defaultSettings();
  settings.comfy.video.workflowFileName = 'custom-r2v.json';
  settings.comfy.videoFirstLast.workflowFileName = 'custom-first-last.json';
  const normalized = normalizeSettings(settings);
  assert.equal(normalized.comfy.video.workflowFileName, 'custom-r2v.json');
  assert.equal(normalized.comfy.videoFirstLast.workflowFileName, 'custom-first-last.json');
  delete settings.comfy.video.workflowFileName;
  assert.equal(normalizeSettings(settings).comfy.video.workflowFileName, '');
});

test('内置 MiniMax H3 首尾帧工作流作为逐镜默认配置，并迁移旧设置', () => {
  const defaults = defaultSettings();
  const workflow = defaults.comfy.videoFirstLast;
  const graph = JSON.parse(workflow.workflowJson);
  assert.ok(Object.values(graph).some(node => node.class_type === 'MiniMaxH3ImageToVideo' && node.inputs.first_frame && node.inputs.last_frame));
  assert.deepEqual([workflow.promptNodeId, workflow.promptInput], ['105:104', 'prompt']);
  assert.deepEqual([workflow.referenceNodeId, workflow.referenceInput], ['114', 'image']);
  assert.deepEqual([workflow.lastFrameNodeId, workflow.lastFrameInput], ['127', 'image']);
  assert.deepEqual([workflow.durationNodeId, workflow.durationInput], ['105:104', 'length']);
  assert.deepEqual([workflow.seedNodeId, workflow.seedInput], ['105:15', 'noise_seed']);
  assert.ok(normalizeSettings(defaults).comfy.videoFirstLast.workflowJson);
  const oldSettings = normalizeSettings({ ...defaults, comfy: { ...defaults.comfy, videoFirstLast: undefined } });
  assert.equal(oldSettings.comfy.videoFirstLast.workflowJson, workflow.workflowJson);
});

test('多图视频节点映射在保存设置时校验', () => {
  const settings = defaultSettings();
  const graph = JSON.parse(settings.comfy.video.workflowJson);
  graph['9'] = { class_type: 'LoadImage', inputs: { image: '' } };
  graph['10'] = { class_type: 'Cut', inputs: { seconds: 0 } };
  settings.comfy.video.workflowJson = JSON.stringify(graph);
  settings.comfy.video.referenceSlots = [{ imageNodeId: '9', imageInput: 'image', timeNodeId: '10', timeInput: 'seconds' }];
  assert.deepEqual(normalizeSettings(settings).comfy.video.referenceSlots, settings.comfy.video.referenceSlots);
  assert.throws(() => normalizeSettings({ ...settings, comfy: { ...settings.comfy, video: { ...settings.comfy.video, referenceSlots: [{ ...settings.comfy.video.referenceSlots[0], imageNodeId: 'missing' }] } } }), /图片节点/);
});

test('旧版 ComfyUI 平铺设置迁移到生图设置', () => {
  const defaults = defaultSettings();
  const migrated = normalizeSettings({ codex: defaults.codex, comfy: { baseUrl: defaults.comfy.baseUrl, workflowJson: '', promptNodeId: '12', promptInput: 'text', width: 768, height: 1024, steps: 30, cfg: 6, seed: 42 } });
  assert.equal(migrated.comfy.image.promptNodeId, '12');
  assert.equal(migrated.comfy.image.width, 768);
  assert.equal(migrated.comfy.video.duration, 5);
});

test('旧版内置 Qwen 方形 latent 工作流自动升级为项目画幅 latent', () => {
  const defaults = defaultSettings();
  const comfy = structuredClone(defaults.comfy);
  const imageGraph = JSON.parse(comfy.image.workflowJson);
  delete imageGraph['9']; imageGraph['6'].inputs.latent_image = ['5', 2];
  comfy.image.workflowJson = JSON.stringify(imageGraph);
  comfy.image.widthNodeId = '5'; comfy.image.widthInput = 'resolution'; comfy.image.heightNodeId = '';
  const oldEdit = {
    '1': { class_type: 'UNETLoader', inputs: { unet_name: 'qwen_image_2.1_int8_convrot.safetensors', weight_dtype: 'default' } },
    '2': { class_type: 'CLIPLoader', inputs: { clip_name: 'qwen3vl_8b_int8_convrot.safetensors', type: 'qwen_image', device: 'default' } },
    '3': { class_type: 'VAELoader', inputs: { vae_name: 'qwen_image_2.1_vae_bf16.safetensors' } },
    '4': { class_type: 'QwenImage21Cache', inputs: { model: ['1', 0], device: 'auto', dtype: 'default' } },
    '5': { class_type: 'TextEncodeQwenImage21', inputs: { clip: ['2', 0], prompt: 'portrait', negative_prompt: '', resolution: 768, images: { image_1: ['9', 0] }, vae: ['3', 0] } },
    '6': { class_type: 'KSampler', inputs: { model: ['4', 0], seed: 1, steps: 25, cfg: 1, sampler_name: 'euler', scheduler: 'simple', positive: ['5', 0], negative: ['5', 1], latent_image: ['10', 0], denoise: 1 } },
    '7': { class_type: 'VAEDecode', inputs: { samples: ['6', 0], vae: ['3', 0] } },
    '8': { class_type: 'SaveImage', inputs: { images: ['7', 0], filename_prefix: 'Qwen' } },
    '9': { class_type: 'LoadImage', inputs: { image: 'reference.png' } },
    '10': { class_type: 'EmptySD3LatentImage', inputs: { width: 1024, height: 1024, batch_size: 1 } }
  };
  comfy.imageEdit.workflowJson = JSON.stringify(oldEdit);
  Object.assign(comfy.imageEdit, { promptNodeId: '5', referenceNodeId: '9', seedNodeId: '6', stepsNodeId: '6', cfgNodeId: '6', widthNodeId: '5', widthInput: 'resolution', heightNodeId: '' });
  const migrated = normalizeSettings({ ...defaults, comfy });
  for (const kind of ['image', 'imageEdit']) {
    const graph = JSON.parse(migrated.comfy[kind].workflowJson);
    if (kind === 'image') {
      assert.equal(graph['6'].inputs.latent_image[0], '9');
      assert.equal(migrated.comfy[kind].widthNodeId, '9');
      assert.equal(migrated.comfy[kind].heightNodeId, '9');
    } else {
      assert.equal(graph['459:458'].inputs.latent_image[0], '459:468');
      assert.equal(graph['459:468'].class_type, 'ComfySwitchNode');
      assert.equal(graph['459:456'].inputs.width[0], '13');
      assert.equal(graph['13'].inputs.aspect_ratio, '16:9 (Widescreen)');
      assert.equal(migrated.comfy[kind].widthNodeId, '');
      assert.equal(migrated.comfy[kind].heightNodeId, '');
    }
  }
});

test('创作模型设置默认 Codex 并允许本机 Ollama', () => {
  const defaults = defaultSettings();
  assert.equal(defaults.codex.provider, 'codex');
  assert.equal(defaults.codex.ollamaModel, 'gemma4:latest');
  assert.equal(normalizeSettings({ ...defaults, codex: { ...defaults.codex, provider: 'ollama' } }).codex.provider, 'ollama');
  assert.throws(() => normalizeSettings({ ...defaults, codex: { ...defaults.codex, provider: 'remote' } }), /模型服务/);
});

test('Codex 执行文件路径可配置且必须为绝对路径', () => {
  const defaults = defaultSettings();
  assert.equal(defaults.codex.executablePath, '');
  const path = process.platform === 'win32' ? 'C:\\Tools\\codex.exe' : '/opt/codex';
  assert.equal(normalizeSettings({ ...defaults, codex: { ...defaults.codex, executablePath: path } }).codex.executablePath, path);
  assert.throws(() => normalizeSettings({ ...defaults, codex: { ...defaults.codex, executablePath: 'codex.exe' } }), /绝对路径/);
});
