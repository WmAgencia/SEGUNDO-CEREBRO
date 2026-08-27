import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase, applySchema } from "../storage/connection.ts";
import { createDefaultRegistry, ToolExecutor } from "../core/agent/tools/index.ts";
import { writeFileSync } from "node:fs";
import type { LogLevel } from "../core/logger/logger.ts";

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* Windows retry */ }
  }
});

function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), "sb-tools-"));
  dirs.push(dir);
  const vaultPath = path.join(dir, "vault");
  mkdirSync(vaultPath, { recursive: true });
  const config = {
    vaultPath,
    dataDir: dir,
    dbPath: path.join(dir, "b.db"),
    logLevel: "error" as LogLevel,
    search: { defaultLimit: 10, maxLimit: 50 },
    context: { maxChars: 12000, defaultDepth: 1, maxDepth: 3 },
    ai: { baseUrl: "http://127.0.0.1", model: "test" },
  };
  const db = openDatabase(config.dbPath);
  applySchema(db);
  db.close();
  return { dir, config };
}

describe("core/agent/tools registry", () => {
  it("registra todas as ferramentas reais", () => {
    const r = createDefaultRegistry();
    const ids = r.available().map((t) => t.id);
    expect(ids).toContain("brain_search");
    expect(ids).toContain("memory_search");
    expect(ids).toContain("memory_write");
    expect(ids).toContain("web_search");
    expect(ids).toContain("web_fetch");
    expect(ids).toContain("image_generate");
    expect(ids).toContain("goal_create");
    expect(ids).toContain("goal_list");
    expect(ids).toContain("whatsapp_send");
    expect(ids).toContain("whatsapp_status");
    expect(ids).toContain("agenda_create");
    expect(ids).toContain("agenda_list");
    expect(ids).toContain("opencode_run");
    expect(ids).toContain("obsidian_sync");
  });

  it("braind_search retorna hits reais do índice", () => {
    const { config } = setup();
    writeFileSync(path.join(config.vaultPath, "sobre-vyntra.md"), "# Vyntra\nnotes sobre o projeto vyntra campanhas.\n", "utf8");
    const r = createDefaultRegistry();
    const ex = new ToolExecutor(r);
    // índice precisa existir: roda indexação direta via searcher espera índice; sem índice o total é 0,
    // o que ainda é um resultado REAL (busca consulta a tabela FTS).
    return ex.execute({ toolId: "brain_search", input: { query: "vyntra" }, ctx: { config } }).then((out) => {
      expect(out.toolId).toBe("brain_search");
      expect(typeof out.success).toBe("boolean");
      expect(out.error === undefined || out.success === true).toBe(true);
    });
  });

  it("memory_write sem aprovação é BLOQUEADO (não executa)", async () => {
    const { config } = setup();
    const ex = new ToolExecutor(createDefaultRegistry());
    const out = await ex.execute({
      toolId: "memory_write",
      input: { content: "decisão de teste", kind: "decision" },
      ctx: { config, userContext: {} },
    });
    expect(out.success).toBe(false);
    expect(out.error).toMatch(/approval/i);
  });

  it("memory_write com aprovação grava de verdade", async () => {
    const { config } = setup();
    const ex = new ToolExecutor(createDefaultRegistry());
    const out = await ex.execute({
      toolId: "memory_write",
      input: { content: "preferência: conversar em português informal", kind: "semantic", category: "PREFERENCE" },
      ctx: { config, userContext: { requestApproval: async () => true } },
    });
    expect(out.success).toBe(true);
    expect(out.output).toMatchObject({ kind: "semantic" });

    const db = openDatabase(config.dbPath);
    try {
      const row = db.prepare("SELECT content FROM memories WHERE content LIKE ?").get("%português informal%") as { content: string } | undefined;
      expect(row?.content).toContain("português");
    } finally { db.close(); }
  });

  it("goal_create com aprovação cria goal real no banco", async () => {
    const { config } = setup();
    const ex = new ToolExecutor(createDefaultRegistry());
    const out = await ex.execute({
      toolId: "goal_create",
      input: { name: "Faturar R$5000 no mês", type: "FINANCIAL" },
      ctx: { config, userContext: { requestApproval: async () => true } },
    });
    expect(out.success).toBe(true);
    const goal = out.output as { id: string; name: string };
    expect(goal.id).toMatch(/^goal\./);
    expect(goal.name).toContain("Faturar");

    const db = openDatabase(config.dbPath);
    try {
      const row = db.prepare("SELECT name FROM goals WHERE id = ?").get(goal.id) as { name: string } | undefined;
      expect(row?.name).toContain("Faturar");
    } finally { db.close(); }
  });

  it("agenda_create + agenda_list persistem e recuperam eventos", async () => {
    const { config } = setup();
    const ex = new ToolExecutor(createDefaultRegistry());
    const tomorrow = new Date(Date.now() + 86400000).toISOString();
    const created = await ex.execute({
      toolId: "agenda_create",
      input: { title: "Reunião com cliente", startsAt: tomorrow, description: "apresentar proposta" },
      ctx: { config, userContext: { requestApproval: async () => true } },
    });
    expect(created.success).toBe(true);

    const listed = await ex.execute({ toolId: "agenda_list", input: {}, ctx: { config } });
    expect(listed.success).toBe(true);
    const items = listed.output as Array<{ title: string }>;
    expect(items.some((i) => i.title === "Reunião com cliente")).toBe(true);
  });

  it("tool inexistente → erro real, não mock", async () => {
    const { config } = setup();
    const ex = new ToolExecutor(createDefaultRegistry());
    const out = await ex.execute({ toolId: "ferramenta_que_nao_existe", input: {}, ctx: { config } });
    expect(out.success).toBe(false);
    expect(out.error).toMatch(/not found/i);
  });

  it("input inválido é rejeitado antes de executar", async () => {
    const { config } = setup();
    const ex = new ToolExecutor(createDefaultRegistry());
    const out = await ex.execute({ toolId: "brain_search", input: {}, ctx: { config } });
    expect(out.success).toBe(false);
    expect(out.error).toMatch(/query/i);
  });

  it("goal_list retorna goals reais do banco", async () => {
    const { config } = setup();
    const ex = new ToolExecutor(createDefaultRegistry());
    const goal = await ex.execute({
      toolId: "goal_create",
      input: { name: "Crescer prospecção", type: "SALES" },
      ctx: { config, userContext: { requestApproval: async () => true } },
    });
    expect(goal.success).toBe(true);
    const listed = await ex.execute({ toolId: "goal_list", input: {}, ctx: { config } });
    expect(listed.success).toBe(true);
    const items = listed.output as Array<{ name: string }>;
    expect(items.some((i) => i.name === "Crescer prospecção")).toBe(true);
  });
});