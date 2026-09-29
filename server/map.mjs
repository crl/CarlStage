const list = value => Array.isArray(value) ? value : [];
const str = value => typeof value === 'string' ? value : '';
const itemText = value => str(value?.what || value?.plan || value?.name || value);

export function mapSkillResult(section, raw, project) {
  if (!raw || typeof raw !== 'object') throw new Error('Skill 未返回有效 JSON。');
  if (section === 'outline') return {
    core: str(raw.adaptation?.core),
    retain: list(raw.adaptation?.keep).map(itemText),
    cut: list(raw.adaptation?.cut).map(itemText),
    merge: list(raw.adaptation?.merge).map(itemText),
    risks: list(raw.adaptation?.risks).map(v => str(v?.plan || v?.what || v)),
    retainDetails: list(raw.adaptation?.keep).map(item => ({ what: str(item?.what || item), why: str(item?.why), evidence: str(item?.evidence) })),
    cutDetails: list(raw.adaptation?.cut).map(item => ({ what: str(item?.what || item), why: str(item?.why), evidence: str(item?.evidence) })),
    mergeDetails: list(raw.adaptation?.merge).map(item => ({ what: str(item?.what || item), why: str(item?.why) })),
    riskDetails: list(raw.adaptation?.risks).map(item => ({ what: str(item?.what || item), plan: str(item?.plan) })),
    cutNote: str(raw.adaptation?.cutNote),
    episodes: list(raw.episodes).map((ep, i) => ({ title: `第 ${ep.ep || i + 1} 集`, summary: str(ep.synopsis), hook: str(ep.hook), suspense: str(ep.suspense), crowdPlan: str(ep.crowdPlan), warnings: list(ep.warnings).map(str), sceneIds: list(ep.sceneIds).map(str), characterIds: list(ep.characterIds).map(str), propIds: list(ep.propIds).map(str) })),
    beats: list(raw.beats).map((beat, i) => ({ id: str(beat.id) || `B${i + 1}`, type: str(beat.type), weight: str(beat.weight), episode: Number(beat.episode) || 1, setup: str(beat.setup), payoff: str(beat.payoff) })),
    characters: list(raw.characters).map((character, i) => ({ id: str(character.id) || `C${i + 1}`, name: str(character.name), role: str(character.role), tier: str(character.tier), arc: str(character.arc), source: list(character.from).join('、') || str(character.from) })),
    scenes: list(raw.scenes).map((scene, i) => ({ id: str(scene.id) || `S${i + 1}`, name: str(scene.name), primary: !!scene.primary, reusePlan: str(scene.reusePlan) })),
    props: list(raw.props).map((prop, i) => ({ id: str(prop.id) || `P${i + 1}`, name: str(prop.name), function: str(prop.function), beatIds: list(prop.beatIds).map(str) }))
  };
  if (section === 'cast') return list(raw.characters).map((c, i) => ({
    id: str(c.id) || `C${String(i + 1).padStart(2, '0')}`,
    name: str(c.name), role: str(c.importance || c.role),
    description: str(c.oneLiner || c.persona?.identity || c.persona?.appearance),
    arc: str(c.persona?.arc || c.arc), aliases: list(c.aliases).map(str),
    persona: c.persona && typeof c.persona === 'object' ? c.persona : undefined,
    imagePrompt: str(c.image?.prompt), imagePromptLocal: str(c.image?.promptLocal), imageSheetPrompt: str(c.image?.sheet), imageNegativePrompt: str(c.image?.negativePrompt), imageTags: list(c.image?.tags).map(str), imageStyle: str(c.image?.style),
    voice: c.voice && typeof c.voice === 'object' ? c.voice : undefined
  }));
  if (section === 'art') return {
    style: project.style || '',
    scenes: list(raw.scenes).map((s, i) => ({ id: str(s.id) || `S${i + 1}`, type: 'scene', name: str(s.name), description: str(s.summary || s.image?.prompt), primary: !!s.primary, anchors: list(s.anchors), states: list(s.lighting), prompt: str(s.image?.prompt), negativePrompt: str(s.image?.negativePrompt), settingPrompt: str(s.image?.sheet) })),
    props: list(raw.props).map((p, i) => ({ id: str(p.id) || `P${i + 1}`, type: 'prop', name: str(p.name), description: str(p.summary || p.image?.prompt), anchors: list(p.anchors), states: list(p.states), scale: str(p.scale), prompt: str(p.image?.prompt), negativePrompt: str(p.image?.negativePrompt), settingPrompt: str(p.image?.sheet) }))
  };
  if (section === 'script') return { episodes: list(raw.episodes).map((ep, i) => ({
    title: `第 ${ep.ep || i + 1} 集`, duration: Number(ep.targetSeconds) || 120,
    hook: str(ep.hook), ending: str(ep.cliff), beatsClaimed: list(ep.beatsClaimed).map(str),
    scenes: list(ep.scenes).map((s, j) => ({
      title: str(s.title) || `场景 ${j + 1}`, location: str(s.location || s.sceneId || s.lighting),
      description: str(s.summary), beats: list(s.flow).map(b => str(b.action || (b.line ? `${b.speaker || ''}：${b.line}` : ''))).filter(Boolean),
      sceneId: str(s.sceneId), lighting: str(s.lighting), characters: list(s.characters).map(str), props: list(s.props).map(str), flow: list(s.flow).filter(b => str(b.action || (b.line ? `${b.speaker || ''}：${b.line}` : ''))).map(b => ({ ...b, seconds: Number(b.seconds) > 0 ? Number(b.seconds) : undefined }))
    }))
  })) };
  if (section === 'storyboard') return { shots: list(raw.episodes).flatMap(ep => list(ep.segments).flatMap(segment => list(segment.cuts).map((cut, i) => {
    const episodeScript = list(project?.docs?.script?.episodes)[(Number(ep.ep) || 1) - 1];
    const scriptBeats = list(episodeScript?.scenes).flatMap(scene => list(scene.flow));
    const [beatStart, beatEnd] = list(cut.beats).map(Number);
    const scriptAction = beatStart > 0 && beatEnd >= beatStart ? scriptBeats.slice(beatStart - 1, beatEnd).map(beat => {
      if (str(beat?.action)) return str(beat.action);
      if (!str(beat?.line)) return '';
      const speakerId = str(beat.speaker);
      const speaker = list(project?.docs?.cast).find(character => character.id === speakerId)?.name || speakerId;
      return `${speaker ? `${speaker}：` : ''}${str(beat.line)}`;
    }).filter(Boolean).join(' ') : '';
    return {
      id: `${segment.id || ep.ep}-${i + 1}`, scene: str(segment.id), framing: str(cut.size), action: scriptAction || str(cut.frame || cut.shot), duration: Number(cut.seconds) || 4,
      episode: Number(ep.ep) || 1, segmentId: str(segment.id), camera: str(cut.camera), lens: str(cut.lens), cameraPosition: str(cut.cameraPosition), composition: str(cut.composition), eyeline: str(cut.eyeline), focus: str(cut.focus), stability: str(cut.stability), characters: list(cut.characters).map(str), props: list(cut.props).map(str), beats: list(cut.beats).map(Number), videoPrompt: str(segment.h3Prompt)
    };
  }))) };
  throw new Error('未知的生成阶段。');
}

export function mapOutlineProjectSettings(raw, project) {
  const params = raw?.params || {};
  const episodes = Number(params.episodes);
  const minutes = Number(params.minutesPerEpisode);
  const ratios = new Set(['1:1', '9:16', '16:9', '3:4', '4:3', '3:2', '2:3', '4:5', '5:4', '21:9']);
  const ratio = params.ratio || params.aspectRatio;
  return {
    ...project,
    ...(Number.isInteger(episodes) && episodes > 0 ? { episodeCount: episodes } : {}),
    ...(Number.isFinite(minutes) && minutes > 0 ? { minDuration: minutes, maxDuration: minutes } : {}),
    ...(typeof params.genre === 'string' ? { genre: params.genre } : {}),
    ...(typeof params.adaptMode === 'string' ? { adaptation: params.adaptMode } : {}),
    ...(ratios.has(ratio) ? { ratio } : {})
  };
}
