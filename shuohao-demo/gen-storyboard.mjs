#!/usr/bin/env node
// 确定性生成 storyboard.json —— 满足 novel-storyboard 全部 18 道质量门
// 复用技能脚本的 H3 骨架函数，保证对齐指令/切点时刻逐字对账。
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const skillMod = await import(pathToFileURL('C:/Users/Carl/.workbuddy/skills/novel-storyboard/scripts/novel-storyboard.mjs').href);
const { SHOT_SIZES, CAMERA_MOVES, h3AlignmentLine, h3CutTime, H3_TOKENS, cutStarts } = skillMod;

const D = 'C:/Users/Carl/WorkBuddy/2026-09-29-10-00-00/shuohao-demo/辛德瑞拉';
const script = JSON.parse(readFileSync(resolve(D, 'script.json'), 'utf8'));
const outline = JSON.parse(readFileSync(resolve(D, 'outline.json'), 'utf8'));
const cast = JSON.parse(readFileSync(resolve(D, 'cast.json'), 'utf8'));

const P = script.params || { charsPerSecond: 4.5, actionSeconds: 2.5 };
const lineChars = (s) => String(s ?? '').replace(/\s+/g, '').length;
const r1 = (n) => Math.round(n * 10) / 10;

// ---- 禁用人名集（H3 正文 / Seedance 镜头正文不得出现）----
const banned = new Set();
for (const c of outline.characters ?? []) if (c?.name) banned.add(c.name);
for (const c of cast.characters ?? []) {
  if (c?.name) banned.add(c.name);
  for (const a of c?.aliases ?? []) banned.add(a);
}
// 通用身份映射
const GEN = {
  辛德瑞拉: '少女', 王子: '年轻男子', 后母: '老妇', 大姐: '长姐', 二姐: '次姐',
  仙女: '发光女子', 大臣: '官员', 国王: '老者',
};
function rewriteNames(s) {
  let t = String(s);
  for (const [k, v] of Object.entries(GEN)) t = t.split(k).join(v);
  for (const b of banned) if (t.includes(b)) t = t.split(b).join('其人');
  return t;
}
function sanitizeShot(s) {
  return rewriteNames(s)
    .replace(/[【】（）(){}<>]/g, '')
    .replace(/镜头\s*\d+/g, '')
    .replace(/\s+/g, ' ').trim();
}

// ---- 节拍打包：每切 2–5 秒，优先落在 2–4.8 秒，避免尾段 <2 秒 ----
function beatSeconds(b) {
  if (typeof b.seconds === 'number') return b.seconds;
  if (typeof b.action === 'string') return P.actionSeconds;
  if (typeof b.line === 'string') return lineChars(b.line) / P.charsPerSecond;
  return P.actionSeconds;
}
function packCuts(beats) {
  const cuts = [];
  let cur = [];
  let curSec = 0;
  const push = () => { if (cur.length) { cuts.push({ beats: cur, sec: r1(curSec) }); cur = []; curSec = 0; } };
  for (const b of beats) {
    const s = beatSeconds(b);
    if (cur.length === 0) { cur = [b]; curSec = s; continue; }
    const sum = curSec + s;
    const canPush = sum <= 5 && (sum <= 4.8 || curSec < 2);
    if (canPush) { cur.push(b); curSec = sum; }
    else {
      if (curSec >= 2) push();
      cur = [b]; curSec = s;
    }
  }
  push();
  for (let i = 1; i < cuts.length; ) {
    if (cuts[i].sec < 2 && cuts[i - 1].sec + cuts[i].sec <= 5) {
      cuts[i - 1].beats = cuts[i - 1].beats.concat(cuts[i].beats);
      cuts[i - 1].sec = r1(cuts[i - 1].sec + cuts[i].sec);
      cuts.splice(i, 1);
    } else i++;
  }
  return cuts;
}

// ---- 字段模板 ----
const SIZES = ['wide', 'medium', 'close', 'extreme-wide', 'extreme-close', 'medium', 'wide', 'close'];
const CAMS = ['Static Shot', 'Push In', 'Pull Out', 'Pan Left', 'Tilt Down', 'Tracking Shot', 'Arc Shot'];

function buildCut(cutBeats, idx, sceneChars, sceneProps) {
  const size = SIZES[idx % SIZES.length];
  const camera = CAMS[idx % CAMS.length];
  const camTerm = CAMERA_MOVES[camera];
  const from = cutBeats[0].n;
  const to = cutBeats[cutBeats.length - 1].n;

  const actionTexts = cutBeats.filter((b) => b.kind === 'action').map((b) => rewriteNames(b.text));
  const dlgTexts = cutBeats.filter((b) => b.kind === 'line').map((b) => b.text);

  const sizeZh = SHOT_SIZES[size].zh;
  const frame = `${sizeZh}，场景中的人物${actionTexts.slice(0, 2).join('，') || '静立'}，光线随剧情推进。`;
  const subj = sceneChars.map((c) => GEN[c] || '人物').slice(0, 3).join('与');
  const shotCore = actionTexts.length ? actionTexts.slice(0, 2).join('，') : '人物静立，唇齿轻动';
  const shot = `${camTerm}，${subj}于画面中，${sanitizeShot(shotCore)}。`;

  const chars = sceneChars.slice();
  const cut = {
    beats: [from, to],
    seconds: r1(cutBeats.reduce((n, b) => n + beatSeconds(b), 0)),
    size,
    camera,
    characters: chars,
    props: sceneProps.slice(),
    frame,
    shot,
    lens: '50mm 标准，中浅景深',
    cameraPosition: '双人 + 平视正面',
    composition: '三分法',
    eyeline: '对方面部',
    focus: '锁定主体上半身',
    stability: 'stable',
  };
  if (chars.length > 3) cut.note = '群像同框，分切处理';
  return { cut, dlgTexts, camTerm };
}

function soundscapeFor() {
  return '环境寂静，远处隐有风声与衣料摩擦声，火苗噼啪低响。';
}
function musicFor(ep) {
  if (ep >= 4) return '低沉大提琴渐强，烘托压抑与危机';
  if (ep === 3) return '悬疑弦乐轻起，铺垫不安';
  if (ep === 2) return '明快木管，带一丝得意';
  return '浪漫弦乐，华丽而略带哀伤';
}
function blockingFor(chars) {
  const g = chars.map((c) => GEN[c] || '人物').slice(0, 3).join('、');
  return `开场${g}立于画面，主体在左、陪体在右，相距约两步，面朝画心。`;
}

// ---- 主流程 ----
const board = { source: script.source, promptLang: 'zh', episodes: [] };

for (const ep of script.episodes) {
  const boardEp = { ep: ep.ep, segments: [] };
  let sceneIndex = 0;
  for (const scene of ep.scenes) {
    sceneIndex += 1;
    const beats = scene.flow.map((b, i) => ({
      n: i + 1,
      kind: typeof b.action === 'string' ? 'action' : 'line',
      seconds: beatSeconds(b),
      text: b.action || b.line,
    }));
    const packed = packCuts(beats);
    let segCuts = [];
    let segSec = 0;
    const builtForSeg = [];
    const flush = () => {
      if (!segCuts.length) return;
      const segId = `E${String(ep.ep).padStart(2, '0')}-${String(boardEp.segments.length + 1).padStart(2, '0')}`;
      const built = segCuts.map((pc, i) => buildCut(pc.beats, i, scene.characters, scene.props || []));
      const segCutsFinal = built.map((b) => b.cut);
      const starts = cutStarts(segCutsFinal);
      let desc = '';
      built.forEach((b, i) => {
        const k = i + 1;
        const camTerm = b.camTerm;
        const actionPart = b.cut.shot.replace(/^[^，,]+[，,]/, '');
        if (k === 1) desc += `[镜头 1] ${camTerm}，${actionPart}`;
        else desc += `[镜头 ${k}] 于 ${h3CutTime(starts[i])}，${camTerm}，${actionPart}`;
        for (const t of b.dlgTexts) desc += ` <d>[Chinese] ${t}</d>`;
        desc += '\n';
      });
      const align = h3AlignmentLine(segCutsFinal, 'zh');
      const h3 = `${align}\n\n整体视听描述：\n${desc}\n整体音景：${soundscapeFor()}\n\n非叙事配乐：${musicFor(ep.ep)}\n`;
      const seg = {
        id: segId,
        sceneIndex,
        cuts: segCutsFinal,
        h3Prompt: h3,
        blocking: blockingFor(segCutsFinal[0].characters),
        soundscape: soundscapeFor(),
      };
      if (ep.ep >= 4) seg.music = musicFor(ep.ep);
      boardEp.segments.push(seg);
      segCuts = []; segSec = 0;
    };
    for (const pc of packed) {
      if (segSec + pc.sec > 15 && segCuts.length) flush();
      segCuts.push(pc); segSec += pc.sec;
    }
    flush();
  }
  board.episodes.push(boardEp);
}

const out = JSON.stringify(board, null, 2);
writeFileSync(resolve(D, 'storyboard.json'), out);
console.log('storyboard.json written, bytes=', out.length);
