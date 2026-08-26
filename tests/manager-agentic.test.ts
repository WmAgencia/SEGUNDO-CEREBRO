import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { openDatabase, applySchema } from "../storage/connection.ts";
import { managerChat } from "../core/hq/manager.ts";
import type { BrainConfig } from "../core/config/loader.ts";

// Testes DETERMINÍSTICOS (sem LLM) — validam anti-loop e resposta de estado
// sem depender de rede. O comportamento bom (dados reais por tópico) vem do
// LLM; o fallback garantidamente NÃO repete pergunta nem oferece menu genérico.
let savedEnv: Record<string, string | undefined> = {};
beforeAll(() => {
  for (const k of ["OPENROUTER_API_KEY", "GROQ_API_KEY"]) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});
afterAll(() => {
  for (const k of Object.keys(savedEnv)) if (savedEnv[k]) process.env[k] = savedEnv[k];
});

let directory = "";
afterEach(() => { if (directory) rmSync(directory, { recursive: true, force: true }); directory = ""; });

function config(): BrainConfig {
  directory = mkdtempSync(path.join(tmpdir(), "mg-agentic-"));
  const vaultPath = path.join(directory, "v"); mkdirSync(vaultPath);
  return { vaultPath, dataDir: directory, dbPath: path.join(directory, "b.db"), logLevel: "error", search: { defaultLimit: 10, maxLimit: 50 }, context: { maxChars: 12000, defaultDepth: 1, maxDepth: 3 }, ai: { baseUrl: "http://127.0.0.1", model: "test" } };
}

function seed(db: ReturnType<typeof openDatabase>): void {
  applySchema(db);
  db.prepare("INSERT OR IGNORE INTO projects (id,name,status,priority) VALUES ('project.nutriva','Nutriva','active','high')").run();
  db.prepare("INSERT OR IGNORE INTO projects (id,name,status,priority) VALUES ('project.clipcom','ClipCom','active','normal')").run();
  db.prepare("INSERT INTO goals (id,name,type,status,project) VALUES ('goal.abc','Melhorar Nutri','PROJECT','ACTIVE','project.nutriva')").run();
  db.prepare("INSERT INTO initiatives (id,title,status,project) VALUES ('init.x','Plano Nutri','APPROVED','nutriva')").run();
  db.prepare("INSERT INTO initiative_tasks (initiative_id,ordinal,title,status,assigned_agent) VALUES ('init.x',1,'Implementar tela','RUNNING','developer-01')").run();
  db.prepare("INSERT OR IGNORE INTO agents (id,name,status) VALUES ('developer-01','Developer 01','AVAILABLE')").run();
}

describe("Manager Agentic — anti-loop e resposta de estado (determinístico)", () => {
  it("mensagem de conversa NÃO oferece menu genérico", async () => {
    const cfg = config(); const d = openDatabase(cfg.dbPath); seed(d); d.close();
    const s = "ai-1";
    const r = await managerChat(cfg, "Quero conversar sobre prospecção.", s);
    expect(r.message.toLowerCase()).not.toContain("quer que eu aprofunde");
    expect(r.message.toLowerCase()).not.toMatch(/posso criar um objetivo/);
  });

  it("consulta de tópico repetida NÃO repete exatamente a mesma resposta", async () => {
    const cfg = config(); const d = openDatabase(cfg.dbPath); seed(d); d.close();
    const s = "ai-2";
    const a = await managerChat(cfg, "O que é o Prospector?", s);
    const b = await managerChat(cfg, "e o Prospector?", s);
    expect(b.message).not.toBe(a.message);
  });

  it("'o que foi feito hoje' não oferece menu genérico", async () => {
    const cfg = config(); const d = openDatabase(cfg.dbPath); seed(d); d.close();
    const s = "ai-3";
    const r = await managerChat(cfg, "o que foi feito hoje", s);
    expect(r.message.toLowerCase()).not.toContain("quer que eu monte um plano");
  });

  it("'consulta o estado dele' mantém assunto e não propõe objetivo", async () => {
    const cfg = config(); const d = openDatabase(cfg.dbPath); seed(d); d.close();
    const s = "ai-4";
    await managerChat(cfg, "Como está o projeto Nutri?", s);
    const r = await managerChat(cfg, "consulta o estado dele", s);
    expect(r.message.toLowerCase()).not.toMatch(/posso criar um objetivo/);
    expect(r.message.toLowerCase()).not.toContain("quer que eu aprofunde");
  });
});
