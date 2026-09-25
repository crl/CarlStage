import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultSettings, publicSettings } from './settings.mjs';
import { generateGptImage } from './gpt-image.mjs';

const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/R9sAAAAASUVORK5CYII=', 'base64');
const fakeResponse = (status, value) => ({ ok: status < 400, status, json: async () => value });

test('GPT Image 2.5 Key 不回传到页面，缺少 Key 时明确失败', async () => {
  const settings = defaultSettings();
  assert.equal(publicSettings(settings).gptImage.apiKey, undefined);
  await assert.rejects(generateGptImage(settings, '测试'), /API Key/);
  settings.gptImage.apiKey = 'test-secret';
  assert.equal(publicSettings(settings).gptImage.hasApiKey, true);
  assert.equal(publicSettings(settings).gptImage.apiKey, undefined);
});

test('GPT 文生图与参考图编辑使用不同端点并解析结果', async () => {
  const settings = defaultSettings(); settings.gptImage.apiKey = 'test-secret';
  const calls = [];
  const fetcher = async (url, options) => { calls.push({ url, options }); return fakeResponse(200, { data: [{ b64_json: pixel.toString('base64') }] }); };
  assert.deepEqual(await generateGptImage(settings, '猫', undefined, fetcher, undefined, '9:16'), pixel);
  assert.match(calls[0].url, /images\/generations$/);
  assert.equal(JSON.parse(calls[0].options.body).model, 'gpt-image-2.5-sunburst');
  assert.equal(JSON.parse(calls[0].options.body).size, '1024x1536');
  const reference = `data:image/png;base64,${pixel.toString('base64')}`;
  assert.deepEqual(await generateGptImage(settings, '修改背景', [reference], fetcher), pixel);
  assert.match(calls[1].url, /images\/edits$/);
  assert.equal(calls[1].options.body.get('model'), 'gpt-image-2.5-sunburst');
  assert.equal(calls[1].options.body.get('size'), '1536x1024');
  assert.equal(calls[1].options.body.getAll('image[]').length, 1);
  assert.deepEqual(await generateGptImage(settings, '组合画面', [reference, reference], fetcher), pixel);
  assert.equal(calls[2].options.body.getAll('image[]').length, 2);
});

test('GPT API 错误原样提示', async () => {
  const settings = defaultSettings(); settings.gptImage.apiKey = 'test-secret';
  await assert.rejects(generateGptImage(settings, '猫', undefined, async () => fakeResponse(403, { error: { message: 'model access denied' } })), /model access denied/);
});
