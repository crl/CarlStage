import { useEffect, useState } from 'react';
import type { Character } from './model';

export type ScriptDialogueLine = { reference: string; episode: number; sceneIndex: number; sceneId?: string; text: string; delivery: string; seconds: number };
export type ScriptDialogueGroup = { id: string; name: string; metadata: string; voicePrompt?: string; copyAll: string; lines: ScriptDialogueLine[] };
export type ScriptDialogueReport = { status: 'loading' } | { status: 'error' } | { status: 'ready'; groups: ScriptDialogueGroup[] };

type RecordValue = Record<string, unknown>;
const isRecord = (value: unknown): value is RecordValue => typeof value === 'object' && value !== null && !Array.isArray(value);
const asString = (value: unknown) => typeof value === 'string' ? value.trim() : '';

export function buildScriptDialogueGroups(script: unknown, outline: unknown, cast: unknown): ScriptDialogueGroup[] {
  if (!isRecord(script) || !Array.isArray(script.episodes)) return [];
  const outlineCharacters = isRecord(outline) && Array.isArray(outline.characters) ? outline.characters.filter(isRecord) : [];
  const castCharacters = isRecord(cast) && Array.isArray(cast.characters) ? cast.characters.filter(isRecord) : Array.isArray(cast) ? cast.filter(isRecord) : [];
  const characterNames = new Map<string, string>();
  for (const character of outlineCharacters) {
    const id = asString(character.id);
    const name = asString(character.name);
    if (id && name) characterNames.set(id, name);
  }
  for (const [index, character] of castCharacters.entries()) {
    const id = asString(character.id) || `C${String(index + 1).padStart(2, '0')}`;
    const name = asString(character.name);
    if (id && name && !characterNames.has(id)) characterNames.set(id, name);
  }
  const voicePrompts = new Map<string, string>();
  for (const character of castCharacters) {
    const name = asString(character.name);
    const prompt = isRecord(character.voice) ? asString(character.voice.prompt) : '';
    if (name && prompt) voicePrompts.set(name, prompt);
  }
  const charsPerSecond = isRecord(script.params) && typeof script.params.charsPerSecond === 'number' && script.params.charsPerSecond > 0 ? script.params.charsPerSecond : 4.5;
  const groups = new Map<string, ScriptDialogueGroup>();
  for (const [episodeIndex, episode] of script.episodes.entries()) {
    if (!isRecord(episode) || !Array.isArray(episode.scenes)) continue;
    const rawEpisode = Number(episode.ep) || episodeIndex + 1;
    const episodeLabel = `E${String(rawEpisode).padStart(2, '0')}`;
    for (const [sceneIndex, scene] of episode.scenes.entries()) {
      if (!isRecord(scene) || !Array.isArray(scene.flow)) continue;
      for (const beat of scene.flow) {
        if (!isRecord(beat) || !asString(beat.line)) continue;
        const id = asString(beat.speaker) || '未知';
        const name = id === 'VO' ? '画外音' : characterNames.get(id) || id;
        const group = groups.get(id) || { id, name, metadata: '', voicePrompt: voicePrompts.get(name), copyAll: '', lines: [] };
        const text = asString(beat.line);
        const seconds = typeof beat.seconds === 'number' && Number.isFinite(beat.seconds) && beat.seconds > 0 ? beat.seconds : Math.max(0.1, [...text.replace(/\s/g, '')].length / charsPerSecond);
        group.lines.push({ reference: `${episodeLabel} 第 ${sceneIndex + 1} 场`, episode: rawEpisode, sceneIndex: sceneIndex + 1, sceneId: asString(scene.sceneId) || undefined, text, delivery: asString(beat.delivery), seconds });
        groups.set(id, group);
      }
    }
  }
  return [...groups.values()].map(group => {
    const charCount = group.lines.reduce((total, line) => total + [...line.text.replace(/\s/g, '')].length, 0);
    const duration = (charCount / charsPerSecond).toFixed(1);
    const copyAll = group.lines.map(line => line.text).join('\n');
    return { ...group, metadata: `${group.lines.length} 句 · ${charCount} 字 · 约 ${duration} 秒`, copyAll };
  });
}

export function useScriptDialogueReport(projectId: string): ScriptDialogueReport {
  const [report, setReport] = useState<ScriptDialogueReport>({ status: 'loading' });
  useEffect(() => {
    const controller = new AbortController();
    setReport({ status: 'loading' });
    const readJson = async (file: string, optional = false): Promise<unknown> => {
      const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/proj/${file}`, { cache: 'no-store', signal: controller.signal });
      if (optional && response.status === 404) return null;
      if (!response.ok) throw new Error('项目 JSON 不可用');
      return response.json();
    };
    Promise.all([readJson('script.json'), readJson('outline.json', true), readJson('cast.json', true)])
      .then(([script, outline, cast]) => setReport({ status: 'ready', groups: buildScriptDialogueGroups(script, outline, cast) }))
      .catch(() => { if (!controller.signal.aborted) setReport({ status: 'error' }); });
    return () => controller.abort();
  }, [projectId]);
  return report;
}

export function characterDialogueGroup(groups: ScriptDialogueGroup[], character: Character): ScriptDialogueGroup | undefined {
  const names = new Set([character.name, character.id, ...(character.aliases || [])].map(value => value.trim()).filter(Boolean));
  return groups.find(group => names.has(group.id) || names.has(group.name));
}

export function voiceoverDialogueGroup(groups: ScriptDialogueGroup[]): ScriptDialogueGroup | undefined {
  return groups.find(group => group.id === 'VO' || ['画外音', 'VO', 'V.O.'].includes(group.name.trim()));
}
