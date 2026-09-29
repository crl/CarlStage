// 把 _scheme.json（buildPrompt 产出）渲染成可读的提示词方案：HTML + Markdown
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const D = 'C:/Users/Carl/WorkBuddy/2026-09-29-10-00-00/shuohao-demo/辛德瑞拉';
const scheme = JSON.parse(readFileSync(join(D, 'character-refs', '_scheme.json'), 'utf8'));

const VIEW_LABEL = { 'front-full': '正面全身（锚点）', 'face-front': '正脸大头照', 'side-full': '侧面 90°', 'back-full': '背面' };
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let html = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>角色提示词方案 · 灰姑娘·殉葬（暗黑反转）</title>
<style>
:root{--bg:#f2f2ef;--ink:#1c1f22;--ink2:#5f666c;--rule:#d4d6d1;--card:#fff;--accent:#7a4fb5}
body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.6 system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif}
main{max-width:1100px;margin:0 auto;padding:24px 16px 56px}
h1{font-size:21px;margin:0 0 4px}.lead{color:var(--ink2);margin:0 0 8px}
.warn{background:#fff7e6;border:1px solid #f0d28a;color:#7a5a12;padding:8px 12px;border-radius:4px;font-size:12px;margin:0 0 24px}
.set{margin:0 0 32px;background:var(--card);border:1px solid var(--rule);border-radius:6px;overflow:hidden}
.set>h2{font-size:16px;margin:0;padding:10px 14px;background:#fafafa;border-bottom:1px solid var(--rule)}
.v{border-bottom:1px solid var(--rule);padding:10px 14px;display:grid;grid-template-columns:160px 1fr;gap:14px}
.v:last-child{border-bottom:0}
.v .meta{font-size:13px}.v .meta b{color:var(--accent)}.v .meta span{color:var(--ink2);display:block;font-size:12px;margin-top:2px}
.v .body .lab{font-size:11px;color:var(--ink2);text-transform:uppercase;letter-spacing:.04em;margin:0 0 2px}
.v pre{margin:0 0 8px;white-space:pre-wrap;word-break:break-word;background:#f6f6f4;border:1px solid var(--rule);border-radius:4px;padding:8px 10px;font:12px/1.5 ui-monospace,Menlo,Consolas,monospace}
.v .neg pre{border-color:#e7c9c4;background:#fbf2f0}
.tag{display:inline-block;font-size:11px;color:var(--ink2);border:1px solid var(--rule);border-radius:3px;padding:1px 6px;margin-right:4px}
</style></head><body><main>
<h1>角色提示词方案</h1>
<p class="lead">暗黑反转《灰姑娘·殉葬》· 8 个角色 · 画风：动漫（drawn）</p>
<p class="warn">本环境未配置图像后端（qwen / codex / openai / custom）。下方提示词由 character-refs 技能自带 buildPrompt 生成，可直接复制使用；
配置后端后运行 <code>gen &lt;角色目录&gt;/asset.json</code> 即可按 asset.json 中的分层与画风快照出图。</p>
`;

let md = `# 角色提示词方案 · 灰姑娘·殉葬（暗黑反转）\n\n画风：动漫（drawn）｜共 ${scheme.length} 个角色。\n\n> 未配置图像后端；提示词由 character-refs 技能 buildPrompt 生成，可直接复制；配置后端后运行 gen 命令（针对角色目录下的 asset.json）即按 asset.json 出图。\n\n`;

for (const c of scheme) {
  html += `<section class="set"><h2>${esc(c.name)}</h2>`;
  md += `## ${c.name}\n\n`;
  for (const r of c.rows) {
    const label = VIEW_LABEL[r.view] || r.view;
    html += `<div class="v"><div class="meta"><b>${esc(label)}</b><span>视图：${esc(r.view)}</span><span>比例：${esc(r.ratio)}</span></div>` +
      `<div class="body"><p class="lab">提示词</p><pre>${esc(r.text)}</pre><p class="lab">反向词</p><pre class="neg">${esc(r.negative)}</pre></div></div>`;
    md += `### ${label} \`${r.view}\` （比例 ${r.ratio}）\n\n**提示词**\n\n\`\`\`\n${r.text}\n\`\`\`\n\n**反向词**\n\n\`\`\`\n${r.negative}\n\`\`\`\n\n`;
  }
  html += `</section>`;
}
html += `</main></body></html>`;

writeFileSync(join(D, 'character-refs-prompts.html'), html, 'utf8');
writeFileSync(join(D, 'character-refs-prompts.md'), md, 'utf8');
console.log(`✓ character-refs-prompts.html / .md（${scheme.length} 个角色 × ${scheme[0].rows.length} 视图）`);
