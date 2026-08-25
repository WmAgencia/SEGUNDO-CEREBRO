import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { openDatabase, applySchema } from "../storage/connection.ts";
import { touchHeartbeat, detectOrphanedRuns, checkEvidence, requireEvidence } from "../core/agents/runtime-ops.ts";
import { emitBus, BUS_EVENTS, recentBusEvents } from "../core/hq/event-bus.ts";
import { triggerWorkflow, getExecution, waitForExecution, isN8nConfigured } from "../core/integrations/n8n-adapter.ts";
import { getDailyLlmCost, checkDailyBudget, BudgetExceededError } from "../core/ai/cost-control.ts";

let dir: string;
let db: DatabaseSync;

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "runtime2-"));
  db = openDatabase(path.join(dir, "b.db"));
  applySchema(db);
});

afterAll(() => {
  try { db.close(); rmSync(dir, { recursive: true, force: true }); } catch {}
});

/* ── G1: HEARTBEAT / ORPHANS ── */
describe("Runtime ops — heartbeat e orphans", () => {
  function seedRun(id: string, state: string, heartbeatAt: string | null) {
    db.prepare(
      `INSERT INTO agent_runs (id, session_id, agent_id, state, heartbeat_at, correlation_id)
       VALUES (?,?,?,?,?,?)`,
    ).run(id, "s1", "developer-01", state, heartbeatAt, `corr-${id}`);
  }

  it("touchHeartbeat atualiza heartbeat_at sem alterar estado", () => {
    seedRun("run-hb", "RUNNING", null);
    touchHeartbeat(db, "run-hb");
    const row = db.prepare("SELECT state, heartbeat_at FROM agent_runs WHERE id=?").get("run-hb") as { state: string; heartbeat_at: string };
    expect(row.state).toBe("RUNNING");
    expect(row.heartbeat_at).toBeTruthy();
  });

  it("run com heartbeat expirado → ORPHANED + evento + task reenfileirada", () => {
    db.prepare(`INSERT INTO initiatives (id,title,status) VALUES ('init-orp','t','APPROVED')`).run();
    db.prepare(
      `INSERT INTO initiative_tasks (id, initiative_id, ordinal, title, status, assigned_agent)
       VALUES (777,'init-orp',1,'trabalho real','RUNNING','developer-01')`,
    ).run();
    seedRun("run-orp", "RUNNING", new Date(Date.now() - 60 * 60_000).toISOString());
    db.prepare("UPDATE agent_runs SET task_id=777 WHERE id='run-orp'").run();

    const report = detectOrphanedRuns(db, { timeoutMinutes: 10 });
    expect(report.detected).toContain("run-orp");
    expect(report.recovered).toContain("777");

    const run = db.prepare("SELECT state FROM agent_runs WHERE id='run-orp'").get() as { state: string };
    expect(run.state).toBe("ORPHANED");
    const task = db.prepare("SELECT status, assigned_agent FROM initiative_tasks WHERE id=777").get() as { status: string; assigned_agent: string | null };
    expect(task.status).toBe("READY");
    expect(task.assigned_agent).toBeNull();

    const evt = db.prepare("SELECT payload FROM events WHERE event_type='run.orphaned' ORDER BY id DESC LIMIT 1").get() as { payload: string };
    expect(JSON.parse(evt.payload).taskId).toBe(777);
  });

  it("heartbeat recente NÃO é marcado como orphan", () => {
    seedRun("run-fresh", "RUNNING", new Date().toISOString());
    const report = detectOrphanedRuns(db, { timeoutMinutes: 10 });
    expect(report.detected).not.toContain("run-fresh");
    expect((db.prepare("SELECT state FROM agent_runs WHERE id='run-fresh'").get() as {state:string}).state).toBe("RUNNING");
  });
});

/* ── G3: EVIDENCE GATE ── */
describe("Evidence gate — agente não pode só 'dizer que fez'", () => {
  it("recusa output vazio/curto", () => {
    expect(checkEvidence({ summary: "s", output: "pronto" }).ok).toBe(false);
  });
  it("recusa output longo sem artifact/source", () => {
    const r = checkEvidence({ summary: "s", output: "Pesquisei 100 empresas e montei a lista completa com contatos." , artifacts: [], sources: [] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/NOT VERIFIED/);
  });
  it("aceita com artifact OU source", () => {
    expect(checkEvidence({ summary: "s", output: "Lista final consolidada com 100 leads qualificados.", artifacts: ["leads.csv"] }).ok).toBe(true);
    expect(checkEvidence({ summary: "s", output: "Análise concluída com fontes verificadas hoje.", sources: ["https://exemplo.com"] }).ok).toBe(true);
  });
  it("requireEvidence retorna submitted=false quando sem evidência", () => {
    const r = requireEvidence({ summary: "s", output: "feito" });
    expect(r.submitted).toBe(false);
  });
});

/* ── G4: EVENT BUS ── */
describe("Event bus — catálogo tipado com provenance", () => {
  it("emite evento enriquecido e consulta por tipo", () => {
    emitBus(db, "task.rework", { subject: "task-777", runId: "run-x", taskId: 777, agentId: "qa-agent", data: { attempt: 2 } });
    const rows = recentBusEvents(db, { types: ["task.rework"], limit: 5 }) as unknown as Array<{ event_type: string; payload: string }>;
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const payload = JSON.parse(rows[0]!.payload);
    expect(payload.runId).toBe("run-x");
    expect(payload.taskId).toBe(777);
    expect(payload.ts).toBeTruthy();
  });
  it("catálogo cobre eventos da spec §37", () => {
    for (const required of ["goal.created", "handoff.created", "approval.approved", "obsidian.synced"]) {
      expect(BUS_EVENTS).toContain(required);
    }
  });
});

/* ── G2: N8N ADAPTER ── */
describe("n8n adapter — BLOCKED quando não configurado; real contra servidor local", () => {
  afterEach(() => {
    delete process.env.N8N_BASE_URL;
    delete process.env.N8N_API_KEY;
  });

  it("sem env → BLOCKED honesto, sem chamada de rede", async () => {
    expect(isN8nConfigured()).toBe(false);
    const r = await triggerWorkflow(db, "prospeccao-ciclo", { foo: 1 });
    expect(r.status).toBe("BLOCKED");
    expect(r.error).toMatch(/N8N_BASE_URL/);
    const st = await getExecution(123);
    expect(st.status).toBe("BLOCKED");
  });

  it("workflow configurado dispara POST real e registra evidência + evento", async () => {
    const received: { v: { path: string; body: Record<string, unknown> } | null } = { v: null };
    const server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        received.v = { path: req.url ?? "", body: JSON.parse(raw || "{}") };
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ executionId: 4242 }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    process.env.N8N_BASE_URL = `http://127.0.0.1:${port}`;

    const r = await triggerWorkflow(db, "prospeccao-ciclo", { ciclo: "noturno" });
    expect(r.status).toBe("TRIGGERED");
    expect(r.executionId).toBe(4242);
    expect(r.evidence.payloadBytes).toBeGreaterThan(10);
    expect(received.v).not.toBeNull();
    if (received.v) {
      expect(received.v.path).toBe("/prospeccao-ciclo");
      expect((received.v.body as { source: string }).source).toBe("second-brain-hq");
    }
    const evt = recentBusEvents(db, { types: ["n8n.triggered"], limit: 1 })[0];
    expect(evt).toBeTruthy();
    server.close();
  });

  it("falha HTTP do provider é registrada como FAILED — nunca mascarada", async () => {
    const server = http.createServer((req, res) => { res.writeHead(500); res.end("boom"); });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    process.env.N8N_BASE_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const r = await triggerWorkflow(null, "wf-x", {});
    expect(r.status).toBe("FAILED");
    expect(r.error).toMatch(/HTTP 500/);
    server.close();
  });

  it("waitForExecution poll até COMPLETED", async () => {
    let calls = 0;
    const server = http.createServer((req, res) => {
      calls++;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: calls >= 2 ? "success" : "running" }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    process.env.N8N_BASE_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const st = await waitForExecution(null, 99, { pollMs: 20, timeoutMs: 4000 });
    expect(st.status).toBe("COMPLETED");
    expect(calls).toBeGreaterThanOrEqual(2);
    server.close();
  });
});

/* ── G5: COST BUDGET ── */
describe("Cost control — budget diário de LLM", () => {
  it("soma custos do dia a partir de model_generations", () => {
    db.prepare("INSERT INTO model_generations (provider,model,status,cost,created_at) VALUES ('groq','m','COMPLETED',0.03,?)")
      .run(new Date().toISOString());
    db.prepare("INSERT INTO model_generations (provider,model,status,cost,created_at) VALUES ('openrouter','m','COMPLETED',0.02,?)")
      .run(new Date().toISOString());
    db.prepare("INSERT INTO model_generations (provider,model,status,cost,created_at) VALUES ('groq','m','FAILED',9.99,'2020-01-01T00:00:00Z')")
      .run();
    const spent = getDailyLlmCost(db);
    expect(spent).toBeCloseTo(0.05, 5);
  });

  it("sem limite configurado → ok (comportamento preservado)", () => {
    delete process.env.SECOND_BRAIN_DAILY_COST_LIMIT;
    expect(checkDailyBudget(db).ok).toBe(true);
  });

  it("com limite excedido → bloqueia e erro carrega valores reais", () => {
    process.env.SECOND_BRAIN_DAILY_COST_LIMIT = "0.01";
    const c = checkDailyBudget(db);
    expect(c.ok).toBe(false);
    expect(c.spentToday).toBeCloseTo(0.05, 5);
    expect(() => { throw new BudgetExceededError(c.spentToday, c.limitPerDay); }).toThrow(/budget diário/);
    delete process.env.SECOND_BRAIN_DAILY_COST_LIMIT;
  });
});
