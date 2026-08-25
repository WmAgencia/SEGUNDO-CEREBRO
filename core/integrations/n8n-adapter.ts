import { DatabaseSync } from "node:sqlite";
import { emitBus } from "../hq/event-bus.ts";

/**
 * N8N ADAPTER — execution fabric opcional (spec §12).
 * O HQ NÃO vira n8n: este adapter dispara workflows, aguarda status e registra
 * evidência. Sem N8N_BASE_URL configurado → resultado BLOCKED honesto.
 *
 * Env: N8N_BASE_URL (ex.: https://n8n.exemplo.com) · N8N_API_KEY ·
 *      N8N_WEBHOOK_BASE (opcional; default = N8N_BASE_URL)
 */

export interface N8nTriggerResult {
  status: "BLOCKED" | "TRIGGERED" | "FAILED";
  executionId?: string | number;
  error?: string;
  evidence: { url: string; sentAt: string; payloadBytes: number };
}

export interface N8nExecutionStatus {
  status: "UNKNOWN" | "RUNNING" | "COMPLETED" | "FAILED" | "BLOCKED";
  data?: unknown;
  error?: string;
}

function cfg(): { base: string; key: string } {
  return {
    base: (process.env.N8N_BASE_URL ?? "").replace(/\/$/, ""),
    key: process.env.N8N_API_KEY ?? "",
  };
}

export function isN8nConfigured(): boolean {
  return Boolean(process.env.N8N_BASE_URL);
}

/** Dispara workflow via webhook do n8n (padrão production webhook). */
export async function triggerWorkflow(
  db: DatabaseSync | null,
  workflowPath: string,
  payload: Record<string, unknown>,
): Promise<N8nTriggerResult> {
  const { base, key } = cfg();
  const url = `${(process.env.N8N_WEBHOOK_BASE ?? base).replace(/\/$/, "")}/${workflowPath.replace(/^\//, "")}`;
  const body = JSON.stringify({ source: "second-brain-hq", ...payload });
  if (!base) {
    return {
      status: "BLOCKED",
      error: "N8N_BASE_URL não configurada — integração n8n indisponível neste ambiente",
      evidence: { url, sentAt: new Date().toISOString(), payloadBytes: Buffer.byteLength(body) },
    };
  }
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(key ? { "X-N8N-API-KEY": key } : {}) },
      body,
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    if (!res.ok) {
      emitBus(db, "n8n.failed", { subject: workflowPath, data: { httpStatus: res.status, body: text.slice(0, 300) } });
      return { status: "FAILED", error: `n8n HTTP ${res.status}: ${text.slice(0, 300)}`, evidence: { url, sentAt: new Date().toISOString(), payloadBytes: Buffer.byteLength(body) } };
    }
    let parsed: Record<string, unknown> = {};
    try { parsed = JSON.parse(text) as Record<string, unknown>; } catch { /* webhook pode responder texto */ }
    const executionId = (parsed.executionId ?? (parsed.execution as Record<string, unknown> | undefined)?.id ?? parsed.id) as string | number | undefined;
    emitBus(db, "n8n.triggered", { subject: workflowPath, data: { executionId } });
    return { status: "TRIGGERED", executionId, evidence: { url, sentAt: new Date().toISOString(), payloadBytes: Buffer.byteLength(body) } };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    emitBus(db, "n8n.failed", { subject: workflowPath, data: { error: msg } });
    return { status: "FAILED", error: msg, evidence: { url, sentAt: new Date().toISOString(), payloadBytes: Buffer.byteLength(body) } };
  }
}

/** Consulta status de uma execução pela API oficial do n8n. */
export async function getExecution(executionId: string | number): Promise<N8nExecutionStatus> {
  const { base, key } = cfg();
  if (!base) return { status: "BLOCKED", error: "N8N_BASE_URL não configurada" };
  try {
    const res = await fetch(`${base}/api/v1/executions/${executionId}`, {
      headers: { ...(key ? { "X-N8N-API-KEY": key } : {}) },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return { status: "UNKNOWN", error: `n8n HTTP ${res.status}` };
    const data = await res.json() as { status?: string; data?: { resultData?: { error?: unknown } } };
    const raw = String(data.status ?? "").toLowerCase();
    if (raw === "success" || raw === "finished") {
      const hasError = Boolean(data.data?.resultData?.error);
      return hasError ? { status: "FAILED", data } : { status: "COMPLETED", data };
    }
    if (raw === "error" || raw === "canceled" || raw === "crashed") return { status: "FAILED", data };
    if (raw === "running" || raw === "waiting" || raw === "new") return { status: "RUNNING", data };
    return { status: "UNKNOWN", data };
  } catch (err) {
    return { status: "UNKNOWN", error: err instanceof Error ? err.message : String(err) };
  }
}

export interface WaitOptions { timeoutMs?: number; pollMs?: number }

/** Poll até COMPLETED/FAILED ou timeout — para tasks síncronas no fluxo do Gerente. */
export async function waitForExecution(
  db: DatabaseSync | null,
  executionId: string | number,
  opts: WaitOptions = {},
): Promise<N8nExecutionStatus> {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const pollMs = opts.pollMs ?? 3_000;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const st = await getExecution(executionId);
    if (st.status === "COMPLETED") { emitBus(db, "n8n.completed", { subject: String(executionId) }); return st; }
    if (st.status === "FAILED") { emitBus(db, "n8n.failed", { subject: String(executionId), data: { error: st.error } }); return st; }
    if (st.status === "BLOCKED") return st;
    if (Date.now() >= deadline) return { status: "UNKNOWN", error: `timeout aguardando execução ${executionId}` };
    await new Promise((r) => setTimeout(r, pollMs));
  }
}
