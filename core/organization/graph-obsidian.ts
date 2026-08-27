/**
 * Graph → Obsidian outcome persistence (FASE 3.6).
 *
 * Rule of the phase: Obsidian is the human-readable knowledge layer. After a
 * Graph run finishes, only USEFUL, deduplicated knowledge is written there —
 * never a technical dump. Before writing we locate the existing entity, then
 * determine the correct folder, then update the existing note OR create a new
 * one only when necessary (never a pile of duplicated notes).
 *
 * Provenance is always carried: source, created_at, updated_at, session_id,
 * graph_id, node_id, origin.
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import type { BrainConfig } from "../config/loader.ts";
import type { GraphRun, GraphNode } from "../orchestration/types.ts";
import { getRun, listNodes, getNode } from "../orchestration/graph-store.ts";

export interface GraphOutcomeWrite {
  written: boolean;
  path: string | null;
  action: "created" | "updated" | "skipped";
  reason?: string;
}

interface OutcomeSummary {
  goal: string;
  status: string;
  strategy: string[];
  decisions: string[];
  tasks: Array<{ id: string; title: string; status: string; evidence: Array<{ kind: string; value: string }> }>;
  results: string[];
  evidence: Array<{ kind: string; value: string }>;
  learnings: string[];
}

function safeStr(v: unknown, fallback = ""): string {
  if (v === null || v === undefined) return fallback;
  return String(v);
}

function ts(): string {
  return new Date().toISOString();
}

function slug(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 70) || "graph";
}

function noteHeading(items: string[], label: string): string {
  const trimmed = items.map((i) => i.trim()).filter(Boolean);
  if (!trimmed.length) return "";
  return `## ${label}\n\n${trimmed.map((i) => `- ${i}`).join("\n")}\n`;
}

function buildContent(run: GraphRun, nodes: GraphNode[], s: OutcomeSummary): string {
  const lines: string[] = [
    "---",
    "type: graph_result",
    `graph_id: "${run.id}"`,
    `session_id: "${run.sessionKey}"`,
    `source: "second-brain"`,
    `origin: "graph-orchestration"`,
    `created_at: "${run.createdAt}"`,
    `updated_at: "${ts()}"`,
    `status: "${run.status}"`,
    "---",
    "",
    `# ${run.status === "COMPLETED" ? "Resultado" : "Resultado parcial"} — ${run.goal}`,
    "",
    `> Pedido: ${run.request.slice(0, 400)}`,
    "",
  ];

  lines.push(`**Status do run:** ${run.status}`);
  lines.push(`**Nós:** ${nodes.filter((n) => n.status === "COMPLETED").length}/${nodes.length} concluídos`);
  lines.push("");
  lines.push(noteHeading(s.strategy, "Estratégia"));
  lines.push(noteHeading(s.decisions, "Decisões"));
  lines.push(noteHeading(s.results, "Resultados"));
  lines.push(noteHeading(s.learnings, "Aprendizados"));
  lines.push(noteHeading(s.evidence.map((e) => `${e.kind}: ${e.value.slice(0, 200)}`), "Evidência"));

  if (s.tasks.length) {
    lines.push("## Tarefas (nós)", "");
    for (const t of s.tasks) {
      lines.push(`- **${t.title}** — ${t.status}`);
      const evid = t.evidence.map((e) => `${e.kind}: ${e.value.slice(0, 120)}`).join("; ");
      if (evid) lines.push(`  - ${evid}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

function summarizeOutcome(run: GraphRun, nodes: GraphNode[]): OutcomeSummary {
  const strategy: string[] = [];
  const decisions: string[] = [];
  const results: string[] = [];
  const learnings: string[] = [];
  const evidence: Array<{ kind: string; value: string }> = [];
  const tasks: OutcomeSummary["tasks"] = [];

  if (run.result?.summary) {
    const r = run.result.summary as Record<string, unknown>;
    for (const c of Array.isArray(r.completed) ? (r.completed as string[]) : []) results.push(`Concluído: ${c}`);
    for (const c of Array.isArray(r.blocked) ? (r.blocked as string[]) : []) results.push(`Bloqueado: ${c}`);
    for (const c of Array.isArray(r.failed) ? (r.failed as string[]) : []) results.push(`Falhou: ${c}`);
  }

  for (const n of nodes) {
    const evid = (n.evidence ?? []).map((e) => ({ kind: e.kind, value: e.value.slice(0, 300) }));
    tasks.push({ id: n.id, title: n.title, status: n.status, evidence: evid.slice(0, 6) });
    evidence.push(...evid.slice(0, 6));

    const out = n.output;
    const text = out ? safeStr(out.output ?? (typeof out === "string" ? out : JSON.stringify(out)).slice(0, 400)) : "";
    if (n.status === "COMPLETED" && text.length > 10) {
      if (/estrateg|abordagem|plano|pr[óo]ximo passo|mensagem/i.test(text)) strategy.push(n.title);
      else if (/decis[ãa]o|decidir|escolh/i.test(text)) decisions.push(n.title);
      else results.push(n.title);
    }
    if (/aprendizad|lessons?|li[çc][ãa]o/i.test(text)) learnings.push(n.title);
  }

  return { goal: run.goal, status: run.status, strategy, decisions, tasks, results, evidence: evidence.slice(0, 12), learnings: learnings.slice(0, 6) };
}

/**
 * Persists the outcome of a finished graph run to Obsidian as a single
 * deduplicated note: locate existing graph note (by graph_id), update it, or
 * create a new one. Returns what happened.
 */
export function persistGraphOutcome(config: BrainConfig, runId: string, opts: { force?: boolean } = {}): GraphOutcomeWrite {
  const run = getRun(config, runId);
  if (!run) return { written: false, path: null, action: "skipped", reason: `run not found: ${runId}` };

  const nodes = listNodes(config, runId);
  const useful = nodes.some((n) => n.status === "COMPLETED" && (n.output !== null && n.output !== undefined));
  if (!opts.force && !useful) {
    return { written: false, path: null, action: "skipped", reason: "nenhum nó concluído com conteúdo útil (não é conhecimento do vault)" };
  }

  const folder = path.join(config.vaultPath, "08 - Context", "Graphs");
  const filePath = path.join(folder, `${slug(run.goal)}--${slug(run.id)}.md`);
  mkdirSync(folder, { recursive: true });

  const existing = existsSync(filePath) ? readFileSync(filePath, "utf8") : "";
  const already = /graph_id: "([^"]+)"/.exec(existing)?.[1];
  const action: "created" | "updated" = already === run.id ? "updated" : "created";

  const content = buildContent(run, nodes, summarizeOutcome(run, nodes));
  writeFileSync(filePath, content, "utf8");
  return { written: true, path: path.relative(config.vaultPath, filePath).replaceAll("\\", "/"), action, reason: action === "created" ? "nova nota de resultado de graph" : "nota atualizada (mesmo graph_id)" };
}

export function evidenceFromNode(config: BrainConfig, nodeId: string): Array<{ kind: string; value: string }> {
  const n = getNode(config, nodeId);
  return n?.evidence ?? [];
}

export interface PersistGoalResult {
  written: boolean;
  path: string | null;
  action: "created" | "updated" | "skipped";
  reason?: string;
}

/** Persist a single goal as a deduplicated Obsidian note under 10 - GOALS. */
export function persistGoalNote(
  config: BrainConfig,
  goal: { id: string; name: string; type?: string; status?: string; target?: number | null; currentValue?: number | null; deadline?: string | null; description?: string },
): PersistGoalResult {
  const folder = path.join(config.vaultPath, "10 - GOALS");
  const filePath = path.join(folder, `${slug(goal.id)}.md`);

  const fields = [
    "---",
    "type: goal",
    `goal_id: "${goal.id}"`,
    `name: "${goal.name.replace(/"/g, "'")}"`,
    `source: "second-brain"`,
    `origin: "goal-engine"`,
    `created_at: "${ts()}"`,
    `updated_at: "${ts()}"`,
    `status: "${goal.status ?? "ACTIVE"}"`,
    ...(goal.type ? [`goal_type: "${goal.type}"`] : []),
    ...(goal.target != null ? [`target: "${goal.target}"`] : []),
    ...(goal.currentValue != null ? [`current_value: "${goal.currentValue}"`] : []),
    ...(goal.deadline ? [`deadline: "${goal.deadline}"`] : []),
    "---",
    "",
    `# ${goal.name}`,
    "",
    ...(goal.description ? [`${goal.description}`, ""] : []),
    "**Status:** " + (goal.status ?? "ACTIVE"),
    ...(goal.target != null ? ["", `**Meta:** ${goal.target}`] : []),
    "",
  ].join("\n");

  try {
    mkdirSync(folder, { recursive: true });
    const existing = existsSync(filePath) ? readFileSync(filePath, "utf8") : "";
    const already = /goal_id: "([^"]+)"/.exec(existing)?.[1];
    const action: "created" | "updated" = already === goal.id ? "updated" : "created";
    writeFileSync(filePath, fields, "utf8");
    return { written: true, path: path.relative(config.vaultPath, filePath).replaceAll("\\", "/"), action, reason: action === "created" ? "nova nota de objetivo" : "nota de objetivo atualizada" };
  } catch (error) {
    return { written: false, path: null, action: "skipped", reason: error instanceof Error ? error.message : String(error) };
  }
}