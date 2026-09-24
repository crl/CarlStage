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
