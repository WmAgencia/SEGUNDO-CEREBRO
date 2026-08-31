import type { Project, TimelineEDL, Job } from "./types";

const BASE = "/api";

async function jsonFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const resp = await fetch(BASE + url, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers || {}),
    },
  });
  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`API ${resp.status}: ${txt}`);
  }
  return resp.json();
}

export const api = {
  // Projects
  listProjects: () => jsonFetch<{ projects: Project[] }>("/projects"),
  getProject: (id: string) => jsonFetch<Project>(`/projects/${id}`),
  createProject: (name: string) =>
    jsonFetch<Project>("/projects", { method: "POST", body: JSON.stringify({ name }) }),
  deleteProject: (id: string) =>
    jsonFetch<{ ok: boolean }>(`/projects/${id}`, { method: "DELETE" }),

  // Upload (multipart)
  uploadSource: async (projectId: string, file: File, onProgress?: (pct: number) => void) => {
    return new Promise<Project>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      const form = new FormData();
      form.append("file", file);
      xhr.upload.addEventListener("progress", (e) => {
        if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total);
      });
      xhr.addEventListener("load", () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try { resolve(JSON.parse(xhr.responseText)); }
          catch (e) { reject(e); }
        } else {
          reject(new Error(`Upload failed: ${xhr.status} ${xhr.responseText}`));
        }
      });
      xhr.addEventListener("error", () => reject(new Error("Network error")));
      xhr.open("POST", `${BASE}/projects/${projectId}/upload`);
      xhr.send(form);
    });
  },

  // Media
  probe: (path: string) =>
    jsonFetch<{ duration?: number; fps?: number; width?: number; height?: number }>(
      `/media/probe?path=${encodeURIComponent(path)}`
    ),
  waveform: (path: string, bins = 512) =>
    jsonFetch<{ peaks: number[]; duration: number; bins: number }>(
      `/media/waveform?path=${encodeURIComponent(path)}&bins=${bins}`
    ),
  silences: (path: string, minDur = 0.5) =>
    jsonFetch<{ silences: { start: number; end: number }[] }>(
      `/media/silences?path=${encodeURIComponent(path)}&min=${minDur}`
    ),

  // Render
  render: (projectId: string, edl: TimelineEDL) =>
    jsonFetch<{ jobId: string }>(`/projects/${projectId}/render`, {
      method: "POST",
      body: JSON.stringify({ edl }),
    }),

  // Jobs
  getJob: (id: string) => jsonFetch<Job>(`/jobs/${id}`),

  // Shorts
  listShorts: (projectId: string) =>
    jsonFetch<{ shorts: { name: string; url: string; size: number; mtime: number }[] }>(
      `/projects/${projectId}/shorts`
    ),
  generateShorts: (projectId: string, opts?: { platforms?: string[] }) =>
    jsonFetch<{ jobId: string }>(`/projects/${projectId}/shorts`, {
      method: "POST",
      body: JSON.stringify(opts || {}),
    }),

  // Chat
  chat: (projectId: string) => {
    const wsBase = BASE.replace(/^http/, "ws");
    const url = `${wsBase}/chat?projectId=${projectId}`;
    return new WebSocket(url);
  },

  // Files (serve arquivos do projeto)
  fileUrl: (projectId: string, relPath: string) =>
    `${BASE}/files/${projectId}/${relPath.replace(/^\/+/, "")}`,
};
