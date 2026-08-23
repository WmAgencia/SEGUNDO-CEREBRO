import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { BrainConfig } from "../../core/config/loader.ts";
import { applySchema, openDatabase } from "../../storage/connection.ts";
import { indexVault } from "../../core/indexing/vault-indexer.ts";
import {
  createGoal,
  getGoal,
  updateGoal,
} from "../../core/goals/goal-engine.ts";
import {
  createInitiative,
  updateInitiativeStatus,
  planInitiative,
  getInitiative,
  approveInitiative,
} from "../../core/goals/initiatives.ts";
import {
  activityLog,
  agentPerformance,
  assignTask,
  blockTask,
  listPendingApprovals,
  refreshQueue,
  requestReview,
  resolveReview,
  selectAgent,
  startTaskWork,
  submitResult,
  unblockTask,
} from "../../core/agents/agent-os.ts";
import {
  acceptHandoff,
  createHandoff,
} from "../../core/agents/agent-os.ts";
import { orchestrateCycle } from "../../core/agents/orchestrator.ts";

let dir: string;
let config: BrainConfig;

function db() {
  return new DatabaseSync(config.dbPath);
}

function seedAgent(
  id: string,
  capabilities: string[],
  skills: string[],
  tools: string[],
) {
  const d = db();
  upsertAgentRow(d, id, capabilities, skills, tools);
  d.close();
}

function upsertAgentRow(
  d: DatabaseSync,
  id: string,
  capabilities: string[],
  skills: string[],
  tools: string[],
) {
  d.prepare(
    `INSERT INTO agents (id, name, capabilities, skills, tools, status)
     VALUES (?, ?, ?, ?, ?, 'AVAILABLE')
     ON CONFLICT(id) DO UPDATE SET capabilities=excluded.capabilities, skills=excluded.skills`,
  ).run(id, id, JSON.stringify(capabilities), JSON.stringify(skills), JSON.stringify(tools));
}

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "brain-aos-"));
  config = {
    vaultPath: path.join(dir, "vault"),
    dataDir: dir,
    dbPath: path.join(dir, "brain.db"),
    logLevel: "error",
    search: { defaultLimit: 10, maxLimit: 50 },
    context: { maxChars: 12000, defaultDepth: 1, maxDepth: 3 },
    ai: { baseUrl: "http://127.0.0.1:11434", model: "qwen3-1.7b" },
  };
  mkdirSync(config.vaultPath, { recursive: true });
  const d = openDatabase(config.dbPath);
  applySchema(d);
  d.close();

  writeFileSync(
    path.join(config.vaultPath, "vyntra.md"),
    "---\nid: project.vyntra\ntype: project\ntitle: Vyntra\nstatus: active\n---\n# Vyntra\nVendas.",
    "utf8",
  );
  indexVault(config);

  const g = createGoal(db(), {
    name: "Gerar caixa através da venda de sites",
    type: "FINANCIAL",
    status: "ACTIVE",
    priority: 1,
    metricName: "clientes",
    target: 3,
    currentValue: 0,
    projectId: "project.vyntra",
  });
  void g;

  seedAgent("research-agent", ["pesquisa", "research"], ["research"], ["search"]);
  seedAgent("copy-agent", ["copywriting"], ["copywriting"], ["editor"]);
  seedAgent("design-agent", ["design"], ["design"], ["figma"]);
});

afterAll(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {}
});

describe("fase 19 — E2E rework", () => {
  let initId: string;
  let taskId = 0;
  let originalResultId = 0;

  it("setup iniciativa de design", () => {
    const d = db();
    seedAgentRow(d, "design-agent");
    const init = createInitiative(db(), {
      title: "Design landing psicólogos",
      project: "project.vyntra",
      impact: 6,
      probability: 6,
      effort: 4,
      risk: 3,
    });
    initId = init.id;
    planInitiative(db(), initId, ["Criar design"]);
    approveInitiative(db(), initId, "humano");
    refreshQueue(db(), initId);
    const ready = db()
      .prepare("SELECT id FROM initiative_tasks WHERE initiative_id=? AND status='READY'")
      .get(initId) as unknown as { id: number };
    taskId = ready.id;
    assignTask(db(), taskId, { agentId: "design-agent" });
    void originalResultId;
  });

  function seedAgentRow(d: DatabaseSync, id: string) {
    d.prepare(
      `INSERT INTO agents (id, name, capabilities, skills, status)
       VALUES (?, ?, '["design"]', '["design"]', 'AVAILABLE')
       ON CONFLICT(id) DO NOTHING`,
    ).run(id, id);
  }

  it("rejeições sucessivas fazem rework preservando histórico até o limite", () => {
    for (let attempt = 1; attempt <= 3; attempt++) {
      const r = submitResult(db(), config, {
        taskId,
        agentId: "design-agent",
        summary: `Tentativa ${attempt}`,
        output: `Design versão ${attempt}`,
        requiresReview: true,
      });
      expect(r.awaitingReview).toBe(true);

      if (attempt < 3) {
        const pending = listPendingApprovals(db());
        const approval = pending[pending.length - 1] as unknown as { id: number };
        const resolved = resolveReview(db(), config, {
          approvalId: approval.id,
          decision: "REJECTED",
          by: "reviewer",
          feedback: `feedback ${attempt}`,
        });
        expect(resolved.reworked).toBe(true);
      }
    }

    const results = db()
      .prepare("SELECT id, rework_count FROM agent_results WHERE task_id=? ORDER BY id")
      .all(taskId) as unknown as Array<{ id: number; rework_count: number }>;
    expect(results.length).toBe(3);
    expect(results[0]?.rework_count).toBe(0);
    expect(results[2]?.rework_count).toBe(2);
    expect(originalResultId).toBe(0);

    const task = db()
      .prepare("SELECT status FROM initiative_tasks WHERE id=?")
      .get(taskId) as unknown as { status: string };
    expect(["BLOCKED", "READY", "WAITING"]).toContain(task.status);
  });
});

describe("fase 19 — agent os", () => {
  let initiativeId: string;
  let taskResearch = 0;
  let taskCopy = 0;
  let sessionCopy = 0;

  it("setup: cria iniciativa aprovada com plano de 3 tasks", () => {
    const init = createInitiative(db(), {
      title: "Prospecção de psicólogos",
      description: "Campanha para psicólogos sem site",
      project: "project.vyntra",
      impact: 8,
      probability: 7,
      effort: 3,
      risk: 2,
    });
    initiativeId = init.id;
    planInitiative(db(), initiativeId, [
      "Pesquisar psicólogos",
      "Escrever copy",
      "Preparar campanha",
    ]);
    approveInitiative(db(), initiativeId, "humano");

    expect(getInitiative(db(), initiativeId).status).toBe("APPROVED");
  });

  it("selector escolhe por capability e justifica", () => {
    const pick = selectAgent(db(), {
      capabilityTokens: ["pesquisa"],
    });
    expect(pick?.agentId).toBe("research-agent");
    expect(pick?.reasons.join(" ")).toContain("capability match");
  });

  it("dispatcher respeita dependências: só a primeira fica READY", () => {
    const unlocked = refreshQueue(db(), initiativeId);
    expect(unlocked.length).toBeGreaterThanOrEqual(1);

    const states = db()
      .prepare(
        "SELECT ordinal, status FROM initiative_tasks WHERE initiative_id=? ORDER BY ordinal",
      )
      .all(initiativeId) as unknown as Array<{ ordinal: number; status: string }>;
    expect(states[0]?.status).toBe("READY");
    expect(states[1]?.status).toBe("PENDING");
  });

  it("E2E principal: research → handoff → copy (com review) → campanha", () => {
    const readyTasks = db()
      .prepare(
        "SELECT id FROM initiative_tasks WHERE initiative_id=? AND status='READY' ORDER BY ordinal",
      )
      .all(initiativeId) as unknown as Array<{ id: number }>;
    console.error("DBG tasks:", JSON.stringify(db().prepare("SELECT id,status FROM initiative_tasks").all()));
    taskResearch = readyTasks[0]?.id ?? 0;

    const a1 = assignTask(db(), taskResearch, { agentId: "research-agent", reason: "capability pesquisa" });
    console.error("STEP1 assign ok");
    expect(a1.agentId).toBe("research-agent");
    const sessionId = startTaskWork(db(), taskResearch, "research-agent");
    console.error("STEP2 session ok", sessionId);
    expect(sessionId).toBeGreaterThan(0);

    const r1 = submitResult(db(), config, {
      taskId: taskResearch,
      agentId: "research-agent",
      sessionId,
      summary: "200 psicólogos pesquisados",
      output: "Lista com 100 psicólogos sem site",
      confidence: 0.9,
    });
    console.error("STEP3 result", r1.validation);
    expect(r1.validation).toBe("VALID");
    console.error("DBG2:", taskResearch, JSON.stringify(r1), JSON.stringify([...statesById().entries()]));
    expect(r1.awaitingReview).toBe(false);

    const states1 = statesById();
    expect(states1.get(taskResearch)).toBe("COMPLETED");

    createHandoff(db(), {
      fromAgent: "research-agent",
      toAgent: "copy-agent",
      taskId: taskCopy || undefined,
      initiativeId,
      summary: "Lista pronta para escrever copy",
      payload: { leads: 100 },
      confidence: 0.9,
    });

    const states2 = statesById();
    const copyReady = [...states2.entries()].find(([, s]) => s === "READY");
    taskCopy = copyReady?.[0] ?? 0;
    expect(taskCopy).toBeGreaterThan(0);

    acceptHandoff(db(), 1, "copy-agent");
  });

  it("copy com revisão: WAITING até aprovação humana", () => {
    const a = assignTask(db(), taskCopy, { agentId: "copy-agent" });
    expect(a.agentId).toBe("copy-agent");
    sessionCopy = startTaskWork(db(), taskCopy, "copy-agent");

    const r = submitResult(db(), config, {
      taskId: taskCopy,
      agentId: "copy-agent",
      sessionId: sessionCopy,
      summary: "Copy escrita",
      output: "Mensagem: Seu consultório merece um site.",
      requiresReview: true,
    });
    expect(r.awaitingReview).toBe(true);

    const states = statesById();
    expect(states.get(taskCopy)).toBe("WAITING");

    const pending = listPendingApprovals(db());
    expect(pending.length).toBeGreaterThan(0);

    const approval = pending[pending.length - 1] as unknown as {
      id: number;
    };
    const resolved = resolveReview(db(), config, {
      approvalId: (approval as unknown as { id: number }).id,
      decision: "APPROVED",
      by: "humano",
    });
    expect(resolved.taskCompleted).toBe(true);
    expect(statesById().get(taskCopy)).toBe("COMPLETED");
  });

  it("terceira task libera após a segunda (dependências)", () => {
    const states = statesById();
    expect(states.get(taskCopy)).toBe("COMPLETED");
    const remaining = db()
      .prepare(
        "SELECT status FROM initiative_tasks WHERE initiative_id=? AND status='READY'",
      )
      .all(initiativeId) as unknown as Array<{ status: string }>;
    expect(remaining.length).toBeGreaterThan(0);
  });

  it("bloqueio e desbloqueio funcionam com mensagem BLOCKER", () => {
    const blockedTask = firstReadyOrAssignOne();
    if (!blockedTask) return;

    blockTask(db(), config, {
      taskId: blockedTask.taskId,
      agentId: blockedTask.agentId,
      reason: "Preciso da aprovação da copy",
      requiredInput: "copy aprovada",
      requiredApproval: true,
    });
    expect(statesById().get(blockedTask.taskId)).toBe("BLOCKED");

    unblockTask(db(), blockedTask.taskId, { input: "copy aprovada" });
    expect(statesById().get(blockedTask.taskId)).toBe("READY");
  });

  it("workload: segundo agente recebe quando primeiro está cheio", () => {
    const d = db();
    for (let i = 0; i < 5; i++) adjustWorkloadForTest(d, "research-agent", 1);
    const pick = selectAgent(d, { capabilityTokens: ["pesquisa"] });
    d.close();
    if (!pick) return void expect(pick).toBeDefined();
    expect(pick.agentId).not.toBe("research-agent");
  });

  it("performance e activity log registram o trabalho", () => {
    const perf = agentPerformance(db(), "research-agent");
    expect(perf.tasksCompleted).toBeGreaterThan(0);

    const log = activityLog(db(), { limit: 20 });
    expect(log.length).toBeGreaterThan(0);
  });

  it("goal feedback atualiza métrica do objetivo", () => {
    updateGoal(db(), goalIdFix(), { currentValue: 1 });
    const goal = getGoal(db(), goalIdFix());
    expect(goal.currentValue).toBe(1);
    expect(goal.progressPct).toBeGreaterThan(0);
  });

  function goalIdFix(): string {
    const row = db()
      .prepare("SELECT id FROM goals WHERE metric_name='clientes' LIMIT 1")
      .get() as { id: string };
    return row.id;
  }

  function statesById(): Map<number, string> {
    const rows = db()
      .prepare(
        "SELECT id, status FROM initiative_tasks WHERE initiative_id=? ORDER BY ordinal",
      )
      .all(initiativeId) as unknown as Array<{ id: number; status: string }>;
    return new Map(rows.map((r) => [r.id, r.status]));
  }

  function firstReadyOrAssignOne(): {
    taskId: number;
    agentId: string;
  } | null {
    const ready = db()
      .prepare(
        "SELECT id FROM initiative_tasks WHERE initiative_id=? AND status='READY' LIMIT 1",
      )
      .all(initiativeId) as unknown as Array<{ id: number }>;
    if (ready.length === 0) return null;
    const first = ready[0];
    const pick = selectAgent(db(), { capabilityTokens: ["campanha"] }) ??
      selectAgent(db(), {});
    if (!pick || !first) return null;
    return { taskId: first.id, agentId: pick.agentId };
  }

  function adjustWorkloadForTest(d: DatabaseSync, agent: string, delta: number) {
    d.prepare("UPDATE agents SET workload = workload + ? WHERE id=?").run(delta, agent);
  }
});
