// Thin typed wrappers around the /api/projects routes.
import type { Asset, Project, ProjectSummary } from "../types";

export class ApiError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

async function json<T>(res: Response): Promise<T> {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError((data as { error?: string }).error || `Request failed (${res.status})`, res.status);
  return data as T;
}

export const api = {
  list: () => fetch("/api/projects", { cache: "no-store" }).then(r => json<{ projects: ProjectSummary[]; firstRun: boolean }>(r)),

  create: (input: { name?: string; logline?: string; style?: string; starter?: boolean }) =>
    fetch("/api/projects", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) })
      .then(r => json<{ project: Project }>(r)).then(d => d.project),

  get: (id: string) => fetch(`/api/projects/${id}`, { cache: "no-store" }).then(r => json<{ project: Project }>(r)).then(d => d.project),

  save: (project: Project, revision: number, keepalive = false) =>
    fetch(`/api/projects/${project.id}`, {
      method: "PUT", keepalive, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ project, revision }),
    }).then(r => json<{ revision: number; updatedAt: string }>(r)),

  remove: (id: string) => fetch(`/api/projects/${id}`, { method: "DELETE" }).then(r => json<{ ok: true }>(r)),

  upload: (projectId: string, files: File[] | Blob[], names?: string[]) => {
    const form = new FormData();
    files.forEach((f, i) => form.append("files", f, names?.[i] ?? (f instanceof File ? f.name : `upload-${i}`)));
    return fetch(`/api/projects/${projectId}/files`, { method: "POST", body: form }).then(r => json<{ assets: Asset[] }>(r)).then(d => d.assets);
  },
};
