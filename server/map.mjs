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
    episodes: list(raw.episodes).map((ep, i) => ({ title: `第 ${ep.ep || i + 1} 集`, summary: str(ep.synopsis), hook: str(ep.hook || ep.suspense) }))
  };
  if (section === 'cast') return list(raw.characters).map((c, i) => ({
    id: str(c.id) || `C${String(i + 1).padStart(2, '0')}`,
    name: str(c.name), role: str(c.importance || c.role),
    description: str(c.oneLiner || c.persona?.identity || c.persona?.appearance),
    arc: str(c.persona?.arc || c.arc)
  }));
  if (section === 'art') return {
    style: project.style || '',
    scenes: list(raw.scenes).map((s, i) => ({ id: str(s.id) || `S${i + 1}`, type: 'scene', name: str(s.name), description: str(s.summary || s.image?.prompt) })),
    props: list(raw.props).map((p, i) => ({ id: str(p.id) || `P${i + 1}`, type: 'prop', name: str(p.name), description: str(p.summary || p.image?.prompt) }))
  };
  if (section === 'script') return { episodes: list(raw.episodes).map((ep, i) => ({
    title: `第 ${ep.ep || i + 1} 集`, duration: Number(ep.targetSeconds) || 120,
    hook: str(ep.hook), ending: str(ep.cliff),
    scenes: list(ep.scenes).map((s, j) => ({
      title: str(s.title) || `场景 ${j + 1}`, location: str(s.location || s.sceneId || s.lighting),
      description: str(s.summary), beats: list(s.flow).map(b => str(b.action || (b.line ? `${b.speaker || ''}：${b.line}` : ''))).filter(Boolean)
    }))
  })) };
  if (section === 'storyboard') return { shots: list(raw.episodes).flatMap(ep => list(ep.segments).flatMap(segment => list(segment.cuts).map((cut, i) => ({
    id: `${segment.id || ep.ep}-${i + 1}`, scene: str(segment.id), framing: str(cut.size), action: str(cut.frame || cut.shot), duration: Number(cut.seconds) || 4
  })))) };
  throw new Error('未知的生成阶段。');
}
