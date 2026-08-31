/** Tipos compartilhados entre web e server */

export interface Source {
  id: string;
  name: string;
  path: string;
  relPath: string;
  size: number;
  duration?: number;
  fps?: number;
  width?: number;
  height?: number;
  thumb?: string;
  waveform?: string;
}

export interface Project {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  sources: Source[];
  chatHistory?: ChatMessage[];
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  ts: number;
  patches?: EdlPatch[];
}

export type EdlPatch =
  | { op: "trim"; clipId: string; start?: number; end?: number }
  | { op: "split"; clipId: string; at: number }
  | { op: "delete"; clipId: string }
  | { op: "move"; clipId: string; track?: number; start?: number }
  | { op: "add"; source: string; track: number; start: number; duration: number }
  | { op: "color"; clipId: string; grade: string }
  | { op: "fade"; clipId: string; fadeIn?: number; fadeOut?: number }
  | { op: "render" }
  | { op: "ai_autonomous" };

export interface TimelineRange {
  id: string;
  source: string;
  /** Posição inicial na timeline (segundos) */
  start: number;
  /** Duração na timeline (segundos) */
  duration: number;
  track: number;
  /** Trim in dentro do source (segundos). Se undefined, usa 0 */
  inPoint?: number;
  /** Trim out dentro do source (segundos). Se undefined, usa source.duration */
  outPoint?: number;
  grade?: string;
  fadeIn?: number;
  fadeOut?: number;
  label?: string;
}

export interface TimelineEDL {
  sources: Record<string, Source>;
  ranges: TimelineRange[];
  fps: number;
  width: number;
  height: number;
}

export interface Job {
  id: string;
  type: "render" | "transcribe" | "shorts" | "waveform" | "thumb";
  status: "queued" | "running" | "done" | "error";
  startedAt?: number;
  finishedAt?: number;
  progress?: number;
  result?: unknown;
  error?: string;
}
