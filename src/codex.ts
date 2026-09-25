import type { DocKey, Project } from './model';

export type Job = {
  id: string;
  section: DocKey;
  status: 'queued' | 'running' | 'awaiting_confirmation' | 'completed' | 'failed' | 'cancelled';
  phase?: string;
  message?: string;
  error?: string;
  validation?: string;
  validationWarning?: string;
  skeleton?: string;
  result?: { mapped: Project['docs'][DocKey]; raw: unknown; skillVersion: string; generatedAt: number; sourceExpansion?: string };
};

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try { response = await fetch(`/api${path}`, { ...init, headers: { 'content-type': 'application/json', ...init?.headers } }); }
  catch { throw new Error('无法连接本机 Codex 服务。请运行 npm run dev。'); }
  let data: { error?: string };
  try { data = await response.json(); }
  catch { throw new Error('无法连接本机 Codex 服务。请运行 npm run dev。'); }
  if (!response.ok) throw new Error(data.error || `请求失败（${response.status}）。`);
  return data as T;
}

export const getHealth = () => request<{ ok: boolean; skillVersion: string }>('/health');
export const createJob = (project: Project, section: DocKey) => request<Job>('/jobs', { method: 'POST', body: JSON.stringify({ project, section }) });
export const getJob = (id: string) => request<Job>(`/jobs/${id}`);
export const continueJob = (id: string) => request<Job>(`/jobs/${id}/continue`, { method: 'POST' });
export const cancelJob = (id: string) => request<Job>(`/jobs/${id}/cancel`, { method: 'POST' });
export const removeProjectRuns = (id: string) => request<{ ok: boolean }>(`/projects/${id}`, { method: 'DELETE' });
export const consult = (project: Project, mode: 'talk' | 'edit', message: string) => request<{ reply: string; scene?: Project['docs']['script']['episodes'][number]['scenes'][number] }>('/consult', { method: 'POST', body: JSON.stringify({ project, mode, message }) });

export type Settings = {
  codex: { model: string; reasoningEffort: 'low' | 'medium' | 'high' | 'xhigh'; timeoutMinutes: number };
  comfy: { baseUrl: string; image: MediaWorkflow & { width: number; height: number; steps: number; cfg: number; widthNodeId: string; widthInput: string; heightNodeId: string; heightInput: string; stepsNodeId: string; stepsInput: string; cfgNodeId: string; cfgInput: string }; video: MediaWorkflow & { duration: number; durationNodeId: string; durationInput: string } };
};
export type MediaWorkflow = { workflowJson: string; promptNodeId: string; promptInput: string; referenceNodeId: string; referenceInput: string; seedNodeId: string; seedInput: string; seed: number };
export type MediaJob = { id: string; kind: 'image' | 'video'; status: 'queued' | 'running' | 'completed' | 'failed'; message?: string; error?: string; result?: { url: string; mime: string; prompt: string; generatedAt: number } };
export const createMediaJob = (input: { projectId: string; kind: 'image' | 'video'; prompt: string; source?: string; duration?: number }) => request<MediaJob>('/media/jobs', { method: 'POST', body: JSON.stringify(input) });
export const getMediaJob = (id: string) => request<MediaJob>(`/media/jobs/${id}`);
export const discardMediaJob = (id: string) => request<{ ok: boolean }>(`/media/jobs/${id}`, { method: 'POST' });
export const copyMediaToLibrary = (url: string) => request<{ url: string }>('/media/library-copy', { method: 'POST', body: JSON.stringify({ url }) });
export const getSettings = () => request<Settings>('/settings');
export const saveSettings = (settings: Settings) => request<Settings>('/settings', { method: 'PUT', body: JSON.stringify(settings) });
export const testComfy = (baseUrl: string) => request<{ ok: boolean; version: string; devices: string[] }>('/settings/comfy/test', { method: 'POST', body: JSON.stringify({ baseUrl }) });
export const testCodex = (codex: Settings['codex']) => request<{ ok: boolean; model: string; reply: string }>('/settings/codex/test', { method: 'POST', body: JSON.stringify(codex) });
export const checkWorkflow = (workflowJson: string, promptNodeId: string, promptInput: string) => request<{ nodeCount: number }>('/settings/workflow/check', { method: 'POST', body: JSON.stringify({ workflowJson, promptNodeId, promptInput }) });
