import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase, applySchema } from "../storage/connection.ts";
import { executeHqCommand, getHqSnapshot, requestHandoff, agentProfile } from "../core/hq/hq-api.ts";
import { OFFICE_DEPARTMENTS, deskPosition } from "../core/hq/office.ts";
import type { BrainConfig } from "../core/config/loader.ts";

let directory = "";
afterEach(() => { if (directory) rmSync(directory, { recursive: true, force: true }); directory = ""; });

function config(): BrainConfig {
  directory = mkdtempSync(path.join(tmpdir(), "second-brain-f39-"));
  const vaultPath = path.join(directory, "vault"); mkdirSync(vaultPath);
  return { vaultPath, dataDir: directory, dbPath: path.join(directory, "brain.db"), logLevel: "error", search: { defaultLimit: 10, maxLimit: 50 }, context: { maxChars: 12000, defaultDepth: 1, maxDepth: 3 }, ai: { baseUrl: "http://127.0.0.1", model: "test" } };
}

describe("Fase 39 — Agent Office E2E", () => {
  it("CENÁRIO 1: comando comercial cria Goal FINANCIAL → Initiative → Tasks reais", () => {
    const cfg = config(); const db = openDatabase(cfg.dbPath); applySchema(db); db.close();
    const session = "f39-commercial";
    const proposal = executeHqCommand(cfg, "Precisamos faturar R$5.000 até o final do mês.", session);
    expect(proposal.ok).toBe(true);
    expect(proposal.requiresConfirmation).toBe(true);
    const result = executeHqCommand(cfg, "Pode executar.", session);
    expect(result.ok).toBe(true);
    expect(result.actions?.some(a => a.status === "executed")).toBe(true);
    const db2 = openDatabase(cfg.dbPath);
    const goals = db2.prepare("SELECT id,type,target FROM goals WHERE type='FINANCIAL' ORDER BY id DESC LIMIT 1").get() as { id:string; type:string; target:number };
    const inits = db2.prepare("SELECT id FROM initiatives WHERE goal_id=?").all(goals.id) as unknown as Array<{ id:string }>;
    db2.close();
    expect(goals.type).toBe("FINANCIAL");
    expect(goals.target).toBe(5000);
    expect(inits.length).toBeGreaterThanOrEqual(1);
  });

  it("CENÁRIO 6: 'pare tudo' ativa kill switch e pausa runs; 'continue' recupera", () => {
    const cfg = config(); const db = openDatabase(cfg.dbPath); applySchema(db); db.close();
    const stop = executeHqCommand(cfg, "pare tudo", "f39-kill");
    expect(stop.ok).toBe(true);
    expect(stop.actions?.some(a => a.type === "kill_switch" && a.status === "executed")).toBe(true);
    const dbCheck = openDatabase(cfg.dbPath);
    const paused = dbCheck.prepare("SELECT COUNT(*) AS n FROM events WHERE event_type='kill_switch_activated'").get() as { n: number };
    dbCheck.close();
    expect(paused.n).toBeGreaterThanOrEqual(1);
    const resume = executeHqCommand(cfg, "continue", "f39-kill");
    expect(resume.ok).toBe(true);
  });

  it("Handoff Prospector→Comercial registra evento e movimento", () => {
    const cfg = config(); const db = openDatabase(cfg.dbPath); applySchema(db); db.close();
    const handoff = requestHandoff(cfg, { fromAgent: "prospector-agent", toAgent: "commercial-agent", summary: "Lead qualificado entregue" });
    expect(handoff.accepted).toBe(true);
    const db2 = openDatabase(cfg.dbPath);
    const move = db2.prepare("SELECT payload FROM events WHERE event_type='agent_move' ORDER BY id DESC LIMIT 1").get() as { payload: string };
    const handoffRow = db2.prepare("SELECT status FROM handoffs WHERE id=?").get(handoff.handoffId) as { status: string };
    db2.close();
    expect(JSON.parse(move.payload)).toMatchObject({ agentId: "prospector-agent", to: "commercial-agent" });
    expect(handoffRow.status).toBe("ACCEPTED");
  });

  it("Perfil de agente retorna dados reais do runtime", () => {
    const cfg = config(); const db = openDatabase(cfg.dbPath); applySchema(db); db.close();
    getHqSnapshot(cfg);
    const profile = agentProfile(cfg, "manager");
    expect(profile).toBeTruthy();
    expect((profile?.agent as Record<string, unknown>).id).toBe("manager");
    expect(profile?.department).toContain("GESTÃO");
    expect(profile?.position).toBeTruthy();
    expect(agentProfile(cfg, "nao-existe")).toBeNull();
  });

  it("Layout do escritório é determinístico e cobre todos os agentes registrados", () => {
    expect(OFFICE_DEPARTMENTS.length).toBeGreaterThanOrEqual(6);
    expect(deskPosition("manager")).toBeTruthy();
    expect(deskPosition("prospector-agent")).toBeTruthy();
    expect(deskPosition("sales-agent-01")).toBeTruthy();
    expect(deskPosition("sales-agent-04")).toBeTruthy();
    expect(deskPosition("engineering-agent")).toBeTruthy();
    expect(deskPosition("agente-inexistente")).toBeNull();
  });
});
