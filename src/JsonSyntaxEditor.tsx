import { useMemo, useState, type ReactNode } from 'react';

const tokenPattern = /"(?:\\.|[^"\\])*"(?=\s*:)|"(?:\\.|[^"\\])*"|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|\b(?:true|false|null)\b|[{}\[\],:]/g;

function highlightJson(value: string) {
  const parts: ReactNode[] = [];
  let offset = 0;
  for (const match of value.matchAll(tokenPattern)) {
    const token = match[0];
    const index = match.index ?? 0;
    if (index > offset) parts.push(value.slice(offset, index));
    const kind = token.startsWith('"')
      ? /^\s*:/.test(value.slice(index + token.length)) ? 'key' : 'string'
      : /^-?\d/.test(token) ? 'number'
        : /^(?:true|false|null)$/.test(token) ? 'literal' : 'punctuation';
    parts.push(<span className={`json-token-${kind}`} key={`${index}-${token}`}>{token}</span>);
    offset = index + token.length;
  }
  if (offset < value.length) parts.push(value.slice(offset));
  return parts;
}

export default function JsonSyntaxEditor({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const [scroll, setScroll] = useState({ top: 0, left: 0 });
  const highlighted = useMemo(() => highlightJson(value), [value]);

  return <div className="json-syntax-editor">
    <pre className="json-syntax-highlight" aria-hidden="true" style={{ transform: `translate(${-scroll.left}px, ${-scroll.top}px)` }}>{highlighted}{value.endsWith('\n') ? '\u200b' : ''}</pre>
    <textarea
      className="settings-workflow json-syntax-input"
      value={value}
      onChange={event => onChange(event.target.value)}
      onScroll={event => setScroll({ top: event.currentTarget.scrollTop, left: event.currentTarget.scrollLeft })}
      placeholder="粘贴或导入 ComfyUI API 格式工作流 JSON"
      aria-label="ComfyUI API 工作流 JSON"
      spellCheck={false}
      wrap="off"
    />
  </div>;
}
