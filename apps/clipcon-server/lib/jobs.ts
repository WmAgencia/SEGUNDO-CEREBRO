import { nanoid } from "nanoid";

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

const jobs = new Map<string, Job>();

export function createJob(type: Job["type"]): Job {
  const job: Job = { id: nanoid(8), type, status: "queued" };
  jobs.set(job.id, job);
  return job;
}

export function updateJob(id: string, patch: Partial<Job>): Job | null {
  const job = jobs.get(id);
  if (!job) return null;
  Object.assign(job, patch);
  jobs.set(id, job);
  return job;
}

export function getJob(id: string): Job | null {
  return jobs.get(id) ?? null;
}

export function listJobs(): Job[] {
  return Array.from(jobs.values()).sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
}
