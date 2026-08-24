import { DatabaseSync } from "node:sqlite";
import path, { relative } from "node:path";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { ValidationError } from "../errors/errors.ts";

export const AGENT_STATES = ["IDLE", "READY", "PLANNING", "RUNNING", "WAITING_TOOL", "WAITING_AGENT", "WAITING_EXTERNAL_AI", "EVALUATING", "REWORKING", "BLOCKED", "WAITING_HUMAN", "PAUSED", "CANCELLED", "COMPLETED", "FAILED"] as const;
export type AgentState = typeof AGENT_STATES[number];
export type EvalStatus = "PASS" | "FAIL" | "NEEDS_REWORK";

const transitions: Record<AgentState, readonly AgentState[]> = {
  IDLE: ["READY"], READY: ["PLANNING"], PLANNING: ["RUNNING"], RUNNING: ["WAITING_TOOL", "WAITING_AGENT", "WAITING_EXTERNAL_AI", "EVALUATING"],
  WAITING_TOOL: ["RUNNING"], WAITING_AGENT: ["RUNNING"], WAITING_EXTERNAL_AI: ["RUNNING"], EVALUATING: ["COMPLETED", "REWORKING"],
  REWORKING: ["RUNNING", "BLOCKED"], BLOCKED: ["READY"], WAITING_HUMAN: ["RUNNING", "CANCELLED"], PAUSED: ["READY"],
  CANCELLED: [], COMPLETED: [], FAILED: [],
};

export function canTransition(from: AgentState, to: AgentState): boolean {
  if (to === "BLOCKED" || to === "WAITING_HUMAN" || to === "PAUSED" || to === "CANCELLED" || to === "FAILED") return from !== "COMPLETED" && from !== "CANCELLED";
  return transitions[from].includes(to);
}
export function transition(from: AgentState, to: AgentState): AgentState {
  if (!canTransition(from, to)) throw new ValidationError(`invalid agent transition: ${from} -> ${to}`);
  return to;
}

export interface Budget { maxTimeMs?: number; maxToolCalls?: number; maxRetries?: number; maxExternalAiCalls?: number; maxCost?: number; }
export interface Usage { elapsedMs?: number; toolCalls?: number; retries?: number; externalAiCalls?: number; cost?: number; }
export function budgetExceeded(budget: Budget, usage: Usage): string | null {
  if (budget.maxTimeMs !== undefined && (usage.elapsedMs ?? 0) >= budget.maxTimeMs) return "time budget exceeded";
  if (budget.maxToolCalls !== undefined && (usage.toolCalls ?? 0) >= budget.maxToolCalls) return "tool budget exceeded";
  if (budget.maxRetries !== undefined && (usage.retries ?? 0) >= budget.maxRetries) return "retry budget exceeded";
  if (budget.maxExternalAiCalls !== undefined && (usage.externalAiCalls ?? 0) >= budget.maxExternalAiCalls) return "external AI budget exceeded";
  if (budget.maxCost !== undefined && (usage.cost ?? 0) >= budget.maxCost) return "cost budget exceeded";
  return null;
}
export interface ContextItem { content: string; source: string; relevanceScore: number; }
export interface ContextInput { task: string; state: AgentState; project?: string; decisions?: string[]; memories?: string[]; obsidian?: string[]; skills?: string[]; tools?: string[]; history?: string[]; maxChars?: number; }

export function compileContext(input: ContextInput): { text: string; items: ContextItem[]; chars: number } {
  const groups: Array<[string, string[] | undefined]> = [["task", [input.task]], ["state", [input.state]], ["project", input.project ? [input.project] : undefined], ["decisions", input.decisions], ["memory", input.memories], ["obsidian", input.obsidian], ["skills", input.skills], ["tools", input.tools], ["history", input.history]];
  const items: ContextItem[] = [];
  for (let group = 0; group < groups.length; group++) for (const content of groups[group]![1] ?? []) if (content.trim()) items.push({ content, source: groups[group]![0], relevanceScore: 1 - group / groups.length });
  const max = input.maxChars ?? 12000; const selected: ContextItem[] = []; let chars = 0;
  for (const item of items) { const room = max - chars; if (room <= 0) break; const content = item.content.slice(0, room); selected.push({ ...item, content }); chars += content.length; }
  return { text: selected.map((x) => `[${x.source}] ${x.content}`).join("\n"), items: selected, chars };
}

export interface SandboxPolicy { projectId: string; workspacePath: string; allowedPaths: string[]; blockedPaths: string[]; allowedCommands: string[]; blockedCommands: string[]; networkPolicy: "localhost_only" | "none" | "any"; }
export function validateSandbox(policy: SandboxPolicy, targetPath: string, command?: string): { allowed: boolean; reason?: string } {
  const target = path.resolve(policy.workspacePath, targetPath); const rel = relative(policy.workspacePath, target).replaceAll("\\", "/");
  if (rel.startsWith("../") || policy.blockedPaths.some((p) => pathPattern(p, rel, target))) return { allowed: false, reason: "path blocked by sandbox" };
  if (policy.allowedPaths.length && !policy.allowedPaths.some((p) => pathPattern(p, rel, target))) return { allowed: false, reason: "path outside allowed scope" };
  if (command && (policy.blockedCommands.some((x) => command.includes(x)) || !policy.allowedCommands.some((x) => command === x || command.startsWith(`${x} `)))) return { allowed: false, reason: "command blocked by sandbox" };
  return { allowed: true };
}
function pathPattern(pattern: string, rel: string, absolute: string): boolean { const p = pattern.replaceAll("\\", "/").replace(/[.+^${}()|[\]\\]/g, "\\$&").replaceAll("**", ".*").replaceAll("*", "[^/]*"); return new RegExp(`^${p}$`, "i").test(rel) || new RegExp(`^${p}$`, "i").test(absolute); }

export interface ToolContract { id: string; inputSchema: Record<string, unknown>; outputSchema: Record<string, unknown>; risk: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL"; sideEffects: string[]; permissions: string[]; }
export function authorizeTool(contract: ToolContract, input: unknown, requestedPermission: string, allowedRisk: string = "HIGH"): { allowed: boolean; reason?: string } {
  if (!contract.permissions.includes("*") && !contract.permissions.includes(requestedPermission)) return { allowed: false, reason: "permission denied" };
  const rank = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 }; if (rank[contract.risk] > rank[allowedRisk as keyof typeof rank]) return { allowed: false, reason: "risk exceeds policy" };
  if (input === null || input === undefined || typeof input !== "object") return { allowed: false, reason: "invalid tool input" };
  const serialized = JSON.stringify(input); if (/(api[_-]?key|token|password|secret)\s*[:=]/i.test(serialized)) return { allowed: false, reason: "secret-like input blocked" };
  return { allowed: true };
}

export interface RunInput { task: string; agentId: string; projectId?: string; taskId?: number; initiativeId?: string; budget?: Budget; }
export interface AgentRun { id: string; sessionId: string; state: AgentState; currentStep: number; completedSteps: string[]; pendingSteps: string[]; retryCount: number; correlationId: string; causationId?: string; }
export interface RunStepResult { ok: boolean; output?: string; rework?: boolean; }
export class ProfessionalAgentHarness {
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync) { this.db = db; }
  start(input: RunInput): AgentRun { const id = `run.${randomUUID()}`; const sessionId = `session.${randomUUID()}`; const correlationId = `corr.${randomUUID()}`; this.db.prepare(`INSERT INTO agent_runs (id,session_id,task_id,initiative_id,agent_id,project_id,state,pending_steps,budgets,correlation_id) VALUES (?,?,?,?,?,?, 'IDLE',?,?,?)`).run(id, sessionId, input.taskId ?? null, input.initiativeId ?? null, input.agentId, input.projectId ?? null, JSON.stringify([input.task]), JSON.stringify(input.budget ?? {}), correlationId); this.trace(id, "run_started", "IDLE", { task: input.task }, correlationId); return this.get(id); }
  get(id: string): AgentRun { const r = this.db.prepare("SELECT * FROM agent_runs WHERE id=?").get(id) as Record<string, unknown> | undefined; if (!r) throw new ValidationError(`run not found: ${id}`); return this.map(r); }
  move(id: string, to: AgentState, causationId?: string): AgentRun { const r = this.get(id); const next = transition(r.state, to); this.db.prepare("UPDATE agent_runs SET previous_state=state,state=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?").run(next, id); this.trace(id, "state_changed", next, { from: r.state }, r.correlationId, causationId); return this.get(id); }
  checkpoint(id: string, snapshot: Record<string, unknown> = {}): void { const r = this.get(id); this.db.prepare("INSERT INTO agent_checkpoints (run_id,state,current_step,snapshot,correlation_id,causation_id) VALUES (?,?,?,?,?,?)").run(id, r.state, r.currentStep, JSON.stringify(snapshot), r.correlationId, null); this.trace(id, "checkpoint", r.state, snapshot, r.correlationId); }
  resume(id: string): AgentRun { const r = this.get(id); if (r.state !== "PAUSED" && r.state !== "FAILED") return r; return this.move(id, "READY"); }
  requestHuman(id: string, reason: string): AgentRun { const r = this.get(id); this.move(id, "WAITING_HUMAN"); this.trace(id, "human_checkpoint_requested", "WAITING_HUMAN", { reason }, r.correlationId); return this.get(id); }
  resolveHuman(id: string, approved: boolean, feedback = ""): AgentRun { const r = this.get(id); const next: AgentState = approved ? "RUNNING" : "CANCELLED"; this.move(id, next); this.trace(id, "human_checkpoint_resolved", next, { approved, feedback }, r.correlationId); return this.get(id); }
  async run(id: string, steps: PlanStep[], worker: (step: PlanStep, run: AgentRun) => Promise<RunStepResult>, budget: Budget = {}): Promise<AgentRun> {
    let run = this.get(id); if (run.state === "IDLE") run = this.move(id, "READY"); if (run.state === "READY") run = this.move(id, "PLANNING"); if (run.state === "PLANNING") run = this.move(id, "RUNNING");
    const started = Date.now();
    for (const step of steps) {
      run = this.get(id); const reason = budgetExceeded(budget, { elapsedMs: Date.now() - started, retries: run.retryCount });
      if (reason) { this.trace(id, "budget_stopped", run.state, { reason }, run.correlationId); return this.move(id, "BLOCKED"); }
      if (run.state === "CANCELLED" || run.state === "PAUSED" || run.state === "BLOCKED") return run;
      this.checkpoint(id, { step: step.id, title: step.title });
      const result = await worker(step, run);
      if (!result.ok) { this.move(id, "EVALUATING"); this.move(id, "REWORKING"); const current = this.get(id); if ((budget.maxRetries ?? 3) <= current.retryCount) return this.move(id, "BLOCKED"); this.db.prepare("UPDATE agent_runs SET retry_count=retry_count+1 WHERE id=?").run(id); run = this.move(id, "RUNNING"); continue; }
      this.db.prepare("UPDATE agent_runs SET current_step=current_step+1,completed_steps=json_insert(completed_steps,'$[#]',?),pending_steps=json_remove(pending_steps,'$[0]'),last_successful_action=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?").run(step.id, result.output ?? step.title, id);
    }
    run = this.move(id, "EVALUATING"); this.recordEval(id, "pipeline_completed", "PASS", "all planned steps completed", steps.map((s) => s.id)); return this.move(id, "COMPLETED");
  }
  kill(id: string): AgentRun { const r = this.get(id); this.db.prepare("UPDATE agent_runs SET kill_switch=1,state='CANCELLED' WHERE id=?").run(id); this.trace(id, "kill_switch", "CANCELLED", {}, r.correlationId); return this.get(id); }
  recordEval(id: string, criterion: string, status: EvalStatus, feedback = "", evidence: string[] = []): void { this.db.prepare("INSERT INTO agent_evals (run_id,criterion,status,feedback,evidence) VALUES (?,?,?,?,?)").run(id, criterion, status, feedback, JSON.stringify(evidence)); }
  private trace(id: string, event: string, state: string, payload: Record<string, unknown>, correlationId: string, causationId?: string): void { this.db.prepare("INSERT INTO agent_traces (run_id,event,state,payload,correlation_id,causation_id) VALUES (?,?,?,?,?,?)").run(id, event, state, JSON.stringify(payload), correlationId, causationId ?? null); }
  private map(r: Record<string, unknown>): AgentRun { return { id: String(r.id), sessionId: String(r.session_id), state: String(r.state) as AgentState, currentStep: Number(r.current_step), completedSteps: JSON.parse(String(r.completed_steps)), pendingSteps: JSON.parse(String(r.pending_steps)), retryCount: Number(r.retry_count), correlationId: String(r.correlation_id), causationId: r.causation_id ? String(r.causation_id) : undefined }; }
}

export function nutrivaSandbox(root: string): SandboxPolicy { return { projectId: "nutriva", workspacePath: root, allowedPaths: ["src/**", "tests/**", "*.json", "*.md"], blockedPaths: [".env*", ".ssh/**", "../second-brain/**", "C:/Windows/**"], allowedCommands: ["npm test", "npm run typecheck", "node"], blockedCommands: ["rm -rf", "del /s", "format", "shutdown"], networkPolicy: "localhost_only" }; }
export function workspaceExists(policy: SandboxPolicy): boolean { return existsSync(policy.workspacePath); }

export const AGENT_EVAL_CRITERIA = ["correct_project", "correct_task", "no_repeated_completed_task", "context_retention", "correct_tool", "correct_agent", "failure_detection", "failure_recovery", "appropriate_external_ai", "policy_compliance", "decision_documentation", "obsidian_update", "checkpoint_resume", "budget_stopping", "kill_switch"] as const;

export interface PlanStep { id: string; title: string; role: "WORKER" | "OPENCODE" | "TEST" | "DOCUMENT" | "LEARN" | "SECOM"; }
export interface HandoffPackage { fromAgent: string; toAgent: string; summary: string; context: ReturnType<typeof compileContext>; correlationId: string; causationId: string; }
export interface SecomCommand { senderId: string; groupId: string; text: string; }

export function planTask(task: string): PlanStep[] {
  return [
    { id: "observe", title: "OBSERVE", role: "WORKER" }, { id: "context", title: "CONTEXT", role: "WORKER" },
    { id: "plan", title: `PLAN: ${task}`, role: "WORKER" }, { id: "worker", title: "WORKER", role: "WORKER" },
    { id: "opencode", title: "OPENCODE", role: "OPENCODE" }, { id: "test", title: "TEST", role: "TEST" },
    { id: "evaluate", title: "EVALUATOR", role: "WORKER" }, { id: "document", title: "DOCUMENT", role: "DOCUMENT" },
    { id: "learn", title: "LEARN", role: "LEARN" }, { id: "secom", title: "SECOM", role: "SECOM" }, { id: "next", title: "NEXT TASK", role: "WORKER" },
  ];
}

export function createHandoff(input: { fromAgent: string; toAgent: string; task: string; summary: string; context: ContextInput; correlationId?: string; causationId?: string }): HandoffPackage {
  return { fromAgent: input.fromAgent, toAgent: input.toAgent, summary: input.summary, context: compileContext(input.context), correlationId: input.correlationId ?? `corr.${randomUUID()}`, causationId: input.causationId ?? `cause.${randomUUID()}` };
}

export function authorizeSecomCommand(command: SecomCommand, ownerId = "15981817336", groupId = "120363427273069174@g.us"): boolean {
  return command.groupId === groupId && command.senderId.replace(/\D/g, "") === ownerId.replace(/\D/g, "");
}

export function evaluateRun(criteria: Record<string, boolean>): { status: EvalStatus; failed: string[] } {
  const failed = AGENT_EVAL_CRITERIA.filter((criterion) => criteria[criterion] === false);
  return { status: failed.length === 0 ? "PASS" : "NEEDS_REWORK", failed: [...failed] };
}
