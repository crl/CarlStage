// API-format graphs based on the Comfy-Org Qwen-Image-2.1 and MiniMax H3 R2V templates.
// Model names match the compact official releases; users can still import their own graphs.
import { readFile } from 'node:fs/promises';
const node = (class_type, inputs) => ({ class_type, inputs });
const link = (id, output = 0) => [String(id), output];

const qwenBase = {
  '1': node('UNETLoader', { unet_name: 'qwen_image_2.1_int8_convrot.safetensors', weight_dtype: 'default' }),
  '2': node('CLIPLoader', { clip_name: 'qwen3vl_8b_int8_convrot.safetensors', type: 'qwen_image', device: 'default' }),
  '3': node('VAELoader', { vae_name: 'qwen_image_2.1_vae_bf16.safetensors' }),
  '4': node('QwenImage21Cache', { model: link(1), device: 'auto', dtype: 'default' }),
  '6': node('KSampler', { model: link(4), seed: 1, steps: 25, cfg: 1, sampler_name: 'euler', scheduler: 'simple', positive: link(5), negative: link(5, 1), latent_image: link(9), denoise: 1 }),
  '7': node('VAEDecode', { samples: link(6), vae: link(3) }),
  '8': node('SaveImage', { images: link(7), filename_prefix: 'CarlStage/Qwen' })
};

const image = {
  ...qwenBase,
  '5': node('TextEncodeQwenImage21', { clip: link(2), prompt: '电影感场景', negative_prompt: '', resolution: 768, images: {} }),
  '9': node('EmptySD3LatentImage', { width: 768, height: 432, batch_size: 1 })
};

const imageEdit = JSON.parse(await readFile(new URL('./workflows/image_qwen_image_2_1_image_edit.json', import.meta.url), 'utf8'));

const video = JSON.parse(await readFile(new URL('./workflows/video_minimax_h3_r2v.json', import.meta.url), 'utf8'));
const videoFirstLast = JSON.parse(await readFile(new URL('./workflows/video_minimax_h3_first_last.json', import.meta.url), 'utf8'));

export const PRESETS = {
  image: { workflowJson: JSON.stringify(image, null, 2), workflowFileName: '', promptNodeId: '5', promptInput: 'prompt', referenceNodeId: '', referenceInput: 'image', seedNodeId: '6', seedInput: 'seed', widthNodeId: '9', widthInput: 'width', heightNodeId: '9', heightInput: 'height', stepsNodeId: '6', stepsInput: 'steps', cfgNodeId: '6', cfgInput: 'cfg', width: 768, height: 432, steps: 25, cfg: 1, seed: -1 },
  imageEdit: { workflowJson: JSON.stringify(imageEdit, null, 2), workflowFileName: '', promptNodeId: '459:474', promptInput: 'prompt', referenceNodeId: '470', referenceInput: 'image', seedNodeId: '459:458', seedInput: 'seed', widthNodeId: '', widthInput: 'width', heightNodeId: '', heightInput: 'height', stepsNodeId: '459:458', stepsInput: 'steps', cfgNodeId: '459:458', cfgInput: 'cfg', width: 1376, height: 768, steps: 25, cfg: 1, seed: -1 },
  video: { workflowJson: JSON.stringify(video, null, 2), workflowFileName: '', promptNodeId: '138', promptInput: 'value', referenceNodeId: '137', referenceInput: 'image', durationNodeId: '136', durationInput: 'length', seedNodeId: '129', seedInput: 'noise_seed', duration: 5, seed: -1, referenceSlots: [] },
  videoFirstLast: { workflowJson: JSON.stringify(videoFirstLast, null, 2), workflowFileName: '', promptNodeId: '105:104', promptInput: 'prompt', referenceNodeId: '114', referenceInput: 'image', lastFrameNodeId: '127', lastFrameInput: 'image', durationNodeId: '105:104', durationInput: 'length', seedNodeId: '105:15', seedInput: 'noise_seed', duration: 5, seed: -1 }
};
