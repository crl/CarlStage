export type ProjectKind = 'idea' | 'novel';
export type AssetType = 'character' | 'scene' | 'prop' | 'other';
export type DocKey = 'outline' | 'script' | 'cast' | 'art' | 'storyboard';
export type Asset = { id: string; type: AssetType; name: string; description: string; prompt?: string; mediaKind?: 'image' | 'video'; image?: string; video?: string; sourceProjectId?: string; sourceItemId?: string; generatedAt?: number; provider?: string };
export type ImageRatio = '1:1' | '9:16' | '16:9' | '3:4' | '4:3' | '3:2' | '2:3' | '4:5' | '5:4' | '21:9';
export const IMAGE_RATIOS: ImageRatio[] = ['1:1', '9:16', '16:9', '3:4', '4:3', '3:2', '2:3', '4:5', '5:4', '21:9'];
export type Outline = {
  core: string; retain: string[]; cut: string[]; merge: string[]; risks: string[];
  retainDetails?: { what: string; why: string; evidence: string }[];
  cutDetails?: { what: string; why: string; evidence?: string }[];
  mergeDetails?: { what: string; why: string }[];
  riskDetails?: { what: string; plan: string }[];
  cutNote?: string;
  episodes: { title: string; summary: string; hook: string; suspense?: string; crowdPlan?: string; warnings?: string[]; sceneIds?: string[]; characterIds?: string[]; propIds?: string[] }[];
  beats?: { id: string; type: string; weight?: string; episode: number; setup: string; payoff: string }[];
  characters?: { id: string; name: string; role: string; tier?: string; arc: string; source: string }[];
  scenes?: { id: string; name: string; primary: boolean; reusePlan?: string }[];
  sceneRefsHydrated?: boolean;
  characterInfoHydrated?: boolean;
  inventoryDataHydrated?: boolean;
  props?: { id: string; name: string; function: string; beatIds: string[] }[];
};
export type ScriptBeat = { action?: string; speaker?: string; line?: string; delivery?: string; seconds?: number };
export type Script = { episodes: { title: string; duration: number; hook: string; ending: string; beatsClaimed?: string[]; scenes: { title: string; location: string; description: string; beats: string[]; sceneId?: string; lighting?: string; characters?: string[]; props?: string[]; flow?: ScriptBeat[] }[] }[] };
export type Character = { id: string; name: string; role: string; description: string; arc: string; image?: string; turnaroundImage?: string; states?: { id?: string; state: string; prompt: string; image?: string; added?: boolean }[]; aliases?: string[]; persona?: { gender?: string; ageRange?: string; identity?: string; appearance?: string; temperament?: string; motivation?: string; personality?: string[]; relations?: unknown; relationships?: { name?: string; relation?: string }[]; evidence?: string[] }; imagePrompt?: string; imagePromptLocal?: string; imageSheetPrompt?: string; imageSheetPromptLocal?: string; imageNegativePrompt?: string; imageTags?: string[]; imageStyle?: string; voice?: Record<string, string> };
export type ArtAsset = Asset & { primary?: boolean; anchors?: { name: string; desc: string }[]; states?: { id?: string; state: string; prompt: string; image?: string; added?: boolean }[]; scale?: string; prompt?: string; negativePrompt?: string; settingImage?: string; settingPrompt?: string };
export type Art = { scenes: ArtAsset[]; props: ArtAsset[]; style: string };
export type Shot = { id: string; scene: string; sceneId?: string | null; framing: string; action: string; duration: number; image?: string; video?: string; episode?: number; segmentId?: string; camera?: string; lens?: string; cameraPosition?: string; composition?: string; eyeline?: string; focus?: string; stability?: string; characters?: string[]; props?: string[]; beats?: number[]; videoPrompt?: string };
export type SegmentVideo = { id: string; url: string; createdAt: number; prompt: string };
export type Storyboard = { shots: Shot[]; segments?: { episode: number; id: string; videos: SegmentVideo[]; activeVideoId?: string }[] };
export type Docs = { outline: Outline; script: Script; cast: Character[]; art: Art; storyboard: Storyboard };
export type Change = { id: string; at: number; section: DocKey; label: string; before: Docs[DocKey]; after?: Docs[DocKey]; beforeArtifact?: { raw: unknown; skillVersion: string; generatedAt: number }; beforeGeneratedSource?: string };
export type Consultation = { id: string; at: number; mode: 'talk' | 'edit'; question: string; reply: string; scene?: Script['episodes'][number]['scenes'][number] };
export type Project = { id: string; kind: ProjectKind; name: string; prompt: string; sourceName?: string; sourceText?: string; generatedSource?: string; genre?: string; episodeCount: number; minDuration: number; maxDuration: number; adaptation: string; ratio: ImageRatio; style: string; needCast: boolean; needArt: boolean; referenceImages: string[]; keep: string; createdAt: number; updatedAt: number; docs: Docs; assets: Asset[]; changes: Change[]; consultations?: Consultation[]; skillProjectImported?: boolean; skillArtifacts?: Partial<Record<DocKey, { raw: unknown; skillVersion: string; generatedAt: number }>> };
export type Store = { projects: Project[]; library: Asset[]; deletedProjectIds?: string[]; deletedAssetIds?: string[]; deletedImages?: string[]; deletedReferenceKeys?: string[]; deletedChangeIds?: string[]; deletedConsultationIds?: string[] };

export const uid = () => Math.random().toString(36).slice(2, 10);
export const clone = <T,>(value: T): T => structuredClone(value);
export function estimateBeatSeconds(beat: ScriptBeat, fallback = ''): number {
  const text = [beat.line, beat.action || fallback].filter(Boolean).join('');
  return Math.round(Math.min(12, Math.max(1.5, text.replace(/\s/g, '').length / 7)) * 10) / 10;
}
export function beatSeconds(beat: ScriptBeat | undefined, fallback = ''): number {
  return beat?.seconds && Number.isFinite(beat.seconds) && beat.seconds > 0 ? beat.seconds : estimateBeatSeconds(beat || {}, fallback);
}
const short = (value: string, size = 32) => value.replace(/\s+/g, ' ').trim().slice(0, size);
export function makeDocs(seed: string, count: number, kind: ProjectKind, version = 0): Docs {
  const topic = short(seed, 36) || '一个尚未命名的故事';
  const suffix = version ? ` · 方案 ${version + 1}` : '';
  const episodeCount = Math.max(1, Math.min(count, kind === 'novel' ? 100 : 12));
  const episodes = Array.from({ length: episodeCount }, (_, i) => ({
    title: i === 0 ? `故事开始${suffix}` : `第 ${i + 1} 集 · 局势变化${suffix}`,
    summary: `围绕「${topic}」推进人物关系与主要冲突。第 ${i + 1} 集揭示一个新的线索，让下一场戏有明确目标。`,
    hook: i === 0 ? `真正改变这一切的原因是什么？` : `接下来，主角会如何选择？`
  }));
  const cast: Character[] = [
    { id: uid(), name: '主角', role: '核心人物', description: `故事「${topic}」的视角人物。外在克制，内心有清晰的渴望。`, arc: '从回避问题，到主动面对并作出选择。' },
    { id: uid(), name: '同行者', role: '关键配角', description: '与主角立场不同，推动冲突并提供新的信息。', arc: '从质疑到理解。' }
  ];
  const scenes: Asset[] = [
    { id: uid(), type: 'scene', name: '主要场景', description: '故事冲突发生的核心空间。低饱和色调、明确的光源与层次。' },
    { id: uid(), type: 'scene', name: '转折场景', description: '用于情绪转折的次要空间，与主场景形成视觉反差。' }
  ];
  const props: Asset[] = [{ id: uid(), type: 'prop', name: '关键道具', description: '在开头出现，并在结尾获得新的意义。' }];
  return {
    outline: { core: `${topic}。故事以一个可见的行动开场，让人物在有限时间内做出决定。${suffix}`, retain: ['核心冲突与人物动机', '最具画面感的关键场面'], cut: ['与主线无关的重复支线'], merge: ['功能相近的次要人物'], risks: ['节奏可能过于平缓；每集保留一次明确转折'], episodes },
    script: { episodes: episodes.map((e, i) => ({ title: e.title, duration: kind === 'novel' ? 120 : 60, hook: e.hook, ending: `第 ${i + 1} 集在一个新的问题上收束。`, scenes: [
      { title: '开场 · 问题出现', location: '主要场景 · 日', description: e.summary, beats: ['近景建立人物状态', '一个动作打破平静', '人物说出此刻最想解决的问题'] },
      { title: '转折 · 做出选择', location: '转折场景 · 日', description: '冲突升级，人物必须采取行动。', beats: ['新的线索出现', '双方立场正面碰撞', '留下下一段的悬念'] }
    ] })) },
    cast,
    art: { scenes, props, style: '半写实电影感；柔和侧光、低饱和色彩、细腻材质。' },
    storyboard: { shots: [
      { id: uid(), scene: '开场', framing: '中景', action: `建立「${topic}」的环境与人物位置。`, duration: 4 },
      { id: uid(), scene: '开场', framing: '特写', action: '捕捉主角察觉变化的瞬间。', duration: 3 },
      { id: uid(), scene: '转折', framing: '近景', action: '人物作出决定，镜头缓慢推进。', duration: 5 }
    ] }
  };
}

export function makeProject(input: Partial<Project> & Pick<Project, 'kind' | 'name' | 'prompt'>): Project {
  const now = Date.now();
  const requested = input.prompt.match(/(?:生成|创作|写)?\s*(\d{1,2})\s*(?:条|集)/);
  const episodeCount = input.episodeCount || (input.kind === 'novel' ? 6 : requested ? Number(requested[1]) : 1);
  return { id: uid(), kind: input.kind, name: input.name, prompt: input.prompt, sourceName: input.sourceName, sourceText: input.sourceText, genre: input.genre || '', episodeCount, minDuration: input.minDuration || 2, maxDuration: input.maxDuration || 5, adaptation: input.adaptation || '抽核', ratio: input.ratio || '16:9', style: input.style || '半写实', needCast: input.needCast ?? true, needArt: input.needArt ?? true, referenceImages: input.referenceImages || [], keep: input.keep || '', createdAt: now, updatedAt: now, docs: makeDocs(input.prompt || input.sourceText || input.name, episodeCount, input.kind), assets: [], changes: [], consultations: [] };
}

export const sectionLabel = (section: DocKey) => ({ outline: '大纲', script: '剧本', cast: '角色', art: '美术', storyboard: '分镜' })[section];
