import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { openDatabase, applySchema } from "../storage/connection.ts";
import { managerChat } from "../core/hq/manager.ts";
import type { BrainConfig } from "../core/config/loader.ts";

let savedEnv: Record<string, string | undefined> = {};
beforeAll(() => {
  for (const k of ["OPENROUTER_API_KEY", "GROQ_API_KEY", "GROQ_API_KEY_1", "GROQ_API_KEY_2", "GROQ_API_KEY_3"]) {
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
  directory = mkdtempSync(path.join(tmpdir(), "mg-chat-"));
  const vaultPath = path.join(directory, "v"); mkdirSync(vaultPath);
  return { vaultPath, dataDir: directory, dbPath: path.join(directory, "b.db"), logLevel: "error", search: { defaultLimit: 10, maxLimit: 50 }, context: { maxChars: 12000, defaultDepth: 1, maxDepth: 3 }, ai: { baseUrl: "http://127.0.0.1", model: "test" } };
}

function seed(d: ReturnType<typeof openDatabase>): void {
  applySchema(d);
  d.prepare("INSERT OR IGNORE INTO projects (id,name,status,priority) VALUES ('project.sueli','Site Sueli Boni','active','high')").run();
  d.prepare("INSERT OR IGNORE INTO projects (id,name,status,priority) VALUES ('project.clipcom','ClipCom','active','normal')").run();
  d.prepare("INSERT OR IGNORE INTO agents (id,name,status) VALUES ('sales-agent-01','A1','AVAILABLE')").run();
}

describe("Manager chat — greetings não ficam presos ao último projeto", () => {
  it("'Oi' e 'Ei' respondem conversa pura (não puxam projeto)", async () => {
    const cfg = config(); const d = openDatabase(cfg.dbPath); seed(d); d.close();
    const s = "g-1";
    // cria contexto com um projeto em foco
    await managerChat(cfg, "Quero um site para a Sueli Boni", s);
    const r = await managerChat(cfg, "Ei", s); // greting não deve citar projetoSueli
    expect(r.message.toLowerCase()).not.toContain("sueli");
    expect(r.message.toLowerCase()).not.toContain("sobre projeto");
    expect(r.message.toLowerCase()).toMatch(/oi|olá|ola|e aí|fala/i);
  });

  it("'Você está aí?' responde presença, não status de projeto", async () => {
    const cfg = config(); const d = openDatabase(cfg.dbPath); seed(d); d.close();
    const s = "g-2";
    await managerChat(cfg, "Como está o ClipCom?", s);
    const r = await managerChat(cfg, "Você está aí?", s);
    expect(r.message.toLowerCase()).toMatch(/aqui|presente|estou|sim/i);
    expect(r.message.toLowerCase()).not.toContain("sobre projeto");
  });

  it("'Quero conversar sobre prospecção' inicia conversa (não repete último projeto)", async () => {
    const cfg = config(); const d = openDatabase(cfg.dbPath); seed(d); d.close();
    const s = "g-3";
    await managerChat(cfg, "Quero um site para a Sueli Boni", s);
    const r = await managerChat(cfg, "Quero conversar sobre prospecção", s);
    expect(r.message.toLowerCase()).toMatch(/prospec/);
    expect(r.message.toLowerCase()).not.toContain("sueli");
  });
});

describe("Manager chat — multi-turno mantém contexto", () => {
  it("prospecção → clínicas → sem tráfego → plano coerente", async () => {
    const cfg = config(); const d = openDatabase(cfg.dbPath); seed(d); d.close();
    const s = "mt-1";
    await managerChat(cfg, "Quero melhorar a prospecção", s);
    const r2 = await managerChat(cfg, "Principalmente clínicas", s);
    // deve manter o assunto prospecção e incorporar clínicas
    const text = r2.message.toLowerCase();
    expect(text).toMatch(/prospec|clínica|clinica|lead/i);
    expect(r2.requiresConfirmation).toBe(false);
  });
});
