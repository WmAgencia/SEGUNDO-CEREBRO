// Detecta ROOT do monorepo. Tenta várias estratégias e pega a primeira que
// contenha o apps/clipcon-server como filho (sinal de que estamos no monorepo).
import path from "node:path";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, unlinkSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { nanoid } from "nanoid";

function resolveRoot(): string {
  const candidates: string[] = [];
  // 1) process.cwd()
  candidates.push(process.cwd());
  // 2) cwd pai
  candidates.push(path.resolve(process.cwd(), ".."));
  // 3) grandparent do arquivo atual
  try {
    const __filename = fileURLToPath(import.meta.url);
    candidates.push(path.resolve(path.dirname(__filename), "..", ".."));
    candidates.push(path.resolve(path.dirname(__filename), "..", "..", ".."));
  } catch {}
  for (const c of candidates) {
    if (existsSync(path.join(c, "apps", "clipcon-server"))) return c;
  }
  // fallback
  return process.cwd();
}

export const ROOT = resolveRoot();
export const DATA_DIR = path.join(ROOT, "data", "clipcon-projects");

export interface Project {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  sources: Source[];
  /** EDL atual do editor (estado da timeline) */
  edl?: unknown;
  /** URL relativa do último render */
  lastRender?: string;
}

export interface Source {
  id: string;
  name: string;
  path: string;
  /** Caminho relativo a DATA_DIR para servir via /api/files */
  relPath: string;
  size: number;
  duration?: number;
  fps?: number;
  width?: number;
  height?: number;
  thumb?: string;
  waveform?: string;
}

function projectDir(id: string): string {
  return path.join(DATA_DIR, id);
}
function projectFile(id: string): string {
  return path.join(projectDir(id), "project.json");
}

export function listProjects(): Project[] {
  mkdirSync(DATA_DIR, { recursive: true });
  return readdirSync(DATA_DIR)
    .filter((name) => {
      try { return statSync(path.join(DATA_DIR, name)).isDirectory(); } catch { return false; }
    })
    .map((id) => getProject(id))
    .filter((p): p is Project => p !== null)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export function getProject(id: string): Project | null {
  const f = projectFile(id);
  if (!existsSync(f)) return null;
  return JSON.parse(readFileSync(f, "utf8"));
}

export function createProject(name: string): Project {
  const id = nanoid(10);
  const now = Date.now();
  const dir = projectDir(id);
  mkdirSync(path.join(dir, "sources"), { recursive: true });
  mkdirSync(path.join(dir, "edit"), { recursive: true });
  mkdirSync(path.join(dir, "thumbs"), { recursive: true });
  mkdirSync(path.join(dir, "waveforms"), { recursive: true });
  const project: Project = { id, name, createdAt: now, updatedAt: now, sources: [] };
  writeFileSync(projectFile(id), JSON.stringify(project, null, 2));
  return project;
}

export function deleteProject(id: string): boolean {
  const dir = projectDir(id);
  if (!existsSync(dir)) return false;
  rmSync(dir, { recursive: true, force: true });
  return true;
}

export function updateProject(id: string, patch: Partial<Project>): Project | null {
  const project = getProject(id);
  if (!project) return null;
  const updated = { ...project, ...patch, id, updatedAt: Date.now() };
  writeFileSync(projectFile(id), JSON.stringify(updated, null, 2));
  return updated;
}

export function addSource(projectId: string, source: Source): Project | null {
  const project = getProject(projectId);
  if (!project) return null;
  const sources = [...project.sources, source];
  return updateProject(projectId, { sources });
}

export function projectAbsPath(projectId: string, relPath: string): string {
  return path.join(DATA_DIR, projectId, relPath);
}

export function projectRelPath(absPath: string): string {
  return path.relative(DATA_DIR, absPath).replaceAll("\\", "/");
}

export function ensureProjectSubdir(projectId: string, sub: string): string {
  const dir = path.join(projectDir(projectId), sub);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export { DATA_DIR as STORAGE_ROOT };
