import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { readMedia, removeMediaUrl, uploadLibraryMedia } from './media.mjs';

test('全局资产库上传图片与视频，并拒绝无效文件', async () => {
  const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001', 'hex');
  const imageUrl = await uploadLibraryMedia(Readable.from([png]), 'image');
  assert.match(imageUrl, /^\/api\/media\/library\/[a-f0-9-]{36}\.png$/);
  assert.deepEqual(await readMedia('library', imageUrl.split('/').pop()), png);
  await removeMediaUrl(imageUrl);

  const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(24)]);
  const videoUrl = await uploadLibraryMedia(Readable.from([mp4]), 'video');
  assert.match(videoUrl, /\.mp4$/);
  await removeMediaUrl(videoUrl);

  await assert.rejects(uploadLibraryMedia(Readable.from([Buffer.from('not media')]), 'image'), /只支持 PNG/);
});
