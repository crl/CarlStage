import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { beatSeconds, clone, uid } from './model';
import type { ArtAsset, Asset, Character, CharacterAudioVersion, DocKey, Project, ReferenceImage, ScriptBeat, Shot } from './model';
import { copyText } from './clipboard';
import { CopyPromptIcon } from './CopyPromptIcon';
import { DeleteIcon } from './DeleteIcon';
import { cancelMediaJob, createMediaJob, discardMediaJob, getMediaJob } from './codex';
import type { MediaJob } from './codex';
import { characterDialogueGroup, useScriptDialogueReport, voiceoverDialogueGroup } from './scriptReport';
import type { ScriptDialogueGroup, ScriptDialogueReport } from './scriptReport';

type Save = <T extends DocKey>(key: T, value: Project['docs'][T], label?: string) => void;
type ImageSlot = 'appearance' | 'turnaround' | 'main' | 'setting' | 'state';
type Props = { project: Project; tab: string; detail: string[]; go: (path: string) => void; save: Save; openImage: (url: string) => void; media: (target: Character | ArtAsset | Shot, kind: 'image' | 'video', compact?: boolean, slot?: ImageSlot, referenceImage?: string, stateIndex?: number) => ReactNode; addToLibrary?: (asset: Asset) => void; renderImagePicker?: (value: string | undefined, onChange: (url: string) => void) => ReactNode; renderReferencePicker?: (selected: string[], onSelectionChange: (urls: string[], assets: Asset[]) => void, onClose: () => void) => ReactNode };

export function ProjectSubnav({ project, tab, detail, go }: Pick<Props, 'project' | 'tab' | 'detail' | 'go'>) {
  const root = `/p/${project.id}/${tab}`;
  const link = (path: string, title: string, suffix = '') => <button key={path} className={detail.join('/') === path.split('/').map(part => decodeURIComponent(part)).join('/') ? 'active' : ''} onClick={() => go(`${root}${path ? `/${path}` : ''}`)}>{title}{suffix && <small>{suffix}</small>}</button>;
  if (!['outline', 'script', 'storyboard'].includes(tab)) return null;
  return <aside className="project-subnav">{tab !== 'outline' && <div className="project-subnav-title">{tab === 'script' ? '剧本 · SCRIPT' : '分镜 · STORYBOARD'}</div>}
    {tab === 'outline' && <><strong>总表</strong>{link('', '改编报告')}<strong>分集</strong>{project.docs.outline.episodes.map((_, i) => link(`episodes/${i + 1}`, `第 ${i + 1} 集`))}</>}
    {tab === 'script' && <><strong>分集</strong>{project.docs.script.episodes.map((ep, i) => { const beats = ep.scenes.flatMap(scene => scene.beats.map((text, index) => ({ text, flow: scene.flow?.[index] }))); const actual = beats.reduce((sum, item) => sum + beatSeconds(item.flow, item.text), 0); return <button key={i} className={`script-episode-link ${detail[0] === String(i + 1) ? 'active' : ''}`} onClick={() => go(`${root}/${i + 1}`)}><span><span className="script-episode-nav-title"><b>第 {i + 1} 集</b>{ep.beatsClaimed?.map((tag, tagIndex) => <em key={`${tag}-${tagIndex}`}>{tag}</em>)}</span><small>{actual.toFixed(1)}s / {ep.duration}s</small></span><small>{ep.scenes.length} 场 · {beats.length} 节拍 · {beats.filter(item => item.flow?.line).length} 台词</small><span className="script-episode-meter"><i style={{ width: `${Math.min(100, actual / Math.max(1, ep.duration) * 100)}%` }}/></span><small>钩子　{ep.hook || '—'}</small><small>断点　{ep.ending || '—'}</small></button>; })}</>}
    {tab === 'storyboard' && <><strong>总表</strong>{link('', '节奏与覆盖')}{Array.from({ length: Math.max(project.docs.script.episodes.length, project.docs.outline.episodes.length, ...project.docs.storyboard.shots.map(s => s.episode || 1), 1) }, (_, index) => index + 1).map(ep => { const shots = project.docs.storyboard.shots.filter(s => (s.episode || 1) === ep); const seconds = shots.reduce((sum, shot) => sum + shot.duration, 0); const segments = Array.from(new Set(shots.map(s => s.segmentId || '未分段'))); return <div className="storyboard-nav-episode" key={ep}><strong>第 {ep} 集 <small>{seconds.toFixed(1)}s · {shots.length} 镜</small></strong>{link(String(ep), '本集总表', `${segments.length} 段`)}{segments.map(segment => { const segmentShots = shots.filter(s => (s.segmentId || '未分段') === segment); const duration = segmentShots.reduce((sum, shot) => sum + shot.duration, 0); return link(`${ep}/${encodeURIComponent(segment)}`, segment === '未分段' ? `未分段镜头` : segment, `${duration.toFixed(1)}s · ${segmentShots.length} 镜`); })}</div>; })}</>}
  </aside>;
}

function Editable({ label, value, onSave, multiline = false, copy = true, hideLabel = false, className = '' }: { label: string; value: string; onSave: (next: string) => void; multiline?: boolean; copy?: boolean; hideLabel?: boolean; className?: string }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  function commit() { if (draft !== value) onSave(draft); setEditing(false); }
  return <div className={`detail-field ${className}`}>{!hideLabel && <div className="detail-field-head"><span>{label}</span>{copy && <button className="copy-prompt-button" onClick={() => void copyText(value)} title={`复制${label}`} aria-label={`复制${label}`}><CopyPromptIcon/></button>}</div>}{editing ? multiline ? <textarea autoFocus value={draft} onChange={e => setDraft(e.target.value)} onBlur={commit} onKeyDown={e => { if (e.key === 'Escape') { setDraft(value); setEditing(false); } if (e.ctrlKey && e.key === 'Enter') commit(); }}/> : <input autoFocus value={draft} onChange={e => setDraft(e.target.value)} onBlur={commit} onKeyDown={e => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') { setDraft(value); setEditing(false); } }}/> : <div className="detail-value" onDoubleClick={() => setEditing(true)} title="双击编辑">{value || <em>双击填写</em>}</div>}</div>;
}

function BilingualPromptField({ label, english, chinese, onSave }: { label: string; english: string; chinese: string; onSave: (language: 'en' | 'zh', value: string) => void }) {
  const [language, setLanguage] = useState<'en' | 'zh'>('en');
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(english);
  const value = language === 'en' ? english : chinese;
  useEffect(() => { setDraft(value); setEditing(false); }, [value]);
  function commit() { if (draft !== value) onSave(language, draft); setEditing(false); }
  function select(next: 'en' | 'zh') { if (next === language) return; setLanguage(next); setEditing(false); }
  return <div className="detail-field bilingual-prompt-field"><div className="detail-field-head"><span>{label}</span><div className="bilingual-prompt-actions"><div className="bilingual-prompt-tabs" role="tablist" aria-label={`${label}语言`}><button type="button" role="tab" aria-selected={language === 'zh'} className={language === 'zh' ? 'active' : ''} onClick={() => select('zh')}>中文</button><button type="button" role="tab" aria-selected={language === 'en'} className={language === 'en' ? 'active' : ''} onClick={() => select('en')}>English</button></div><button className="copy-prompt-button" type="button" onClick={() => void copyText(value)} title={`复制${label}`} aria-label={`复制${label}`}><CopyPromptIcon/></button></div></div>{editing ? <textarea autoFocus value={draft} onChange={event => setDraft(event.target.value)} onBlur={commit} onKeyDown={event => { if (event.key === 'Escape') { setDraft(value); setEditing(false); } if (event.ctrlKey && event.key === 'Enter') commit(); }}/> : <div className="detail-value" onDoubleClick={() => setEditing(true)} title="双击编辑">{value || <em>{language === 'zh' ? '暂无中文提示词' : '暂无英文提示词'}</em>}</div>}</div>;
}

function CharacterImagePanel({ character, sheetPrompt, negativePrompt, media, openImage, addToLibrary, renderImagePicker, onEdit }: { character: Character; sheetPrompt: string; negativePrompt: string; media: Props['media']; openImage: Props['openImage']; addToLibrary?: Props['addToLibrary']; renderImagePicker?: Props['renderImagePicker']; onEdit: (field: keyof Character, value: string) => void }) {
  const [slot, setSlot] = useState<ImageSlot>('appearance');
  const image = slot === 'appearance' ? character.image : character.turnaroundImage;
  const imageTarget: Character = { ...character, image, imagePrompt: slot === 'appearance' ? character.imagePrompt : sheetPrompt, imageNegativePrompt: negativePrompt, ...(slot === 'turnaround' ? { turnaroundImage: character.image } : {}) };
  return <section className="panel character-image-panel"><div className="character-image-panel-head"><div className="character-image-tabs" role="tablist" aria-label="角色图片类型"><button type="button" role="tab" aria-selected={slot === 'appearance'} className={slot === 'appearance' ? 'active' : ''} onClick={() => setSlot('appearance')}>形象</button><button type="button" role="tab" aria-selected={slot === 'turnaround'} className={slot === 'turnaround' ? 'active' : ''} onClick={() => setSlot('turnaround')}>三视图</button></div></div>{media(imageTarget, 'image', true, slot)}{image ? <img className="character-detail-image" src={image} onClick={() => openImage(image)} alt={`${character.name}${slot === 'appearance' ? '形象' : '三视图'}`}/> : <div className="character-detail-image-empty">{slot === 'appearance' ? '尚未生成角色形象图' : '尚未生成角色三视图'}</div>}<div className="art-detail-image-actions">{addToLibrary && <button className="btn small" disabled={!image} onClick={() => addToLibrary({ id: `${character.id}-${slot}`, type: 'character', name: `${character.name} · ${slot === 'appearance' ? '形象' : '三视图'}`, description: character.description, prompt: imageTarget.imagePrompt || '', image })}>加入资产库</button>}{renderImagePicker?.(image, url => onEdit(slot === 'appearance' ? 'image' : 'turnaroundImage', url))}</div></section>;
}

function ArtImagePanel({ asset, settingPrompt, media, openImage, addToLibrary, renderImagePicker, onEdit, label }: { asset: ArtAsset; settingPrompt: string; media: Props['media']; openImage: Props['openImage']; addToLibrary?: Props['addToLibrary']; renderImagePicker?: Props['renderImagePicker']; onEdit: (field: keyof ArtAsset, value: string) => void; label: string }) {
  const [view, setView] = useState<'main' | 'setting'>('main');
  const image = view === 'main' ? asset.image : asset.settingImage;
  const viewAsset: ArtAsset = view === 'main' ? asset : { ...asset, image, prompt: settingPrompt };
  const viewName = view === 'main' ? '主视角' : '设定图';
  return <section className="panel art-image-panel scene-image-panel"><div className="character-image-panel-head"><div className="character-image-tabs" role="tablist" aria-label={`${label}图片视图`}><button type="button" role="tab" aria-selected={view === 'main'} className={view === 'main' ? 'active' : ''} onClick={() => setView('main')}>主视角</button><button type="button" role="tab" aria-selected={view === 'setting'} className={view === 'setting' ? 'active' : ''} onClick={() => setView('setting')}>设定图</button></div>{media(viewAsset, 'image', true, view, asset.image)}</div>{image ? <img className="art-detail-image" src={image} onClick={() => openImage(image)} alt={`${asset.name}${viewName}`}/> : <div className="character-detail-image-empty">尚未生成{asset.name}{viewName}</div>}<div className="art-detail-image-actions">{addToLibrary && <button className="btn small" disabled={!image} onClick={() => addToLibrary({ id: `${asset.id}-${view}`, type: asset.type, name: `${asset.name} · ${viewName}`, description: asset.description, prompt: viewAsset.prompt || '', image })}>加入资产库</button>}{renderImagePicker?.(image, url => onEdit(view === 'main' ? 'image' : 'settingImage', url))}</div></section>;
}

function stateReferencesFromAssets(urls: string[], assets: Asset[]): ReferenceImage[] {
  const byUrl = new Map(assets.filter(asset => asset.image).map(asset => [asset.image!, asset]));
  return urls.map((image, index) => {
    const asset = byUrl.get(image);
    const category: ReferenceImage['category'] = asset?.type === 'character' ? '角色' : asset?.type === 'scene' ? '场景' : asset?.type === 'prop' ? '道具' : asset?.type === 'storyboard' ? '分镜图' : '其他';
    return { assetId: asset?.id || `state-reference-${index}`, image, name: asset?.name || `参考图 ${index + 1}`, category };
  });
}

function CharacterStatesPanel({ project, character, media, openImage, addToLibrary, renderImagePicker, renderReferencePicker, save }: { project: Project; character: Character; media: Props['media']; openImage: Props['openImage']; addToLibrary?: Props['addToLibrary']; renderImagePicker?: Props['renderImagePicker']; renderReferencePicker?: Props['renderReferencePicker']; save: Save }) {
  const [deleteIndex, setDeleteIndex] = useState<number | null>(null);
  const [referenceStateIndex, setReferenceStateIndex] = useState<number | null>(null);
  const characterIndex = project.docs.cast.findIndex(item => item.id === character.id);
  const states = character.states || [];
  const changeState = (stateIndex: number, change: Partial<NonNullable<Character['states']>[number]>, label: string) => {
    const next = clone(project.docs.cast);
    const current = next[characterIndex].states || [];
    current[stateIndex] = { ...current[stateIndex], ...change };
    next[characterIndex].states = current;
    save('cast', next, label);
  };
  const updateImage = (stateIndex: number, image: string) => changeState(stateIndex, { image }, `设置${character.name}状态图片`);
  return <section className="character-detail-section character-states-section">
    <div className="art-state-section-head"><h2>状态</h2><button type="button" className="btn small art-state-add" title="添加角色状态" aria-label="添加角色状态" onClick={() => { const next = clone(project.docs.cast); next[characterIndex].states ||= []; next[characterIndex].states!.push({ id: uid(), state: '新状态', prompt: '' }); save('cast', next, `添加${character.name}状态`); }}>+</button></div>
    {states.length ? states.map((state, stateIndex) => {
      const stateCharacter: Character = { ...character, name: `${character.name} · ${state.state}`, image: state.image, imagePrompt: state.prompt };
      const references = state.referenceImages || [];
      const reorderReferences = (fromIndex: number, toIndex: number) => {
        const nextReferences = [...references];
        const [moved] = nextReferences.splice(fromIndex, 1);
        nextReferences.splice(toIndex, 0, moved);
        changeState(stateIndex, { referenceImages: nextReferences }, `调整${character.name}${state.state}引用图顺序`);
      };
      return <div className="character-state-item panel" key={state.id || `${state.state}-${stateIndex}`}>
        <div className="character-state-heading"><Editable className="art-state-name" hideLabel label="状态名称" value={state.state} copy={false} onSave={value => changeState(stateIndex, { state: value }, `修改${character.name}状态名称`)}/><button type="button" className="icon-button art-state-remove delete-icon-button" title="删除状态" aria-label={`删除${state.state}`} onClick={() => setDeleteIndex(stateIndex)}>×</button></div>
        <div className="art-state-row character-state-row">
        <section className="panel art-state-image-panel">
          <div className="art-state-image-head"><div className="art-state-image-controls">{media(stateCharacter, 'image', true, 'state', character.image, stateIndex)}</div></div>
          {state.image ? <button type="button" className="art-state-image-preview" onClick={() => openImage(state.image!)} title={`查看${state.state}图片`}><img src={state.image} alt={`${character.name} · ${state.state}`}/></button> : <div className="art-state-image-empty">尚未生成{character.name}{state.state}</div>}
          <div className="art-state-image-actions"><button className="btn small" disabled={!state.image} onClick={() => addToLibrary?.({ id: `${character.id}-state-${state.id || stateIndex}`, type: 'character', name: `${character.name} · ${state.state}`, description: character.description, prompt: state.prompt, image: state.image })}>加入资产库</button>{renderImagePicker?.(state.image, image => updateImage(stateIndex, image))}</div>
        </section>
        <div className="art-state-content"><Editable label="提示词" value={state.prompt} multiline onSave={value => changeState(stateIndex, { prompt: value }, `修改${character.name}${state.state}提示词`)}/>
          <div className="segment-shot-reference-head character-state-reference-head"><span>引用资产</span><button type="button" className="btn small segment-add-reference-button" title="添加引用" aria-label="添加引用" onClick={() => setReferenceStateIndex(stateIndex)}>＋</button></div>
          <div className="segment-shot-references character-state-references">{references.map((reference, referenceIndex) => <div draggable onDragStart={event => { event.dataTransfer.setData('text/plain', String(referenceIndex)); event.dataTransfer.effectAllowed = 'move'; }} onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); const fromIndex = Number(event.dataTransfer.getData('text/plain')); if (Number.isInteger(fromIndex) && fromIndex !== referenceIndex) reorderReferences(fromIndex, referenceIndex); }} className={`segment-shot-reference segment-shot-reference-${reference.category === '角色' ? 'character' : reference.category === '场景' ? 'scene' : reference.category === '分镜图' ? 'storyboard' : reference.category === '道具' ? 'prop' : 'other'}`} key={`${reference.assetId}-${reference.image}`}><img src={reference.image} alt="" title="点击查看大图" onClick={() => openImage(reference.image)}/><small>{reference.category}</small><strong title={reference.name}>{reference.name}</strong><button type="button" className="segment-shot-reference-remove delete-icon-button" title="移除引用" aria-label={`移除引用：${reference.name}`} onClick={() => changeState(stateIndex, { referenceImages: references.filter((_, index) => index !== referenceIndex) }, `移除${character.name}${state.state}引用图片`)}>×</button></div>)}{!references.length && <span className="segment-shot-no-references">尚未引用图片</span>}</div>
        </div>
        {referenceStateIndex === stateIndex && renderReferencePicker?.(references.map(reference => reference.image), (urls, assets) => changeState(stateIndex, { referenceImages: stateReferencesFromAssets(urls, assets) }, `修改${character.name}${state.state}引用图片`), () => setReferenceStateIndex(null))}
        </div>
      </div>;
    }) : <p className="character-detail-empty">暂无状态设定</p>}
    {deleteIndex !== null && (
      <ConfirmDelete
        title="删除角色状态"
        label={states[deleteIndex]?.state || '角色状态'}
        onCancel={() => setDeleteIndex(null)}
        onConfirm={() => {
          const next = clone(project.docs.cast);
          next[characterIndex].states?.splice(deleteIndex, 1);
          save('cast', next, `删除${character.name}状态`);
          setDeleteIndex(null);
        }}
      />
    )}
  </section>;
}

export function ProjectDetail({ project, tab, detail, go, save, openImage, media, addToLibrary, renderImagePicker, renderReferencePicker }: Props) {
  const root = `/p/${project.id}`;
  const [stateDeleteIndex, setStateDeleteIndex] = useState<number | null>(null);
  const [artReferenceStateIndex, setArtReferenceStateIndex] = useState<number | null>(null);
  if (tab === 'outline' && detail[0] === 'beats') {
    const beats = project.docs.outline.beats || [];
    return <><div className="eyebrow">大纲 / 爽点表</div><h1>爽点表</h1><section className="panel"><table className="detail-table"><thead><tr><th>ID</th><th>类型</th><th>集</th><th>铺垫</th><th>兑现</th></tr></thead><tbody>{beats.map((beat, i) => <tr key={beat.id || i}><td>{beat.id}</td><td>{beat.type}</td><td>E{beat.episode}</td><td><Editable label="铺垫" value={beat.setup} onSave={v => { const next = clone(project.docs.outline); next.beats![i].setup = v; save('outline', next, '修改爽点铺垫'); }}/></td><td><Editable label="兑现" value={beat.payoff} onSave={v => { const next = clone(project.docs.outline); next.beats![i].payoff = v; save('outline', next, '修改爽点兑现'); }}/></td></tr>)}</tbody></table>{!beats.length && <p className="detail-empty">暂无爽点；重新生成大纲后可获取爽点表。</p>}</section></>;
  }
  if (tab === 'outline' && detail[0] === 'episodes') {
    const index = Number(detail[1]) - 1, ep = project.docs.outline.episodes[index];
    if (!ep) return <div className="empty-page">找不到这一集</div>;
    const change = (field: 'title' | 'summary' | 'hook' | 'suspense' | 'crowdPlan', value: string) => { const next = clone(project.docs.outline); next.episodes[index][field] = value; save('outline', next, `修改第 ${index + 1} 集${field}`); };
    const beats = (project.docs.outline.beats || []).filter(beat => beat.episode === index + 1);
    return <><div className="eyebrow">大纲 / 分集</div><section className="panel outline-report-episode outline-report-episode-compact outline-episode-detail-card"><header className="outline-episode-detail-head"><Editable className="outline-episode-detail-title" hideLabel label="标题" value={ep.title || `第 ${index + 1} 集`} onSave={v => change('title', v)} copy={false}/>{beats.length ? beats.map(beat => <span className="outline-episode-type" key={beat.id}>{beat.type}</span>) : <span className="outline-episode-type empty">暂无爽点</span>}</header><Editable className="outline-episode-summary" hideLabel label="梗概" value={ep.summary} multiline onSave={v => change('summary', v)} copy={false}/><div className="outline-episode-lines"><div><b>钩子</b><Editable className="outline-episode-line-text" hideLabel label="钩子" value={ep.hook} multiline onSave={v => change('hook', v)} copy={false}/></div><div><b>悬念</b><Editable className="outline-episode-line-text" hideLabel label="悬念" value={ep.suspense || ''} multiline onSave={v => change('suspense', v)} copy={false}/></div></div><div className="outline-episode-refs">{(ep.sceneIds || []).map((id, refIndex) => { const asset = project.docs.art.scenes.find(item => item.id === id) || project.docs.art.scenes.find(item => item.name === project.docs.outline.scenes?.find(scene => scene.id === id)?.name); const name = project.docs.outline.scenes?.find(scene => scene.id === id)?.name || asset?.name || id; return asset ? <button type="button" className="outline-episode-ref outline-episode-ref-link outline-episode-ref-scene" key={`s-${id}-${refIndex}`} onClick={() => go(`${root}/art/scenes/${encodeURIComponent(asset.id)}`)}>{name}</button> : <span className="outline-episode-ref outline-episode-ref-scene" key={`s-${id}-${refIndex}`}>{name}</span>; })}{(ep.characterIds || []).map((id, refIndex) => { const outlineCharacter = project.docs.outline.characters?.find(item => item.id === id); const asset = project.docs.cast.find(item => item.id === id) || project.docs.cast.find(item => item.name === outlineCharacter?.name); const name = outlineCharacter?.name || asset?.name || id; return asset ? <button type="button" className="outline-episode-ref outline-episode-ref-link outline-episode-ref-character" key={`c-${id}-${refIndex}`} onClick={() => go(`${root}/cast/${encodeURIComponent(asset.id)}`)}>{name}</button> : <span className="outline-episode-ref outline-episode-ref-character" key={`c-${id}-${refIndex}`}>{name}</span>; })}{(ep.propIds || []).map((id, refIndex) => { const outlineProp = project.docs.outline.props?.find(item => item.id === id); const asset = project.docs.art.props.find(item => item.id === id) || project.docs.art.props.find(item => item.name === outlineProp?.name); const name = outlineProp?.name || asset?.name || id; return asset ? <button type="button" className="outline-episode-ref outline-episode-ref-link outline-episode-ref-prop" key={`p-${id}-${refIndex}`} onClick={() => go(`${root}/art/props/${encodeURIComponent(asset.id)}`)}>{name}</button> : <span className="outline-episode-ref outline-episode-ref-prop" key={`p-${id}-${refIndex}`}>{name}</span>; })}{ep.crowdPlan && <details className="outline-episode-crowd"><summary>同框拆解 ✓</summary><Editable className="outline-episode-line-text" hideLabel label="同框拆解" value={ep.crowdPlan} multiline onSave={v => change('crowdPlan', v)} copy={false}/></details>}</div>{ep.warnings?.length ? <div className="outline-report-warnings">{ep.warnings.map((warning, warningIndex) => <span key={warningIndex}>{warning}</span>)}</div> : null}</section><div className="inline-actions outline-episode-detail-actions"><button className="btn" onClick={() => go(`${root}/script/${index + 1}`)}>查看剧本 →</button></div></>;
  }
  if (tab === 'script' && detail[0]) {
    const index = Number(detail[0]) - 1, ep = project.docs.script.episodes[index];
    if (!ep) return <div className="empty-page">{project.docs.script.episodes.length ? '找不到这一集' : '暂无剧本分集'}{!project.docs.script.episodes.length && <button className="btn" onClick={() => save('script', { episodes: [{ title: '第 1 集', duration: 120, hook: '', ending: '', scenes: [] }] }, '新增剧本分集')}>＋ 新增第一集</button>}</div>;
    return <ScriptEpisodeDetail project={project} index={index} save={save} go={go}/>;
  }
  if (tab === 'cast' && detail[0]) {
    if (detail[0] === 'VO') return <VoiceoverCharacterDetail project={project} go={go}/>;
    const index = project.docs.cast.findIndex(c => c.id === detail[0] || c.name === detail[0]);
    const character = project.docs.cast[index]; if (!character) return <div className="empty-page">找不到这个角色</div>;
    const edit = (field: keyof Character, value: string) => { const next = clone(project.docs.cast); (next[index] as unknown as Record<string, unknown>)[field] = value; save('cast', next, `修改${character.name}${field}`); };
    const persona = character.persona || {};
    const rawCast = project.skillArtifacts?.cast?.raw as { characters?: { name?: string; image?: { tags?: unknown; negativePrompt?: unknown; promptLocal?: unknown; sheet?: unknown } }[] } | undefined;
    const rawCharacter = rawCast?.characters?.find(item => item.name === character.name) || rawCast?.characters?.[index];
    const imageTags = character.imageTags?.length ? character.imageTags : Array.isArray(rawCharacter?.image?.tags) ? rawCharacter.image.tags.filter((tag): tag is string => typeof tag === 'string') : [];
    const imageNegativePrompt = character.imageNegativePrompt ?? (typeof rawCharacter?.image?.negativePrompt === 'string' ? rawCharacter.image.negativePrompt : '');
    const imagePromptLocal = character.imagePromptLocal ?? (typeof rawCharacter?.image?.promptLocal === 'string' ? rawCharacter.image.promptLocal : '');
    const imageSheetPrompt = character.imageSheetPrompt ?? (typeof rawCharacter?.image?.sheet === 'string' ? rawCharacter.image.sheet : '');
    const outlineCharacter = project.docs.outline.characters?.find(item => item.name === character.name);
    const relations = Array.isArray(persona.relationships) ? persona.relationships as { name?: string; relation?: string }[] : Array.isArray(persona.relations) ? persona.relations as { name?: string; relation?: string }[] : [];
    const evidence = persona.evidence || [];
    const characterNames = new Set([character.id, character.name, ...(character.aliases || [])].map(value => value.trim()).filter(Boolean));
    const usageByKey = new Map<string, { episode: number; sceneIndex: number; sceneId?: string; sceneName: string; lighting: string; props: Set<string>; label: string; path: string }>();
    const propName = (id: string) => project.docs.art.props.find(prop => prop.id === id || prop.name === id)?.name || id;
    project.docs.script.episodes.forEach((episode, episodeIndex) => episode.scenes.forEach((scene, sceneIndex) => {
      const appears = (scene.characters || []).some(id => characterNames.has(id.trim())) || (scene.flow || []).some(beat => !!beat.speaker && characterNames.has(beat.speaker.trim()));
      if (!appears) return;
      const episodeNumber = episodeIndex + 1;
      const sceneNumber = sceneIndex + 1;
      const target = sceneStoryboardTarget(project, episodeNumber, sceneNumber, scene.sceneId);
      usageByKey.set(`${episodeNumber}:${sceneNumber}`, { episode: episodeNumber, sceneIndex: sceneNumber, sceneId: scene.sceneId, sceneName: scene.title || scene.location || '未命名场景', lighting: scene.lighting || '', props: new Set((scene.props || []).map(propName)), label: target.label, path: target.path });
    }));
    project.docs.storyboard.shots.forEach((shot, shotIndex) => {
      if (!(shot.characters || []).some(id => characterNames.has(id.trim()))) return;
      const episodeNumber = shot.episode || 1;
      const existing = [...usageByKey.values()].find(item => item.episode === episodeNumber && ((shot.sceneId && item.sceneId === shot.sceneId) || (!!shot.scene && item.sceneName === shot.scene)));
      if (existing) { (shot.props || []).forEach(id => existing.props.add(propName(id))); return; }
      const key = `shot:${episodeNumber}:${shot.segmentId || shot.id}`;
      const entry = usageByKey.get(key);
      if (entry) { (shot.props || []).forEach(id => entry.props.add(propName(id))); return; }
      const path = shot.segmentId ? `${root}/storyboard/${episodeNumber}/${encodeURIComponent(shot.segmentId)}` : `${root}/storyboard/${episodeNumber}`;
      usageByKey.set(key, { episode: episodeNumber, sceneIndex: shotIndex + 1, sceneId: shot.sceneId || undefined, sceneName: shot.scene || '未命名场景', lighting: '', props: new Set((shot.props || []).map(propName)), label: shot.segmentId || `镜头 ${shotIndex + 1}`, path });
    });
    const characterUsage = [...usageByKey.values()];
    const editPersona = (field: string, value: string) => { const next = clone(project.docs.cast); next[index].persona = { ...next[index].persona, [field]: value }; save('cast', next, `修改${character.name}${field}`); };
    const voiceLabels: Record<string, string> = { timbre: '音色', pitch: '音高', pace: '语速', accent: '口音', emotion: '情绪', referenceHint: '参考提示', prompt: '音色提示词', voiceTimbre: '音色', voicePitch: '音高', voicePace: '语速', voiceAccent: '口音', voiceEmotion: '情绪', voiceReferenceHint: '参考提示', voicePrompt: '音色提示词' };
    const voiceEntries = Object.entries(character.voice || {}).filter(([key]) => key !== 'audioSample');
    const audioHistory: CharacterAudioVersion[] = [...(character.audioHistory || [])];
    if (character.voice?.audioSample && !audioHistory.some(version => version.url === character.voice?.audioSample)) audioHistory.unshift({ id: 'legacy-audio-sample', url: character.voice.audioSample, generatedAt: 0, prompt: '', lyrics: '', duration: 0 });
    const activeAudio = audioHistory.find(version => version.id === character.activeAudioId);
    const setActiveAudio = (id?: string) => { const next = clone(project.docs.cast); if (id) next[index].activeAudioId = id; else delete next[index].activeAudioId; save('cast', next, id ? `设为${character.name}当前语音` : `取消${character.name}当前语音`); };
    const copyVoice = () => copyText(voiceEntries.map(([key, value]) => `${voiceLabels[key] || key}：${value}`).join('\n'));
    return <div className="character-detail-page">
      <header className="character-detail-head"><div className="character-detail-title"><button className="character-back" onClick={() => go(`${root}/cast`)}>角色</button><span>/</span><span className="character-code-badge">{outlineCharacter?.id || character.id}</span><h1>{character.name}</h1><span className="character-role-badge">{character.role || '角色'}</span></div><p>{character.description || '暂无角色简介'}</p></header>
      <div className="character-detail-columns">
        <div className="character-detail-main">
          <section className="character-detail-section"><h2>人物画像</h2><div className="character-persona-grid">{([['gender','性别'],['ageRange','年龄'],['identity','身份'],['appearance','外形'],['temperament','性情'],['motivation','动机']] as const).map(([key, label]) => <Editable key={key} label={label} value={persona[key] || ''} multiline onSave={value => editPersona(key, value)}/>)}</div>{!!persona.personality?.length && <div className="character-personality-tags">{persona.personality.map((tag, i) => <span className="chip" key={`${tag}-${i}`}>{tag}</span>)}</div>}{imageTags.length > 0 && <div className="character-image-tags">{imageTags.map((tag, i) => <span className="chip" key={`${tag}-${i}`}>{tag}</span>)}</div>}</section>
          <section className="character-detail-section"><h2>弧光</h2><div className="character-arc-block"><div><span>CAST</span><Editable label="角色弧光" value={character.arc || ''} multiline onSave={value => edit('arc', value)}/></div>{outlineCharacter?.arc && <div><span>OUTLINE</span><p>{outlineCharacter.arc}</p></div>}</div>{outlineCharacter?.arc && character.arc && outlineCharacter.arc !== character.arc && <p className="character-detail-hint">角色卡与大纲中的弧光内容不同，分别保留在各自栏目。</p>}</section>
          <CharacterStatesPanel project={project} character={character} media={media} openImage={openImage} addToLibrary={addToLibrary} renderImagePicker={renderImagePicker} renderReferencePicker={renderReferencePicker} save={save}/>
          <section className="character-detail-section"><h2>关系</h2>{relations.length ? <div className="character-relations"><table><tbody>{relations.map((relation, i) => <tr key={`${relation.name}-${i}`}><th>{relation.name || '未命名角色'}</th><td>{relation.relation || '—'}</td></tr>)}</tbody></table></div> : <p className="character-detail-empty">暂无关系信息</p>}</section>
          <CharacterDialogueBook project={project} go={go} character={character} onSaveAudio={version => { const next = clone(project.docs.cast); next[index].audioHistory = [...(next[index].audioHistory || []), version]; save('cast', next, `保存${character.name}语音历史`); }}/>
          <section className="character-detail-section"><h2>原文佐证</h2>{evidence.length ? <ul className="character-evidence">{evidence.map((quote, i) => <li key={i}>{quote}</li>)}</ul> : <p className="character-detail-empty">暂无原文佐证</p>}</section>
        </div>
        <aside className="character-detail-side">
          <CharacterImagePanel character={character} sheetPrompt={imageSheetPrompt} negativePrompt={imageNegativePrompt} media={media} openImage={openImage} addToLibrary={addToLibrary} renderImagePicker={renderImagePicker} onEdit={edit}/>
          <section className="panel character-prompt-panel"><h2>出图提示词</h2><div className="character-prompt-fields"><BilingualPromptField label="角色提示词" english={character.imagePrompt || ''} chinese={imagePromptLocal} onSave={(language, value) => edit(language === 'en' ? 'imagePrompt' : 'imagePromptLocal', value)}/><BilingualPromptField label="三视图提示词" english={imageSheetPrompt} chinese={character.imageSheetPromptLocal || ''} onSave={(language, value) => edit(language === 'en' ? 'imageSheetPrompt' : 'imageSheetPromptLocal', value)}/><Editable label="反向提示词" value={imageNegativePrompt} multiline onSave={value => edit('imageNegativePrompt', value)}/></div></section>
          <section className="panel character-voice-panel"><div className="character-voice-panel-head"><h2>音色</h2><div className="character-voice-panel-actions">{audioHistory.length > 0 && <CharacterAudioHistoryButton character={character} versions={audioHistory} activeId={character.activeAudioId} onSelect={setActiveAudio}/>}{voiceEntries.length > 0 && <button className="copy-prompt-button" type="button" onClick={() => void copyVoice()} title="复制全部音色" aria-label="复制全部音色"><CopyPromptIcon/></button>}</div></div>{activeAudio && <div className="character-audio-featured"><div><span>当前语音</span><button type="button" onClick={() => setActiveAudio()}>收起</button></div><audio controls src={activeAudio.url}/></div>}{voiceEntries.length ? voiceEntries.map(([key, value]) => <Editable key={key} label={voiceLabels[key] || key} value={value} multiline copy={false} onSave={nextValue => { const next = clone(project.docs.cast); next[index].voice = { ...next[index].voice, [key]: nextValue }; save('cast', next, `修改${character.name}音色`); }}/>) : <p className="character-detail-empty">暂无音色设定</p>}</section>
        </aside>
      </div>
      <section className="character-detail-section character-usage-section"><h2>用在哪</h2>{characterUsage.length ? <div className="panel character-usage-table"><table><thead><tr><th>分镜</th><th>场景</th><th>光照</th><th>道具</th></tr></thead><tbody><ExpandableTableRows items={characterUsage} colSpan={4} renderRow={(item, usageIndex) => <tr key={`${item.episode}-${item.sceneIndex}-${usageIndex}`}><td><button className="detail-link" title={`跳转到${item.label}`} onClick={() => go(item.path)}>{item.label}</button></td><td>{item.sceneName}</td><td>{item.lighting || '—'}</td><td>{item.props.size ? [...item.props].join('、') : '—'}</td></tr>}/></tbody></table></div> : <p className="character-detail-empty">当前还没有剧本或分镜记录该角色的出场。</p>}</section>
    </div>;
  }
  if (tab === 'art' && ['scenes', 'props'].includes(detail[0]) && detail[1]) {
    const kind = detail[0] as 'scenes' | 'props'; const index = project.docs.art[kind].findIndex(a => a.id === detail[1]); const asset = project.docs.art[kind][index];
    if (!asset) return <div className="empty-page">找不到这个美术条目</div>;
    const edit = (field: keyof ArtAsset, value: string) => { const next = clone(project.docs.art); (next[kind][index] as Record<string, unknown>)[field] = value; save('art', next, `修改${asset.name}${field}`); };
    const rawArt = project.skillArtifacts?.art?.raw as { scenes?: { id?: string; name?: string; image?: { sheet?: unknown } }[]; props?: { id?: string; name?: string; image?: { sheet?: unknown } }[] } | undefined;
    const rawEntry = rawArt?.[kind]?.find(entry => entry.id === asset.id || entry.name === asset.name);
    const settingPrompt = asset.settingPrompt ?? (typeof rawEntry?.image?.sheet === 'string' ? rawEntry.image.sheet : '');
    const usage = project.docs.script.episodes.flatMap((episode, episodeIndex) => episode.scenes.flatMap((scene, sceneIndex) => {
      const matched = kind === 'scenes' ? scene.sceneId === asset.id : (scene.props || []).includes(asset.id);
      return matched ? [{ episode: episodeIndex + 1, sceneIndex: sceneIndex + 1, sceneId: scene.sceneId, lighting: scene.lighting || '' }] : [];
    }));
    const shotUsage = kind === 'props' ? project.docs.storyboard.shots.flatMap((shot, shotIndex) => (shot.props || []).includes(asset.id) ? [{ episode: shot.episode || 1, sceneIndex: shotIndex + 1, lighting: '' }] : []) : [];
    return <div className="art-detail-page">
      <header className="art-detail-head"><div className="art-detail-title"><button className="character-back" onClick={() => go(`${root}/art`)}>{kind === 'scenes' ? '场景' : '道具'}</button><span>/</span><span className="character-code-badge">{asset.id}</span><h1>{asset.name}</h1>{kind === 'scenes' && asset.primary && <span className="character-role-badge">主场景</span>}{kind === 'props' && asset.scale && <span className="character-role-badge">{asset.scale}</span>}</div></header>
      <div className="art-detail-columns">
        <div className="art-detail-main">
          <section className="art-detail-section"><h2>基本信息</h2><div className="art-detail-fields"><Editable label="名称" value={asset.name} onSave={value => edit('name', value)}/>{kind === 'props' && <Editable label="尺度" value={asset.scale || ''} onSave={value => edit('scale', value)}/>}<Editable label="说明" value={asset.description} multiline onSave={value => edit('description', value)}/></div>{kind === 'scenes' && <div className="art-detail-primary"><span>主场景</span><strong>{asset.primary ? '是' : '否'}</strong></div>}</section>
          <section className="art-detail-section"><h2>一致性锚点</h2>{(asset.anchors || []).length ? (asset.anchors || []).map((anchor, anchorIndex) => <div className="art-anchor-row" key={`${anchor.name}-${anchorIndex}`}><Editable label={anchor.name} value={anchor.desc} multiline onSave={value => { const next = clone(project.docs.art); next[kind][index].anchors![anchorIndex].desc = value; save('art', next, '修改美术锚点'); }}/></div>) : <p className="character-detail-empty">暂无一致性锚点</p>}</section>
          <section className="art-detail-section"><div className="art-state-section-head"><h2>{kind === 'scenes' ? '光照状态' : '状态'}</h2>{kind === 'scenes' && <button type="button" className="btn small art-state-add" title="添加光照状态" aria-label="添加光照状态" onClick={() => { const next = clone(project.docs.art); next.scenes[index].states ||= []; next.scenes[index].states!.push({ id: uid(), state: '新光照状态', prompt: '', added: true }); save('art', next, `添加${asset.name}光照状态`); }}>+</button>}</div>{(asset.states || []).length ? (asset.states || []).map((state, stateIndex) => { const stateAsset: ArtAsset = { ...asset, name: `${asset.name} · ${state.state}`, image: state.image, prompt: state.prompt }; const stateReferences = state.referenceImages || []; const canDeleteState = state.added || state.state === '新光照状态'; const reorderStateReferences = (fromIndex: number, toIndex: number) => { const references = [...stateReferences]; const [moved] = references.splice(fromIndex, 1); references.splice(toIndex, 0, moved); const next = clone(project.docs.art); next[kind][index].states![stateIndex].referenceImages = references; save('art', next, `调整${asset.name}${state.state}引用图顺序`); }; return <div className="character-state-item panel" key={state.id || `${state.state}-${stateIndex}`}>
            <div className="character-state-heading"><Editable className="art-state-name" hideLabel label="状态名称" value={state.state} copy={false} onSave={value => { const next = clone(project.docs.art); next[kind][index].states![stateIndex].state = value; save('art', next, `修改${asset.name}状态名称`); }}/>{canDeleteState && <button type="button" className="icon-button art-state-remove delete-icon-button" title="删除新增的状态" aria-label={`删除${state.state}`} onClick={() => setStateDeleteIndex(stateIndex)}>×</button>}</div>
            <div className="art-state-row character-state-row"><section className="panel art-state-image-panel"><div className="art-state-image-head"><div className="art-state-image-controls">{media(stateAsset, 'image', true, 'state', asset.image, stateIndex)}</div></div>{state.image ? <button type="button" className="art-state-image-preview" onClick={() => openImage(state.image!)} title={`查看${state.state}图片`}><img src={state.image} alt={`${asset.name} · ${state.state}`}/></button> : <div className="art-state-image-empty">尚未生成{asset.name}{state.state}</div>}<div className="art-state-image-actions"><button className="btn small" disabled={!state.image} onClick={() => addToLibrary?.({ id: `${asset.id}-state-${state.id || stateIndex}`, type: asset.type, name: `${asset.name} · ${state.state}`, description: asset.description, prompt: state.prompt, image: state.image })}>加入资产库</button>{renderImagePicker?.(state.image, url => { const next = clone(project.docs.art); next[kind][index].states![stateIndex].image = url; save('art', next, `设置${asset.name}${state.state}图片`); })}</div></section><div className="art-state-content"><Editable label="提示词" value={state.prompt} multiline onSave={value => { const next = clone(project.docs.art); next[kind][index].states![stateIndex].prompt = value; save('art', next, `修改${asset.name}状态`); }}
              /><div className="segment-shot-reference-head character-state-reference-head"><span>引用资产</span><button type="button" className="btn small segment-add-reference-button" title="添加引用" aria-label="添加引用" onClick={() => setArtReferenceStateIndex(stateIndex)}>＋</button></div><div className="segment-shot-references character-state-references">{stateReferences.map((reference, referenceIndex) => <div draggable onDragStart={event => { event.dataTransfer.setData('text/plain', String(referenceIndex)); event.dataTransfer.effectAllowed = 'move'; }} onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); const fromIndex = Number(event.dataTransfer.getData('text/plain')); if (Number.isInteger(fromIndex) && fromIndex !== referenceIndex) reorderStateReferences(fromIndex, referenceIndex); }} className={`segment-shot-reference segment-shot-reference-${reference.category === '角色' ? 'character' : reference.category === '场景' ? 'scene' : reference.category === '分镜图' ? 'storyboard' : reference.category === '道具' ? 'prop' : 'other'}`} key={`${reference.assetId}-${reference.image}`}><img src={reference.image} alt="" title="点击查看大图" onClick={() => openImage(reference.image)}/><small>{reference.category}</small><strong title={reference.name}>{reference.name}</strong><button type="button" className="segment-shot-reference-remove delete-icon-button" title="移除引用" aria-label={`移除引用：${reference.name}`} onClick={() => { const next = clone(project.docs.art); next[kind][index].states![stateIndex].referenceImages = stateReferences.filter((_, i) => i !== referenceIndex); save('art', next, `移除${asset.name}${state.state}引用图片`); }}>×</button></div>)}{!stateReferences.length && <span className="segment-shot-no-references">尚未引用图片</span>}</div></div></div>
            {artReferenceStateIndex === stateIndex && renderReferencePicker?.(stateReferences.map(reference => reference.image), (urls, assets) => { const next = clone(project.docs.art); next[kind][index].states![stateIndex].referenceImages = stateReferencesFromAssets(urls, assets); save('art', next, `修改${asset.name}${state.state}引用图片`); }, () => setArtReferenceStateIndex(null))}
          </div>; }) : <p className="character-detail-empty">暂无状态设定</p>}{stateDeleteIndex !== null && <ConfirmDelete title="删除光照状态" label={asset.states?.[stateDeleteIndex]?.state || '新光照状态'} onCancel={() => setStateDeleteIndex(null)} onConfirm={() => { const next = clone(project.docs.art); const states = next[kind][index].states; if (states?.[stateDeleteIndex]) { states.splice(stateDeleteIndex, 1); save('art', next, `删除${asset.name}新增光照状态`); } setStateDeleteIndex(null); }}/>}</section>
        </div>
        <aside className="art-detail-side">
          <ArtImagePanel asset={asset} settingPrompt={settingPrompt} media={media} openImage={openImage} addToLibrary={addToLibrary} renderImagePicker={renderImagePicker} onEdit={edit} label={kind === 'scenes' ? '场景' : '道具'}/>
          <section className="panel art-prompt-panel"><h2>出图提示词</h2><div className="art-detail-fields"><Editable label="主视角提示词" value={asset.prompt || asset.description} multiline onSave={value => edit('prompt', value)}/><Editable label="设定图提示词" value={settingPrompt} multiline onSave={value => edit('settingPrompt', value)}/><Editable label="反向提示词" value={asset.negativePrompt || ''} multiline onSave={value => edit('negativePrompt', value)}/></div></section>
        </aside>
      </div>
      <section className="art-detail-section art-usage-section"><h2>用在哪</h2>{usage.length || shotUsage.length ? <div className="panel art-usage-table"><table><thead>{kind === 'scenes' ? <tr><th>分镜</th><th>光照</th></tr> : <tr><th>集</th><th>镜头</th><th>引用位置</th></tr>}</thead><tbody>{kind === 'scenes' ? <ExpandableTableRows items={usage} colSpan={2} renderRow={(item, usageIndex) => { const target = sceneStoryboardTarget(project, item.episode, item.sceneIndex, item.sceneId); return <tr key={`${item.episode}-${item.sceneIndex}-${usageIndex}`}><td><button className="detail-link art-usage-storyboard-link" title={`跳转到${target.label}`} onClick={() => go(target.path)}>{target.label}</button></td><td>{item.lighting || '—'}</td></tr>; }}/> : <ExpandableTableRows items={[...usage, ...shotUsage]} colSpan={3} renderRow={(item, usageIndex) => <tr key={`${item.episode}-${item.sceneIndex}-${usageIndex}`}><td><button className="detail-link" onClick={() => go(`${root}/script/${item.episode}`)}>E{String(item.episode).padStart(2, '0')}</button></td><td>#{item.sceneIndex}</td><td>{item.lighting || '—'}</td></tr>}/>}</tbody></table></div> : <p className="character-detail-empty">当前还没有剧本或分镜引用此{kind === 'scenes' ? '场景' : '道具'}。</p>}</section>
    </div>;
  }
  if (tab === 'storyboard' && detail[0]) {
    const episode = Number(detail[0]); const segment = detail[1]; const shots = project.docs.storyboard.shots.filter(s => (s.episode || 1) === episode && (!segment || (s.segmentId || '未分段') === segment));
    if (!project.docs.script.episodes[episode - 1] && !project.docs.outline.episodes[episode - 1] && !shots.length) return <div className="empty-page">找不到这一集</div>;
    const total = shots.reduce((n, s) => n + s.duration, 0);
    const groups = Array.from(new Set(shots.map(s => s.segmentId || '未分段')));
    return <div className="storyboard-episode-page"><div className="storyboard-episode-head"><div><div className="eyebrow">分镜 · 第 {episode} 集</div><h1>第 {episode} 集</h1><p>{groups.length} 段 · {shots.length} 镜 · {total.toFixed(1)}s / {project.docs.script.episodes[episode - 1]?.duration || '—'}s</p></div><button className="btn" onClick={() => go(`${root}/storyboard`)}>返回全剧总表</button></div>{shots.length ? <div className="storyboard-segment-grid">{groups.map((group, groupIndex) => { const segmentShots = shots.filter(s => (s.segmentId || '未分段') === group); const duration = segmentShots.reduce((sum, shot) => sum + shot.duration, 0); const path = `${root}/storyboard/${episode}/${encodeURIComponent(group)}`; return <button className="panel storyboard-segment-card" key={group} onClick={() => go(path)}><div className="storyboard-segment-card-head"><span>段 {String(groupIndex + 1).padStart(2, '0')}</span><strong>{group}</strong><em>{duration.toFixed(1)}s · {segmentShots.length} 镜</em></div><div className="storyboard-segment-thumbs">{segmentShots.slice(0, 3).map((shot, i) => <div key={shot.id}>{shot.image ? <img src={shot.image} alt={`镜头 ${i + 1}`}/> : <span>{String(i + 1).padStart(2, '0')}</span>}</div>)}{segmentShots.length > 3 && <div className="storyboard-thumb-more">+{segmentShots.length - 3}</div>}</div><p>{segmentShots[0]?.scene || '尚未填写场景'} · {segmentShots[0]?.framing || '景别待定'}</p><span className="storyboard-segment-open">打开分段制作 →</span></button>; })}</div> : <div className="empty-state"><div className="empty-icon">▥</div><h2>这一集暂无分镜</h2><p>生成或导入分镜后，镜头会按分段显示在这里。</p></div>}</div>;
  }
  return null;
}

function ExpandableTableRows<T>({ items, colSpan, renderRow }: { items: T[]; colSpan: number; renderRow: (item: T, index: number) => ReactNode }) {
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? items : items.slice(0, 10);
  return <>{visible.map(renderRow)}{items.length > 10 && <tr className="usage-expand-row"><td colSpan={colSpan}><button type="button" className="btn small" onClick={() => setExpanded(value => !value)}>{expanded ? '收起' : `展开全部 ${items.length} 条`}</button></td></tr>}</>;
}

function CharacterDialogueBook({ project, go, character, voiceover = false, onSaveAudio }: { project: Project; go: Props['go']; character?: Character; voiceover?: boolean; onSaveAudio?: (version: CharacterAudioVersion) => void }) {
  const report = useScriptDialogueReport(project.id);
  const group = report.status === 'ready' ? voiceover ? voiceoverDialogueGroup(report.groups) : character ? characterDialogueGroup(report.groups, character) : undefined : undefined;
  const [audioOpen, setAudioOpen] = useState(false);
  return <section className="character-detail-section character-dialogue-section">
    <div className="character-dialogue-head"><div><h2>台词本</h2>{group?.metadata && <span>{group.metadata}</span>}</div>{group && <div className="character-dialogue-actions">{!voiceover && onSaveAudio && !!group.lines.length && <button className="btn small primary" onClick={() => setAudioOpen(true)}>生成语音</button>}{group.copyAll && <button type="button" className="copy-prompt-button" title="复制全部台词" aria-label="复制全部台词" onClick={() => void copyText(group.copyAll!)}><CopyPromptIcon/></button>}</div>}</div>
    {dialogueEmptyState(report, group, voiceover ? '剧本数据中暂无画外音台词。' : '剧本数据中暂无该角色的台词。')}
    {group && <ol className="character-dialogue-lines">{group.lines.map((line, index) => <li key={`${line.reference}-${index}`}><button type="button" className="character-dialogue-jump" title="查看对应分镜" onClick={() => go(dialogueStoryboardPath(project, line))}>{line.reference}</button><span>{line.text}</span><span className="character-dialogue-line-meta">{line.delivery && <em>{line.delivery}</em>}<small>{line.seconds.toFixed(1)}s</small></span></li>)}</ol>}
    {audioOpen && group && character && onSaveAudio && <CharacterVoiceGenerator project={project} character={character} group={group} onSave={onSaveAudio} onClose={() => setAudioOpen(false)}/>}
  </section>;
}

function CharacterVoiceGenerator({ project, character, group, onSave, onClose }: { project: Project; character: Character; group: ScriptDialogueGroup; onSave: (version: CharacterAudioVersion) => void; onClose: () => void }) {
  const [description, setDescription] = useState(group.voicePrompt || '');
  const [lyrics, setLyrics] = useState(group.lines.map(line => line.text).join('\n'));
  const [duration, setDuration] = useState(60);
  const [job, setJob] = useState<MediaJob | null>(null);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const key = `reelbench-audio-${project.id}-${character.id}`;
  useEffect(() => {
    if (!job || !['queued', 'running'].includes(job.status)) return;
    const timer = window.setInterval(() => getMediaJob(job.id).then(setJob).catch(e => setError((e as Error).message)), 1500);
    return () => clearInterval(timer);
  }, [job?.id, job?.status]);
  useEffect(() => { const id = sessionStorage.getItem(key); if (id) getMediaJob(id).then(setJob).catch(() => sessionStorage.removeItem(key)); }, [key]);
  async function generate() {
    setError(''); if (!description.trim() || !lyrics.trim()) { setError('请填写音色描述和台词。'); return; }
    setSubmitting(true);
    try { const started = await createMediaJob({ projectId: project.id, kind: 'audio', prompt: description.trim(), lyrics: lyrics.trim(), duration }); setJob(started); sessionStorage.setItem(key, started.id); }
    catch (e) { setError((e as Error).message); }
    finally { setSubmitting(false); }
  }
  async function close() {
    if (job?.status === 'queued' || job?.status === 'running') await cancelMediaJob(job.id).catch(() => {});
    else if (job?.status === 'completed') await discardMediaJob(job.id).catch(() => {});
    sessionStorage.removeItem(key); onClose();
  }
  async function save() { if (!job?.result?.url) return; onSave({ id: uid(), url: job.result.url, generatedAt: job.result.generatedAt || Date.now(), prompt: description.trim(), lyrics: lyrics.trim(), duration }); sessionStorage.removeItem(key); onClose(); }
  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) void close(); }}><div className="modal character-audio-modal" role="dialog" aria-modal="true" aria-label="生成角色语音"><div className="modal-head"><div><span className="eyebrow">MINIMAX MUSIC 3</span><h2>生成「{character.name}」语音</h2></div><button className="icon-button" onClick={() => void close()}>×</button></div><div className="image-composer character-audio-composer"><label className="character-audio-field">音色与音乐描述<textarea value={description} disabled={!!job || submitting} onChange={event => setDescription(event.target.value)} placeholder="描述角色的音色、语气与背景音乐"/></label><label className="character-audio-field">台词<textarea value={lyrics} disabled={!!job || submitting} onChange={event => setLyrics(event.target.value)}/></label><div className="image-composer-footer"><label className="character-audio-duration">时长（秒）<input type="number" min="1" max="60" value={duration} disabled={!!job || submitting} onChange={event => setDuration(Math.max(1, Math.min(60, Number(event.target.value))))}/></label>{!job && <button className="btn primary" disabled={submitting} onClick={() => void generate()}>{submitting ? '正在提交…' : '↑ 生成语音'}</button>}</div>{job && <div className="media-job">{['queued', 'running'].includes(job.status) && <div className="media-job-loading" role="status"><span className="media-spinner"/><div className="media-job-status-copy"><strong>{job.status === 'queued' ? '等待生成' : '正在生成音频'}</strong><span>{job.message}</span></div><button className="btn small" onClick={() => void close()}>取消</button></div>}{job.status === 'failed' && <><p className="field-error">{job.error || '生成失败'}</p><button className="btn small" onClick={() => setJob(null)}>返回修改</button></>}{job.status === 'completed' && job.result && <><audio controls src={job.result.url}/><div className="inline-actions"><a className="btn small" href={job.result.url} download={`${character.name}-语音.mp3`}>下载音频</a><button className="btn small" onClick={() => { void discardMediaJob(job.id); sessionStorage.removeItem(key); setJob(null); }}>重新生成</button><button className="btn primary small" onClick={() => void save()}>保存到角色卡</button></div></>}</div>}{error && <small className="field-error">{error}</small>}</div></div></div>;
}

function CharacterAudioHistoryButton({ character, versions, activeId, onSelect }: { character: Character; versions: CharacterAudioVersion[]; activeId?: string; onSelect: (id?: string) => void }) {
  const [open, setOpen] = useState(false);
  return <>
    <button type="button" className="character-audio-history-button" onClick={() => setOpen(true)} title="查看语音生成历史" aria-label={`查看语音生成历史，共 ${versions.length} 条`}><span aria-hidden="true">◷</span>{versions.length}</button>
    {open && <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) setOpen(false); }}><div className="modal character-audio-history-modal" role="dialog" aria-modal="true" aria-label="语音生成历史"><div className="modal-head"><div><span className="eyebrow">AUDIO HISTORY</span><h2>{character.name} · 语音生成历史</h2></div><button className="icon-button" onClick={() => setOpen(false)}>×</button></div><div className="character-audio-history-list">{[...versions].reverse().map((version, index) => { const selected = activeId === version.id; return <article className={`character-audio-history-item${selected ? ' selected' : ''}`} key={version.id}><div className="character-audio-history-meta"><strong>语音 #{versions.length - index}{selected && <em>当前展示</em>}</strong><span>{version.generatedAt ? new Date(version.generatedAt).toLocaleString() : '历史语音'}</span></div><audio controls src={version.url}/>{version.lyrics && <p>{version.lyrics}</p>}{version.prompt && <small>{version.prompt}</small>}<div className="character-audio-history-actions"><a className="btn small" href={version.url} download={`${character.name}-语音-${versions.length - index}.mp3`}>下载</a><button className="btn small" disabled={selected} onClick={() => { onSelect(version.id); setOpen(false); }}>{selected ? '已放到外面' : '放到外面'}</button></div></article>; })}</div></div></div>}
  </>;
}

function dialogueEmptyState(report: ScriptDialogueReport, group: ScriptDialogueGroup | undefined, emptyMessage: string) {
  if (report.status === 'loading') return <p className="character-detail-empty">正在读取剧本 JSON…</p>;
  if (report.status === 'error') return <p className="character-detail-empty">无法读取项目剧本 JSON，台词本暂不可用。</p>;
  if (!group || !group.lines.length) return <p className="character-detail-empty">{emptyMessage}</p>;
  return null;
}

function VoiceoverCharacterDetail({ project, go }: { project: Project; go: Props['go'] }) {
  return <div className="character-detail-page voiceover-character-page">
    <header className="character-detail-head"><div className="character-detail-title"><button className="character-back" onClick={() => go(`/p/${project.id}/cast`)}>角色</button><span>/</span><span className="character-code-badge">VO</span><h1>画外音</h1><span className="character-role-badge">虚拟角色</span></div><p>台词本读取自项目剧本 JSON。</p></header>
    <CharacterDialogueBook project={project} go={go} voiceover/>
  </div>;
}

function dialogueStoryboardPath(project: Project, line: ScriptDialogueGroup['lines'][number]) {
  const raw = project.skillArtifacts?.storyboard?.raw as { episodes?: { ep?: number; segments?: { id?: string; sceneIndex?: number }[] }[] } | undefined;
  const segment = raw?.episodes?.find(episode => (Number(episode.ep) || 1) === line.episode)?.segments?.find(item => item.sceneIndex === line.sceneIndex && item.id);
  if (segment?.id) return `/p/${project.id}/storyboard/${line.episode}/${encodeURIComponent(segment.id)}`;
  const shot = project.docs.storyboard.shots.find(item => (item.episode || 1) === line.episode && !!line.sceneId && item.sceneId === line.sceneId);
  return shot?.segmentId ? `/p/${project.id}/storyboard/${line.episode}/${encodeURIComponent(shot.segmentId)}` : `/p/${project.id}/storyboard/${line.episode}`;
}

function sceneStoryboardTarget(project: Project, episodeNumber: number, sceneIndex: number, sceneId?: string) {
  const raw = project.skillArtifacts?.storyboard?.raw as { episodes?: { ep?: number; segments?: { id?: string; sceneIndex?: number }[] }[] } | undefined;
  const segment = raw?.episodes?.find(episode => (Number(episode.ep) || 1) === episodeNumber)?.segments?.find(item => item.sceneIndex === sceneIndex && item.id);
  if (segment?.id) return { label: segment.id, path: `/p/${project.id}/storyboard/${episodeNumber}/${encodeURIComponent(segment.id)}` };
  const shot = project.docs.storyboard.shots.find(item => (item.episode || 1) === episodeNumber && !!sceneId && item.sceneId === sceneId);
  const segmentId = shot?.segmentId;
  return segmentId
    ? { label: segmentId, path: `/p/${project.id}/storyboard/${episodeNumber}/${encodeURIComponent(segmentId)}` }
    : { label: `E${String(episodeNumber).padStart(2, '0')}-${String(sceneIndex).padStart(2, '0')}`, path: `/p/${project.id}/storyboard/${episodeNumber}` };
}

function InlineEdit({ value, onSave, className = '', displayValue }: { value: string; onSave: (value: string) => void; className?: string; displayValue?: string }) {
  const [editing, setEditing] = useState(false); const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => { if (draft !== value) onSave(draft); setEditing(false); };
  return editing ? <textarea className={`script-inline-edit ${className}`} autoFocus value={draft} onChange={e => setDraft(e.target.value)} onBlur={commit} onKeyDown={e => { if (e.key === 'Escape') { setDraft(value); setEditing(false); } if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') commit(); }}/> : <span className={className} onDoubleClick={() => setEditing(true)} title="双击编辑">{(displayValue ?? value) || '\u00a0'}</span>;
}

function ScriptEpisodeDetail({ project, index, save, go }: { project: Project; index: number; save: Save; go: Props['go'] }) {
  const ep = project.docs.script.episodes[index];
  const all = ep.scenes.flatMap(scene => scene.beats.map((text, i) => ({ text, beat: scene.flow?.[i] })));
  const actual = all.reduce((sum, item) => sum + beatSeconds(item.beat, item.text), 0);
  const change = (mutate: (episode: typeof ep) => void, label: string) => { const next = clone(project.docs.script); mutate(next.episodes[index]); save('script', next, label); };
  const rawScript = project.skillArtifacts?.script?.raw as { episodes?: { ep?: number; hookBeat?: number[] }[] } | undefined;
  const rawEpisode = rawScript?.episodes?.find(item => item.ep === index + 1) || rawScript?.episodes?.[index];
  const hookBeat = rawEpisode?.hookBeat;
  const hookBeatLabel = hookBeat && hookBeat.length >= 2 ? `第 ${hookBeat[0]} 场第 ${hookBeat[1]} 拍兑现` : '';
  let number = 0;
  const [pendingDelete, setPendingDelete] = useState<{ kind: 'scene' | 'beat'; sceneIndex: number; beatIndex?: number; label: string } | null>(null);
return <div className="script-document"><div className="script-document-head"><div><div className="eyebrow">剧本 · 第 {index + 1} 集</div><div className="script-episode-title"><h1>{ep.title}</h1>{!!ep.beatsClaimed?.length && <div className="script-episode-beat-tags">{ep.beatsClaimed.map((tag, tagIndex) => <span key={`${tag}-${tagIndex}`}>{tag}</span>)}</div>}</div><p>{ep.scenes.length} 场 · {all.length} 节拍 · {all.filter(item => item.beat?.line).length} 台词 · {actual.toFixed(1)}s / {ep.duration}s</p></div><div className="script-header-actions"><button className="btn small" onClick={() => change(item => { item.scenes.push({ title: "新场景", location: "", description: "", beats: [] }); }, "新增剧本场景")}>＋ 场景</button><button className="btn small" onClick={() => go(`/p/${project.id}/storyboard/${index + 1}`)}>看分镜 →</button></div></div><div className="script-episode-notes"><div className="script-note-line"><b>开场钩子</b><span className="script-note-text">{ep.hook || '—'}</span>{hookBeatLabel && <span className="script-note-payoff">{hookBeatLabel}</span>}</div><div className="script-note-line"><b>结尾悬念</b><span className="script-note-text">{ep.ending || '—'}</span></div></div>{ep.scenes.map((scene, sceneIndex) => <section className="script-scene" key={sceneIndex}><div className="script-scene-head"><span>第 {sceneIndex + 1} 场</span>{(() => { const artScene = project.docs.art.scenes.find(item => item.id === scene.sceneId); const sceneName = project.docs.outline.scenes?.find(item => item.id === scene.sceneId)?.name || scene.title; return artScene ? <button type="button" className="script-scene-name-tag" onClick={() => go(`/p/${project.id}/art/scenes/${encodeURIComponent(artScene.id)}`)}>{sceneName}</button> : <em className="script-scene-name-tag">{sceneName}</em>; })()}{(scene.lighting || scene.location) && <small className="script-scene-place-tag">{scene.lighting || scene.location}</small>}<span className="script-scene-tags">{(scene.characters || []).map(id => { const character = project.docs.cast.find(item => item.id === id); return <button type="button" key={id} onClick={() => go(`/p/${project.id}/cast/${encodeURIComponent(character?.id || id)}`)}>{character?.name || id}</button>; })}</span><button className="script-scene-action" onClick={() => change(item => { const scene = item.scenes[sceneIndex]; scene.flow ||= scene.beats.map(action => ({ action })); scene.beats.push(""); scene.flow.push({ action: "", seconds: 1.5 }); }, "新增剧本节拍")}>＋ 节拍</button><button className="script-scene-action" onClick={() => setPendingDelete({ kind: 'scene', sceneIndex, label: `场次 ${sceneIndex + 1}：${scene.title}` })}>删除场景</button></div><div className="script-beats">{scene.beats.map((text, beatIndex) => { number += 1; const beat: ScriptBeat = scene.flow?.[beatIndex] || { action: text }; const shown = beat.line || beat.action || text; const row = number; const isHookBeat = rawEpisode?.hookBeat?.[0] === sceneIndex + 1 && rawEpisode?.hookBeat?.[1] === beatIndex + 1; return <div className={`script-beat${isHookBeat ? ' script-beat-hook' : ''}`} key={beatIndex}><span className="script-beat-number">{row}</span><div className="script-beat-voice"><span className="script-beat-speaker">{project.docs.cast.find(character => character.id === beat.speaker)?.name || beat.speaker || '\u00a0'}</span><InlineEdit className="script-beat-delivery" value={beat.delivery || ''} onSave={v => change(item => { const flow = item.scenes[sceneIndex].flow ||= item.scenes[sceneIndex].beats.map(action => ({ action } as ScriptBeat)); flow[beatIndex].delivery = v; }, '修改表演提示')}/></div><div className="script-beat-content"><InlineEdit className="script-beat-body" value={shown} onSave={v => change(item => { const changed = item.scenes[sceneIndex]; const flow = changed.flow ||= changed.beats.map(action => ({ action } as ScriptBeat)); if (flow[beatIndex].line !== undefined) flow[beatIndex].line = v; else flow[beatIndex].action = v; changed.beats[beatIndex] = v; }, '修改剧本节拍')}/>{isHookBeat && <span className="script-beat-hook-label">开场钩子</span>}</div><label className="script-beat-seconds"><input aria-label={`节拍 ${row} 时长`} type="number" min="0.5" max="30" step="0.1" value={beatSeconds(beat, text)} onChange={e => { const seconds = Number(e.target.value); if (!Number.isFinite(seconds) || seconds <= 0) return; change(item => { const flow = item.scenes[sceneIndex].flow ||= item.scenes[sceneIndex].beats.map(action => ({ action } as ScriptBeat)); flow[beatIndex].seconds = seconds; }, '修改节拍时长'); }}/><span>s</span></label><button className="script-beat-remove delete-icon-button" onClick={() => setPendingDelete({ kind: 'beat', sceneIndex, beatIndex, label: shown.slice(0, 70) || `第 ${row} 条节拍` })}><DeleteIcon/></button></div>; })}</div></section>)}{pendingDelete && <ConfirmDelete title={pendingDelete.kind === 'beat' ? '删除剧本节拍' : '删除剧本场景'} label={pendingDelete.label} onCancel={() => setPendingDelete(null)} onConfirm={() => { const item = pendingDelete; change(episode => { if (item.kind === 'scene') episode.scenes.splice(item.sceneIndex, 1); else { episode.scenes[item.sceneIndex].beats.splice(item.beatIndex!, 1); episode.scenes[item.sceneIndex].flow?.splice(item.beatIndex!, 1); } }, item.kind === 'beat' ? '删除剧本节拍' : '删除剧本场景'); setPendingDelete(null); }}/>}</div>;
}

function ConfirmDelete({ title, label, onCancel, onConfirm }: { title: string; label: string; onCancel: () => void; onConfirm: () => void }) {
  return <div className="modal-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) onCancel(); }}><div className="modal script-delete-dialog" role="alertdialog" aria-modal="true" aria-label={title}><div className="modal-head"><div><span className="eyebrow">确认操作</span><h2>{title}</h2></div><button className="icon-button" onClick={onCancel} aria-label="关闭">×</button></div><p>确定删除「{label}」？删除后无法直接恢复。</p><div className="modal-actions"><button className="btn" onClick={onCancel}>取消</button><button className="btn danger" onClick={onConfirm}>确认删除</button></div></div></div>;
}

export function ProjectMaterialTabs({ project, children, onPrompts, updateProject }: { project: Project; children: ReactNode; onPrompts: () => Promise<Project>; updateProject: (id: string, change: (project: Project) => Project) => void }) {
  const [tab, setTab] = useState<'images' | 'prompts' | 'videos'>('images');
  const [promptCategory, setPromptCategory] = useState<'全部' | '角色' | '场景' | '道具' | '分镜' | '模板'>('全部');
  const [loadingPrompts, setLoadingPrompts] = useState(false);
  const [templateDrafts, setTemplateDrafts] = useState<Record<string, { title: string; content: string }>>({});
  const [editingTemplate, setEditingTemplate] = useState<{ id: string; field: 'title' | 'content' } | null>(null);
  const promptData = project;
  const promptsLoaded = ['doc-cast', 'doc-art', 'doc-storyboard'].every(part => (project.loadedParts || []).includes(part));
  const templates = project.promptTemplates || [];
  const prompts = [
    ...promptData.docs.cast.map(c => ({ category: '角色' as const, name: c.name, text: c.imagePrompt || c.description })),
    ...promptData.docs.art.scenes.map(a => ({ category: '场景' as const, name: a.name, text: a.prompt || a.description })),
    ...promptData.docs.art.props.map(a => ({ category: '道具' as const, name: a.name, text: a.prompt || a.description })),
    ...promptData.docs.storyboard.shots.map((s, i) => ({ category: '分镜' as const, name: `${s.segmentId || `镜头 ${i + 1}`} · ${s.scene || ''}`, text: s.action }))
  ].filter(item => item.text.trim());
  const promptCategories = ['全部', '角色', '场景', '道具', '分镜', '模板'] as const;
  const visiblePrompts = promptCategory === '全部' ? prompts : prompts.filter(item => item.category === promptCategory);
  const promptCount = (category: typeof promptCategories[number]) => category === '全部' ? prompts.length + templates.length : category === '模板' ? templates.length : prompts.filter(item => item.category === category).length;
  const videos = project.assets.filter(a => a.video);
  async function openPrompts() { setLoadingPrompts(true); try { await onPrompts(); setTab('prompts'); } finally { setLoadingPrompts(false); } }
  const addTemplate = () => { const template = { id: uid(), title: '新建模板', content: '' }; updateProject(project.id, current => ({ ...current, promptTemplates: [...(current.promptTemplates || []), template] })); setTemplateDrafts(current => ({ ...current, [template.id]: { title: template.title, content: template.content } })); setEditingTemplate({ id: template.id, field: 'title' }); };
  const saveTemplate = (id: string) => { const draft = templateDrafts[id]; if (!draft?.title.trim()) return; updateProject(project.id, current => ({ ...current, promptTemplates: (current.promptTemplates || []).map(template => template.id === id ? { ...template, title: draft.title.trim(), content: draft.content } : template) })); };
  const deleteTemplate = (id: string) => { updateProject(project.id, current => ({ ...current, promptTemplates: (current.promptTemplates || []).filter(template => template.id !== id) })); setTemplateDrafts(current => { const next = { ...current }; delete next[id]; return next; }); };
  const showTemplates = promptCategory === '全部' || promptCategory === '模板';
  return <><div className="material-tabs"><button className={tab === 'images' ? 'active' : ''} onClick={() => setTab('images')}>图片素材 {project.assets.filter(a => a.image).length}</button><button className={tab === 'prompts' ? 'active' : ''} disabled={loadingPrompts} onClick={() => void openPrompts()}>{loadingPrompts ? '正在读取提示词…' : `提示词素材 ${promptsLoaded ? prompts.length + templates.length : ''}`}</button><button className={tab === 'videos' ? 'active' : ''} onClick={() => setTab('videos')}>视频素材 {videos.length}</button></div>{tab === 'images' && children}{tab === 'prompts' && <div className="material-prompts"><div className="material-prompt-categories" role="tablist" aria-label="提示词分类">{promptCategories.map(category => <button type="button" role="tab" aria-selected={promptCategory === category} className={promptCategory === category ? 'active' : ''} key={category} onClick={() => setPromptCategory(category)}>{category} {promptCount(category)}</button>)}</div>{promptCategory !== '模板' && visiblePrompts.map((item, i) => <section className="panel" key={`${item.category}-${item.name}-${i}`}><div className="section-heading"><h2>{item.category} · {item.name}</h2><button className="copy-prompt-button" onClick={() => void copyText(item.text)} title="复制提示词" aria-label="复制提示词"><CopyPromptIcon/></button></div><p>{item.text}</p></section>)}{showTemplates && <section className="material-template-section"><div className="section-heading"><h2>自定义模板</h2><button type="button" className="btn small" onClick={addTemplate}>＋ 新增提示词</button></div>{templates.map(template => { const draft = templateDrafts[template.id] || { title: template.title, content: template.content }; const editingTitle = editingTemplate?.id === template.id && editingTemplate.field === 'title'; const editingContent = editingTemplate?.id === template.id && editingTemplate.field === 'content'; const commit = () => { saveTemplate(template.id); setEditingTemplate(null); }; return <article className="panel material-template-card" key={template.id}><button type="button" className="material-template-delete" aria-label={`删除模板 ${draft.title}`} title="删除模板" onClick={() => deleteTemplate(template.id)}>×</button><div className="section-heading"><div className="material-template-title">{editingTitle ? <input autoFocus aria-label="模板标题" value={draft.title} onChange={event => setTemplateDrafts(current => ({ ...current, [template.id]: { ...draft, title: event.target.value } }))} onBlur={commit} onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); }}/> : <h2 title="双击编辑标题" onDoubleClick={() => setEditingTemplate({ id: template.id, field: 'title' })}>{draft.title}</h2>}</div><button className="copy-prompt-button" onClick={() => void copyText(draft.content)} title="复制提示词" aria-label="复制提示词" disabled={!draft.content.trim()}><CopyPromptIcon/></button></div>{editingContent ? <textarea autoFocus className="material-template-content-editor" aria-label={`${draft.title}内容`} value={draft.content} onChange={event => setTemplateDrafts(current => ({ ...current, [template.id]: { ...draft, content: event.target.value } }))} onBlur={commit}/> : <p title="双击编辑内容" onDoubleClick={() => setEditingTemplate({ id: template.id, field: 'content' })}>{draft.content || <em>双击添加模板内容</em>}</p>}</article>; })}{!templates.length && <p className="detail-empty">还没有自定义模板，点击“新增提示词”创建。</p>}</section>}{promptCategory !== '模板' && !visiblePrompts.length && !templates.length && <div className="detail-empty">暂无提示词</div>}</div>}{tab === 'videos' && <div className="asset-grid">{videos.length ? videos.map(asset => <section className="panel" key={asset.id}><video src={asset.video} controls preload="metadata" style={{ width: '100%' }}/><h2>{asset.name}</h2><p>{asset.description}</p></section>) : <div className="detail-empty">暂无视频素材</div>}</div>}</>;
}

export function ProjectOutlineSummary({ project, go }: Pick<Props, 'project' | 'go'>) {
  const root = `/p/${project.id}`;
  const characters = project.docs.outline.characters || project.docs.cast.map(c => ({ id: c.id, name: c.name, role: c.role, arc: c.arc, source: '' }));
  const scenes = project.docs.outline.scenes || project.docs.art.scenes.map(a => ({ id: a.id, name: a.name, primary: !!a.primary }));
  return <div className="outline-summary"><section className="panel"><h2>角色表</h2><table className="detail-table"><thead><tr><th>ID</th><th>姓名</th><th>定位</th><th>弧光</th><th>来源</th></tr></thead><tbody>{characters.map((c, i) => <tr key={c.id || i}><td>{c.id}</td><td><button className="detail-link" onClick={() => go(`${root}/cast/${encodeURIComponent(project.docs.cast.find(item => item.name === c.name)?.id || c.name)}`)}>{c.name}</button></td><td>{c.role}</td><td>{c.arc}</td><td>{c.source}</td></tr>)}</tbody></table>{!characters.length && <p className="detail-empty">暂无角色</p>}</section><section className="panel"><h2>场景表</h2><table className="detail-table"><thead><tr><th>ID</th><th>名称</th><th>主场景</th></tr></thead><tbody>{scenes.map((s, i) => <tr key={s.id || i}><td>{s.id}</td><td><button className="detail-link" onClick={() => go(`${root}/art/scenes/${encodeURIComponent(s.id)}`)}>{s.name}</button></td><td>{s.primary ? '主' : '—'}</td></tr>)}</tbody></table>{!scenes.length && <p className="detail-empty">暂无场景</p>}</section><section className="panel"><h2>分集</h2><table className="detail-table"><thead><tr><th>集</th><th>梗概</th><th>钩子</th></tr></thead><tbody>{project.docs.outline.episodes.map((ep, i) => <tr key={i}><td><button className="detail-link" onClick={() => go(`${root}/outline/episodes/${i + 1}`)}>E{i + 1}</button></td><td>{ep.summary}</td><td>{ep.hook}</td></tr>)}</tbody></table></section></div>;
}

export function ProjectStoryboardSummary({ project, go }: Pick<Props, 'project' | 'go'>) {
  const episodes = Array.from({ length: Math.max(project.docs.script.episodes.length, project.docs.outline.episodes.length, ...project.docs.storyboard.shots.map(s => s.episode || 1), 0) }, (_, index) => index + 1);
  const allShots = project.docs.storyboard.shots;
  const allDuration = allShots.reduce((sum, shot) => sum + shot.duration, 0);
  return <div className="storyboard-overview"><div className="storyboard-overview-heading"><div><div className="eyebrow">STORYBOARD · 节奏与覆盖</div><h1>全剧分镜</h1><p>{episodes.length} 集 · {allShots.length} 镜 · {allDuration.toFixed(1)} 秒</p></div></div><section className="panel storyboard-summary"><div className="storyboard-table-heading"><h2>节奏与覆盖</h2><span>时长和镜数根据当前镜头实时汇总</span></div>{episodes.length ? <table className="detail-table"><thead><tr><th>集</th><th>分段</th><th>镜头</th><th>总时长</th><th>平均镜长</th><th>剧本目标</th><th></th></tr></thead><tbody>{episodes.map(ep => { const shots = project.docs.storyboard.shots.filter(s => (s.episode || 1) === ep); const duration = shots.reduce((n, s) => n + s.duration, 0); const segments = new Set(shots.map(s => s.segmentId || '未分段')); const target = project.docs.script.episodes[ep - 1]?.duration; return <tr key={ep}><td><button className="detail-link" onClick={() => go(`/p/${project.id}/storyboard/${ep}`)}>第 {ep} 集</button></td><td>{segments.size}</td><td>{shots.length}</td><td>{duration.toFixed(1)}s</td><td>{shots.length ? (duration / shots.length).toFixed(1) : 0}s</td><td>{target ? `${target}s` : '—'}</td><td><button className="detail-link" onClick={() => go(`/p/${project.id}/storyboard/${ep}`)}>查看分段 →</button></td></tr>; })}</tbody></table> : <p className="detail-empty">暂无分镜或分集数据。生成分镜后将在这里显示。</p>}</section></div>;
}
