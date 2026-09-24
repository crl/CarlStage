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
  settings.comfy.workflowJson = JSON.stringify({ '6': { class_type: 'CLIPTextEncode', inputs: { text: '测试' } }, '3': { class_type: 'KSampler', inputs: { seed: 1 } } });
  settings.comfy.promptNodeId = '6';
  settings.comfy.seedNodeId = '3';
  assert.equal(validateWorkflow(settings.comfy.workflowJson, '6', 'text').nodeCount, 2);
  assert.equal(normalizeSettings(settings).comfy.baseUrl, 'http://127.0.0.1:8188');
  assert.throws(() => normalizeSettings({ ...settings, comfy: { ...settings.comfy, seedNodeId: '99' } }), /种子节点/);
  assert.throws(() => normalizeSettings({ ...settings, codex: { ...settings.codex, timeoutMinutes: 0 } }), /超时/);
  assert.throws(() => validateWorkflow('{"nodes": []}', '', 'text'), /API 格式/);
});
