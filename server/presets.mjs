// API-format graphs based on the Comfy-Org Qwen-Image-2.1 and MiniMax H3 templates.
// Model names match the compact official releases; users can still import their own graphs.
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

const imageEdit = {
  ...qwenBase,
  '6': node('KSampler', { model: link(4), seed: 1, steps: 25, cfg: 1, sampler_name: 'euler', scheduler: 'simple', positive: link(5), negative: link(5, 1), latent_image: link(5, 2), denoise: 1 }),
  '5': node('TextEncodeQwenImage21', { clip: link(2), prompt: '保持参考图主体，生成电影感画面', negative_prompt: '', resolution: 768, images: { image_1: link(9) }, vae: link(3) }),
  '9': node('LoadImage', { image: 'reference.png' })
};

const video = {
  '1': node('UNETLoader', { unet_name: 'minimax_h3_fl2va_pruned_int8_convrot.safetensors', weight_dtype: 'default' }),
  '2': node('CLIPLoader', { clip_name: 'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors', type: 'minimax', device: 'default' }),
  '3': node('VAELoader', { vae_name: 'minimax_h3_video_vae_fp16.safetensors' }),
  '4': node('LoadImage', { image: 'first-frame.png' }),
  '5': node('MiniMaxH3ImageToVideo', { clip: link(2), vae: link(3), prompt: '镜头缓缓推进', width: 512, height: 288, length: 121, first_frame: link(4) }),
  '6': node('KSampler', { model: link(1), seed: 1, steps: 25, cfg: 1, sampler_name: 'res_multistep', scheduler: 'simple', positive: link(5), negative: link(7), latent_image: link(5, 1), denoise: 1 }),
  '7': node('ConditioningZeroOut', { conditioning: link(5) }),
  '8': node('VAEDecode', { samples: link(6), vae: link(3) }),
  '9': node('CreateVideo', { images: link(8), fps: 24 }),
  '10': node('SaveVideo', { video: link(9), filename_prefix: 'CarlStage/H3', format: 'auto', codec: 'auto' })
};

export const PRESETS = {
  image: { workflowJson: JSON.stringify(image, null, 2), promptNodeId: '5', promptInput: 'prompt', referenceNodeId: '', referenceInput: 'image', seedNodeId: '6', seedInput: 'seed', widthNodeId: '9', widthInput: 'width', heightNodeId: '9', heightInput: 'height', stepsNodeId: '6', stepsInput: 'steps', cfgNodeId: '6', cfgInput: 'cfg', width: 768, height: 432, steps: 25, cfg: 1, seed: -1 },
  imageEdit: { workflowJson: JSON.stringify(imageEdit, null, 2), promptNodeId: '5', promptInput: 'prompt', referenceNodeId: '9', referenceInput: 'image', seedNodeId: '6', seedInput: 'seed', widthNodeId: '', widthInput: 'width', heightNodeId: '', heightInput: 'height', stepsNodeId: '6', stepsInput: 'steps', cfgNodeId: '6', cfgInput: 'cfg', width: 768, height: 432, steps: 25, cfg: 1, seed: -1 },
  video: { workflowJson: JSON.stringify(video, null, 2), promptNodeId: '5', promptInput: 'prompt', referenceNodeId: '4', referenceInput: 'image', durationNodeId: '5', durationInput: 'length', seedNodeId: '6', seedInput: 'seed', duration: 5, seed: -1, referenceSlots: [] }
};
