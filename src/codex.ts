import type { DocKey, Project } from './model';

export type Job = {
  id: string;
  section: DocKey;
  provider?: 'codex' | 'ollama';
  status: 'queued' | 'running' | 'awaiting_confirmation' | 'completed' | 'failed' | 'cancelled';
  phase?: string;
  message?: string;
  error?: string;
  validation?: string;
  validationWarning?: string;
  reportWarning?: string;
  skeleton?: string;
  result?: { mapped: Project['docs'][DocKey]; raw: unknown; skillVersion: string; generatedAt: number; sourceExpansion?: string };
};

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try { response = await fetch(`/api${path}`, { ...init, headers: { 'content-type': 'application/json', ...init?.headers } }); }
  catch (error) {
    if (init?.signal?.aborted) {
      const reason = init.signal.reason;
      if (reason instanceof Error && reason.name === 'TimeoutError') throw new Error('请求超时，请检查本机服务后重试。');
      throw reason instanceof Error ? reason : new Error('请求已取消。');
    }
    throw new Error('无法连接本机 Codex 服务。请运行 npm run dev。');
  }
  let data: { error?: string };
  try { data = await response.json(); }
  catch (error) {
    if (init?.signal?.aborted) {
      const reason = init.signal.reason;
      if (reason instanceof Error && reason.name === 'TimeoutError') throw new Error('请求超时，请检查本机服务后重试。');
      throw reason instanceof Error ? reason : new Error('请求已取消。');
    }
    throw new Error('无法连接本机 Codex 服务。请运行 npm run dev。');
  }
  if (!response.ok) throw new Error(data.error || `请求失败（${response.status}）。`);
  return data as T;
}

export const getHealth = () => request<{ ok: boolean; skillVersion: string }>('/health');
export const createJob = (project: Project, section: DocKey) => request<Job>('/jobs', { method: 'POST', body: JSON.stringify({ project, section }) });
export const getJob = (id: string) => request<Job>(`/jobs/${id}`);
export const continueJob = (id: string) => request<Job>(`/jobs/${id}/continue`, { method: 'POST' });
export const cancelJob = (id: string) => request<Job>(`/jobs/${id}/cancel`, { method: 'POST' });
export const removeProjectRuns = (id: string) => request<{ ok: boolean }>(`/projects/${id}`, { method: 'DELETE' });
export const startProjectImport = (projectId: string) => request<{ importId: string }>(`/projects/${projectId}/proj/import/start`, { method: 'POST' });
export const uploadProjectImportFile = async (projectId: string, importId: string, path: string, file: File) => {
  const response = await fetch(`/api/projects/${projectId}/proj/import/${importId}?path=${encodeURIComponent(path)}`, { method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: file });
  if (!response.ok) { const data = await response.json().catch(() => ({})); throw new Error(data.error || `导入文件失败（${response.status}）。`); }
};
export const finishProjectImport = (projectId: string, importId: string) => request<{ docs: Project['docs']; skillArtifacts: Project['skillArtifacts']; sourceText?: string; sourceName?: string }>(`/projects/${projectId}/proj/import/${importId}/finish`, { method: 'POST' });
export type ProjectRestoreInfo = { restoreId: string; projectId: string; projectName: string; targetName: string; createdAt: number };
export const prepareProjectRestore = async (projectId: string, file: File): Promise<ProjectRestoreInfo> => {
  let response: Response;
  try { response = await fetch(`/api/projects/${projectId}/backup/restore/prepare`, { method: 'POST', headers: { 'content-type': 'application/zip' }, body: file, signal: AbortSignal.timeout(15 * 60_000) }); }
  catch { throw new Error('无法上传备份，请检查本机服务后重试。'); }
  const result = await response.json().catch(() => null) as ProjectRestoreInfo & { error?: string } | null;
  if (!response.ok) throw new Error(result?.error || `备份校验失败（${response.status}）。`);
  if (!result) throw new Error('备份校验没有返回有效结果。');
  return result;
};
export const commitProjectRestore = (projectId: string, restoreId: string) => request<{ ok: boolean; projectId: string; projectName: string }>(`/projects/${projectId}/backup/restore/${restoreId}/commit`, { method: 'POST' });
export const cancelProjectRestore = (projectId: string, restoreId: string) => request<{ ok: boolean }>(`/projects/${projectId}/backup/restore/${restoreId}/cancel`, { method: 'POST' });
export function downloadProjectBackup(projectId: string, filename: string) {
  const anchor = document.createElement('a');
  anchor.href = `/api/projects/${projectId}/backup?filename=${encodeURIComponent(filename)}`;
  anchor.download = filename;
  anchor.click();
}
export const consult = (project: Project, mode: 'talk' | 'edit', message: string) => request<{ reply: string; scene?: Project['docs']['script']['episodes'][number]['scenes'][number] }>('/consult', { method: 'POST', body: JSON.stringify({ project, mode, message }) });

export type Settings = {
  showCreativeTemplates: boolean;
  codex: { provider: 'codex' | 'ollama'; executablePath: string; model: string; ollamaModel: string; reasoningEffort: 'low' | 'medium' | 'high' | 'xhigh'; timeoutMinutes: number };
  imageProvider: 'qwen' | 'gpt' | 'chatgpt';
  chatgptImage: { proxy: string; timeoutMinutes: number };
  gptImage: { model: 'gpt-image-2.5-sunburst' | 'gpt-image-2.5-flare'; quality: 'low' | 'medium' | 'high' | 'xhigh' | 'max'; hasApiKey: boolean; apiKey?: string };
  comfy: { baseUrl: string; image: ImageWorkflow; imageEdit: ImageWorkflow; video: MediaWorkflow & { duration: number; durationNodeId: string; durationInput: string; referenceSlots?: { imageNodeId: string; imageInput: string; timeNodeId: string; timeInput: string }[] }; videoFirstLast: MediaWorkflow & { duration: number; durationNodeId: string; durationInput: string; lastFrameNodeId: string; lastFrameInput: string }; audio: MediaWorkflow & { lyricsNodeId: string; lyricsInput: string; durationNodeId: string; durationInput: string; duration: number } };
};
export type MediaWorkflow = { workflowJson: string; workflowFileName: string; promptNodeId: string; promptInput: string; referenceNodeId: string; referenceInput: string; seedNodeId: string; seedInput: string; seed: number };
export type ImageWorkflow = MediaWorkflow & { width: number; height: number; steps: number; cfg: number; widthNodeId: string; widthInput: string; heightNodeId: string; heightInput: string; stepsNodeId: string; stepsInput: string; cfgNodeId: string; cfgInput: string };
export type MediaJob = { id: string; kind: 'image' | 'video' | 'audio'; status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'; queueType?: 'comfyui' | 'other'; queuePosition?: number; message?: string; error?: string; result?: { url: string; mime: string; prompt: string; generatedAt: number } };
export const createMediaJob = (input: { projectId: string; kind: 'image' | 'video' | 'audio'; provider?: 'qwen' | 'gpt' | 'chatgpt'; imageMode?: 'edit' | 'compose'; videoWorkflow?: 'firstLast'; lyrics?: string; prompt: string; negativePrompt?: string; source?: string; sources?: string[]; cutPoints?: number[]; duration?: number; videoResolution?: 480 | 720 | 1080; ratio?: '1:1' | '9:16' | '16:9' | '3:4' | '4:3' | '3:2' | '2:3' | '4:5' | '5:4' | '21:9' }) => request<MediaJob>('/media/jobs', { method: 'POST', body: JSON.stringify(input), signal: AbortSignal.timeout(60_000) });
export const getMediaJob = (id: string) => request<MediaJob>(`/media/jobs/${id}`);
export const cancelMediaJob = (id: string) => request<MediaJob>(`/media/jobs/${id}/cancel`, { method: 'POST' });
export const discardMediaJob = (id: string) => request<{ ok: boolean }>(`/media/jobs/${id}`, { method: 'POST' });
export const copyMediaToLibrary = (url: string) => request<{ url: string }>('/media/library-copy', { method: 'POST', body: JSON.stringify({ url }) });
export const uploadLibraryMedia = (file: File, kind: 'image' | 'video', signal?: AbortSignal) => request<{ url: string }>(`/media/library-upload?kind=${kind}`, { method: 'POST', headers: { 'content-type': file.type || 'application/octet-stream' }, body: file, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(kind === 'image' ? 120_000 : 300_000)]) : AbortSignal.timeout(kind === 'image' ? 120_000 : 300_000) });
export const deleteMedia = (url: string) => request<{ ok: boolean }>('/media/delete', { method: 'POST', body: JSON.stringify({ url }) });
export const getSettings = () => request<Settings>('/settings');
export const saveSettings = (settings: Settings) => request<Settings>('/settings', { method: 'PUT', body: JSON.stringify(settings) });
export const testComfy = (baseUrl: string) => request<{ ok: boolean; version: string; devices: string[] }>('/settings/comfy/test', { method: 'POST', body: JSON.stringify({ baseUrl }) });
export const testCodex = (codex: Settings['codex']) => request<{ ok: boolean; model: string; reply: string }>('/settings/codex/test', { method: 'POST', body: JSON.stringify(codex) });
export const checkWorkflow = (workflowJson: string, promptNodeId: string, promptInput: string) => request<{ nodeCount: number }>('/settings/workflow/check', { method: 'POST', body: JSON.stringify({ workflowJson, promptNodeId, promptInput }) });
export const getPreset = (kind: 'image' | 'imageEdit' | 'video' | 'videoFirstLast' | 'audio') => request<Settings['comfy'][typeof kind]>(`/settings/presets/${kind}`);
export const checkPreset = (baseUrl: string, workflow: MediaWorkflow) => request<{ ok: boolean; missingNodes: string[]; missingModels: string[]; nodeCount: number }>('/settings/presets/check', { method: 'POST', body: JSON.stringify({ baseUrl, workflow }) });

export const manageChatgpt = (action: 'login' | 'status' | 'reset', config: Settings['chatgptImage']) => request<{ message: string }>(`/settings/chatgpt/${action}`, { method: 'POST', body: JSON.stringify(config), signal: AbortSignal.timeout(90_000) });
