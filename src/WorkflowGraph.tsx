import { useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';

type ApiNode = { class_type: string; inputs: Record<string, unknown>; _meta?: { title?: string } };
type GraphNode = { id: string; node: ApiNode; layer: number; row: number; height: number; title: string; roles: string[] };
type Mapping = { id: string; title: string };
type Point = { x: number; y: number };

const names: Record<string, string> = {
  UNETLoader: 'Qwen 图像模型', CLIPLoader: 'Qwen 文本编码器', VAELoader: 'VAE 图像编解码器',
  QwenImage21Cache: 'Qwen 模型缓存', TextEncodeQwenImage21: '提示词与参考图',
  KSampler: '采样器', VAEDecode: '解码生成图像', SaveImage: '保存图像', SaveImageAdvanced: '保存图像',
  LoadImage: '加载图片', EmptyLatentImage: '目标画布', EmptySD3LatentImage: '目标画布',
  ResolutionSelector: '分辨率选择器', ComfySwitchNode: '画幅切换', ImageCompare: '结果对比', MiniMaxH3ImageToVideo: 'MiniMax H3 视频生成',
  CreateVideo: '合成视频', SaveVideo: '保存视频', ConditioningZeroOut: '空负向条件'
};
const isLink = (value: unknown, graph: Record<string, ApiNode>): value is [string, number] => Array.isArray(value) && value.length >= 2 && typeof value[0] === 'string' && !!graph[value[0]] && typeof value[1] === 'number';

export default function WorkflowGraph({ workflowJson, mappings = [] }: { workflowJson: string; mappings?: Mapping[] }) {
  const [selected, setSelected] = useState('');
  const [nodePositions, setNodePositions] = useState<Record<string, Point>>({});
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState<Point>({ x: 0, y: 0 });
  const scrollRef = useRef<HTMLDivElement>(null);
  const activeDrag = useRef<{ type: 'node' | 'pan'; id?: string; x: number; y: number } | null>(null);
  const endPanRef = useRef<(() => void) | null>(null);
  useEffect(() => () => endPanRef.current?.(), []);
  const parsed = useMemo(() => {
    try { const value = JSON.parse(workflowJson); return value && !Array.isArray(value) && typeof value === 'object' ? value as Record<string, ApiNode> : null; }
    catch { return null; }
  }, [workflowJson]);
  const mappingsKey = JSON.stringify(mappings);
  const layout = useMemo(() => {
    if (!parsed) return null;
    const ids = Object.keys(parsed); const layers: Record<string, number> = Object.fromEntries(ids.map(id => [id, 0]));
    for (let pass = 0; pass < ids.length; pass++) for (const id of ids) for (const value of Object.values(parsed[id]?.inputs || {})) {
      if (isLink(value, parsed)) layers[id] = Math.max(layers[id], layers[value[0]] + 1);
    }
    const columns = new Map<number, string[]>();
    for (const id of ids) { const layer = Math.min(layers[id], Math.max(0, ids.length - 1)); columns.set(layer, [...(columns.get(layer) || []), id]); }
    const nodes: GraphNode[] = [];
    for (const [layer, column] of columns) column.forEach((id, row) => {
      const node = parsed[id]; const title = node._meta?.title || names[node.class_type] || node.class_type;
      const roles = mappings.filter(item => item.id === id).map(item => item.title);
      nodes.push({ id, node, layer, row, height: Math.max(112, 74 + Object.keys(node.inputs || {}).length * 22), title, roles });
    });
    const widths = 310; const gapX = 88; const gapY = 32; const positions = new Map(nodes.map(node => [node.id, { x: 32 + node.layer * (widths + gapX), y: 28 + nodes.filter(other => other.layer === node.layer).slice(0, node.row).reduce((sum, other) => sum + other.height + gapY, 0) }]));
    const width = 64 + (Math.max(0, ...nodes.map(node => node.layer)) + 1) * (widths + gapX); const height = Math.max(350, ...nodes.map(node => positions.get(node.id)!.y + node.height + 32));
    return { nodes, positions, width, height };
  // SettingsPage creates a new mappings array on every render. Keep the layout
  // stable while only the viewport or node positions are changing.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parsed, mappingsKey]);
  useEffect(() => {
    if (!layout) return;
    setNodePositions(Object.fromEntries([...layout.positions].map(([id, point]) => [id, { ...point }])));
    setPan({ x: 0, y: 0 }); setZoom(1); setSelected('');
  }, [layout]);
  if (!parsed || !layout) return <div className="workflow-graph-empty">{workflowJson ? 'JSON 格式无效，无法绘制节点。' : '导入或恢复工作流后，这里会显示节点连线图。'}</div>;
  const graphLayout = layout;
  const selectedNode = layout.nodes.find(node => node.id === selected);
  const position = (id: string) => nodePositions[id] || layout.positions.get(id)!;
  function startCanvasDrag(event: ReactPointerEvent<HTMLDivElement>) {
    const onNode = (event.target as Element).closest('.workflow-node');
    if (event.button !== 1 && (event.button !== 0 || onNode)) return;
    event.preventDefault();
    event.stopPropagation();
    endPanRef.current?.();
    const viewport = event.currentTarget;
    const pointerId = event.pointerId;
    activeDrag.current = { type: 'pan', x: event.clientX, y: event.clientY };
    viewport.setPointerCapture(pointerId);
    viewport.classList.add('is-panning');
    const move = (moveEvent: PointerEvent) => {
      const drag = activeDrag.current;
      if (!drag || drag.type !== 'pan' || moveEvent.pointerId !== pointerId) return;
      moveEvent.preventDefault();
      const dx = moveEvent.clientX - drag.x;
      const dy = moveEvent.clientY - drag.y;
      drag.x = moveEvent.clientX;
      drag.y = moveEvent.clientY;
      setPan(current => ({ x: current.x + dx, y: current.y + dy }));
    };
    const end = () => {
      if (activeDrag.current?.type === 'pan') activeDrag.current = null;
      viewport.classList.remove('is-panning');
      if (viewport.hasPointerCapture(pointerId)) viewport.releasePointerCapture(pointerId);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', onEnd);
      window.removeEventListener('pointercancel', onEnd);
      window.removeEventListener('blur', end);
      endPanRef.current = null;
    };
    const onEnd = (endEvent: PointerEvent) => { if (endEvent.pointerId === pointerId) end(); };
    endPanRef.current = end;
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', onEnd);
    window.addEventListener('pointercancel', onEnd);
    window.addEventListener('blur', end);
  }
  function moveNodeDrag(event: ReactPointerEvent<SVGGElement>) {
    const drag = activeDrag.current; if (!drag || drag.type !== 'node' || !drag.id) return;
    const dx = (event.clientX - drag.x) / zoom; const dy = (event.clientY - drag.y) / zoom;
    setNodePositions(current => { const currentPosition = current[drag.id!] || graphLayout.positions.get(drag.id!)!; return { ...current, [drag.id!]: { x: currentPosition.x + dx, y: currentPosition.y + dy } }; });
    drag.x = event.clientX; drag.y = event.clientY;
  }
  function restoreLayout() {
    setNodePositions(Object.fromEntries([...graphLayout.positions].map(([id, point]) => [id, { ...point }])));
    setPan({ x: 0, y: 0 }); setZoom(1);
    scrollRef.current?.scrollTo({ left: 0, top: 0, behavior: 'smooth' });
  }
  function zoomAt(nextZoom: number, clientX?: number, clientY?: number) {
    const viewport = scrollRef.current;
    const clamped = Math.max(.4, Math.min(2, Math.round(nextZoom * 100) / 100));
    if (viewport && clientX !== undefined && clientY !== undefined) {
      const bounds = viewport.getBoundingClientRect();
      const x = clientX - bounds.left; const y = clientY - bounds.top;
      const anchorX = (x - pan.x) / zoom;
      const anchorY = (y - pan.y) / zoom;
      setPan({ x: x - anchorX * clamped, y: y - anchorY * clamped });
      setZoom(clamped);
    } else setZoom(clamped);
  }
  return <div className="workflow-graph-shell">
    <div className="workflow-graph-toolbar"><span><i/> 节点与连线</span><span>{layout.nodes.length} 个节点 · 左键拖动空白处或中键拖动任意位置 · 滚轮缩放</span><div className="workflow-graph-tools"><button type="button" aria-label="缩小" onClick={() => zoomAt(zoom - .1)}>−</button><output>{Math.round(zoom * 100)}%</output><button type="button" aria-label="放大" onClick={() => zoomAt(zoom + .1)}>＋</button><button type="button" onClick={restoreLayout}>一键恢复</button></div></div>
    <div ref={scrollRef} className="workflow-graph-scroll" onPointerDownCapture={startCanvasDrag} onAuxClick={event => event.preventDefault()} onWheel={event => { event.preventDefault(); zoomAt(zoom * (event.deltaY < 0 ? 1.1 : .9), event.clientX, event.clientY); }}><svg className="workflow-graph-canvas" width="100%" height="100%" role="img" aria-label="ComfyUI 工作流节点图">
      <g transform={`translate(${pan.x} ${pan.y}) scale(${zoom})`}>
      {layout.nodes.flatMap(target => Object.entries(target.node.inputs || {}).flatMap(([key, value], inputIndex) => {
        if (!isLink(value, parsed)) return [];
        const source = layout.nodes.find(node => node.id === value[0]); if (!source) return [];
        const from = position(source.id); const to = position(target.id);
        const x1 = from.x + 310; const y1 = from.y + 74; const x2 = to.x; const y2 = to.y + 74 + inputIndex * 22;
        const selectedPath = selected === source.id || selected === target.id;
        return [<g key={`${source.id}-${target.id}-${key}`} className={`workflow-edge${selectedPath ? ' is-highlighted' : ''}`}><path d={`M ${x1} ${y1} C ${x1 + 44} ${y1}, ${x2 - 44} ${y2}, ${x2} ${y2}`}/><text x={(x1 + x2) / 2} y={(y1 + y2) / 2 - 7}>{key}</text></g>];
      }))}
      {layout.nodes.map(node => { const pos = position(node.id); return <g key={node.id} transform={`translate(${pos.x} ${pos.y})`} onPointerDown={event => { if (event.button !== 0) return; event.stopPropagation(); activeDrag.current = { type: 'node', id: node.id, x: event.clientX, y: event.clientY }; event.currentTarget.setPointerCapture(event.pointerId); setSelected(node.id); }} onPointerMove={moveNodeDrag} onPointerUp={event => { if (activeDrag.current?.type === 'node') activeDrag.current = null; if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }} onPointerCancel={() => { if (activeDrag.current?.type === 'node') activeDrag.current = null; }} onClick={() => setSelected(node.id)} className={`workflow-node${selected === node.id ? ' is-selected' : ''}`} role="button" tabIndex={0} aria-label={`${node.title}，节点 ${node.id}`} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') setSelected(node.id); }}>
        <rect className="workflow-node-card" width="310" height={node.height} rx="12"/><path className="workflow-node-header" d="M 12 0 H 298 Q 310 0 310 12 V 43 H 0 V 12 Q 0 0 12 0"/>
        <text className="workflow-node-title" x="15" y="27">{node.title.slice(0, 28)}</text><text className="workflow-node-id" x="294" y="27" textAnchor="end">#{node.id}</text>
        {node.roles.length > 0 && <text className="workflow-node-role" x="15" y="62">{node.roles.join(' · ')}</text>}
        {Object.entries(node.node.inputs || {}).slice(0, 6).map(([key, value], index) => <g key={key} className="workflow-node-input"><circle cx="8" cy={84 + index * 22} r="4"/><text x="18" y={88 + index * 22}>{key}</text><text className="workflow-node-value" x="294" y={88 + index * 22} textAnchor="end">{isLink(value, parsed) ? `← ${parsed[value[0]]._meta?.title || names[parsed[value[0]].class_type] || parsed[value[0]].class_type}` : String(value).slice(0, 24)}</text></g>)}
      </g>; })}
      </g>
    </svg></div>
    {selectedNode && <div className="workflow-node-inspector"><strong>{selectedNode.title} · 节点 #{selectedNode.id}</strong><span>{selectedNode.node.class_type}</span><button type="button" aria-label="关闭节点详情" onClick={() => setSelected('')}>×</button><div>{Object.entries(selectedNode.node.inputs || {}).map(([key, value]) => <code key={key}>{key}: {isLink(value, parsed) ? `节点 ${value[0]} 输出 ${value[1]}` : JSON.stringify(value)}</code>)}</div></div>}
  </div>;
}
