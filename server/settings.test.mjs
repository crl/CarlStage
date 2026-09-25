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
  settings.comfy.image.seedNodeId = '3';
  assert.equal(validateWorkflow(settings.comfy.image.workflowJson, '6', 'text').nodeCount, 2);
  assert.equal(normalizeSettings(settings).comfy.baseUrl, 'http://127.0.0.1:8188');
  assert.throws(() => normalizeSettings({ ...settings, comfy: { ...settings.comfy, image: { ...settings.comfy.image, seedNodeId: '99' } } }), /种子节点/);
  assert.throws(() => normalizeSettings({ ...settings, codex: { ...settings.codex, timeoutMinutes: 0 } }), /超时/);
  assert.throws(() => validateWorkflow('{"nodes": []}', '', 'text'), /API 格式/);
});

test('旧版 ComfyUI 平铺设置迁移到生图设置', () => {
  const defaults = defaultSettings();
  const migrated = normalizeSettings({ codex: defaults.codex, comfy: { baseUrl: defaults.comfy.baseUrl, workflowJson: '', promptNodeId: '12', promptInput: 'text', width: 768, height: 1024, steps: 30, cfg: 6, seed: 42 } });
  assert.equal(migrated.comfy.image.promptNodeId, '12');
  assert.equal(migrated.comfy.image.width, 768);
  assert.equal(migrated.comfy.video.duration, 5);
});
