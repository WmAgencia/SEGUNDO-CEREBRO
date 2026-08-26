import { mkdirSync, mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openDatabase, applySchema } from "../storage/connection.ts";
import { managerChat } from "../core/hq/manager.ts";
import type { BrainConfig } from "../core/config/loader.ts";

// ⚠️ TESTE LLM REAL — só roda quando GROQ_API_KEY está presente (opt-in).
// Carrega .env.local no topo (vitest não o faz) para setar hasGroq cedo.
try {
  for (const line of readFileSync("C:/Users/junin/second-brain/.env.local", "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (m && m[1] && m[2] !== undefined && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
} catch {}
const hasGroq = Boolean(process.env.GROQ_API_KEY && !process.env.VITEST_SKIP_LLM);

let dir: string;
let config: BrainConfig;

beforeAll(() => {
  if (!hasGroq) return;
  // garante env do vault se ausente
  process.env.SECOND_BRAIN_VAULT ??= "C:\\Users\\junin\\OneDrive\\Documentos\\Obsidian Vault";
  dir = mkdtempSync(path.join(tmpdir(), "mg-llm-"));
  config = {
    vaultPath: path.join(dir, "v"),
    dataDir: dir,
    dbPath: path.join(dir, "b.db"),
    logLevel: "error",
    search: { defaultLimit: 10, maxLimit: 50 },
    context: { maxChars: 12000, defaultDepth: 1, maxDepth: 3 },
    ai: { baseUrl: "http://127.0.0.1:11434", model: "qwen3" },
  };
  mkdirSync(config.vaultPath, { recursive: true });
  const d = openDatabase(config.dbPath);
  applySchema(d);
  d.close();
});

afterAll(() => {
  if (dir) { try { rmSync(dir, { recursive: true, force: true }); } catch {} }
});

describe.runIf(hasGroq)("Manager Agentic — conversa real com LLM (Groq)", () => {
  it("conversa contínua §30 sem loop nem repetição de pergunta", async () => {
    const s = "agentic-30-" + Date.now();
    const msgs = [
      "Oi",
      "Quero falar sobre prospecção.",
      "Como está o Prospector?",
      "Quero melhorar isso.",
      "Quais opções temos?",
      "Gostei da segunda.",
    ];
    const answers: string[] = [];
    for (const m of msgs) {
      const r = await managerChat(config!,  m, s);
      answers.push(r.message);
      // NENHUMA resposta pode propor menu genérico
      expect(r.message.toLowerCase()).not.toContain("quer que eu aprofunde");
      expect(r.message.toLowerCase()).not.toMatch(/posso criar um objetivo|quer que eu transforme em plano/);
    }
    // anti-loop: respostas adjacentes não são idênticas
    for (let i = 1; i < answers.length; i++) {
      expect(answers[i]).not.toBe(answers[i - 1]);
    }
    // "Como está o Prospector?" deve citar dados reais do projeto/agente
    expect(answers[2]!.toLowerCase()).toMatch(/prospector|planned|paused|prospec/i);
  });

  it("pergunta de estado responde com dados reais em vez de repetir pergunta", async () => {
    const s = "agentic-state-" + Date.now();
    const first = await managerChat(config!,  "Quero conversar sobre o projeto Nutri.", s);
    const r = await managerChat(config!,  "consulta o estado dele", s);
    expect(r.message.toLowerCase()).not.toContain("quer que eu aprofunde");
    // deve ter respondido algo com dados reais (não menu genérico)
    expect(r.message.length).toBeGreaterThan(20);
  });
});
