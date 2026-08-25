import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { BrainConfig } from "../core/config/loader.ts";
import { applySchema, openDatabase } from "../storage/connection.ts";
import { classifyCreativeIntent, managerChat } from "../core/hq/manager.ts";

let dir: string;
let config: BrainConfig;

const SUELI_SPEC = `# CRIAÇÃO DO SITE — SUELI BONI | PSICANALISTA
Crie um site profissional para Sueli Boni. O site precisa transformar a presença digital.
Preparar o componente para receber imagens reais em alta qualidade.
As fotografias serão fornecidas posteriormente. Evitar banco de imagens clichê.
Crie um novo repositório no github pra ela.`.repeat(3);

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "brain-intent-"));
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
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
});

describe("classifyCreativeIntent — intenção dominante", () => {
  it("briefing longo de SITE com menções a 'imagens' → DEV (não imagem)", () => {
    expect(classifyCreativeIntent(SUELI_SPEC)).toBe("dev");
  });

  it("correção explícita do usuário vence tudo", () => {
    expect(classifyCreativeIntent("Não é a imagem que eu preciso, preciso que code o site")).toBe("dev");
    expect(classifyCreativeIntent("quero que code o site")).toBe("dev");
  });

  it("comando curto e explícito de imagem continua indo para imagem", () => {
    expect(classifyCreativeIntent("Designer, gere um logo para a padaria")).toBe("image");
    expect(classifyCreativeIntent("crie uma imagem de um gato")).toBe("image");
  });

  it("conversa comum não é criativa", () => {
    expect(classifyCreativeIntent("Oi, tudo bem?")).toBe("none");
    expect(classifyCreativeIntent("Quero conversar sobre prospecção")).toBe("none");
  });

  it("menção a vídeo sem comando explícito e com entrega dev → dev", () => {
    expect(classifyCreativeIntent("Crie um site com animações e um vídeo de fundo no hero")).toBe("dev");
  });
});

describe("managerChat — fluxo completo do briefing de site", () => {
  it("proposta cria plano DE BUILD com deploy Vercel, dispatcha Engineering Agent", async () => {
    delete process.env.OPENROUTER_API_KEY;
    process.env.VITEST = "1";
    const session = `intent-${Date.now()}`;

    const proposal = await managerChat(config, SUELI_SPEC, session);
    expect(proposal.requiresConfirmation).toBe(true);
    expect(proposal.message).toContain("Criar repositório GitHub");
    expect(proposal.message).not.toContain("Gerar imagem");

    const executed = await managerChat(config, "Sim", session);
    expect(executed.type).toBe("execution");
    expect(executed.message).toContain("Engineering Agent");
    expect(executed.message).toContain("Vercel");
    expect(executed.actions.some((a) => a.status === "executed")).toBe(true);
  });

  it("pedido curto de logo AINDA vai para o Designer", async () => {
    delete process.env.OPENROUTER_API_KEY;
    process.env.VITEST = "1";
    const session = `logo-${Date.now()}`;
    const proposal = await managerChat(config, "Designer, gere um logo minimalista para uma cafeteria", session);
    expect(proposal.message).toMatch(/imagem|Imagem/i);
    const executed = await managerChat(config, "Pode", session);
    expect(executed.message).toContain("Designer Agent");
  });

  it("correção após proposta errada reclassifica para dev", async () => {
    delete process.env.OPENROUTER_API_KEY;
    process.env.VITEST = "1";
    const session = `fix-${Date.now()}`;
    // Primeira mensagem ambígua curta menciona imagem
    await managerChat(config, "quero criar uma imagem para o projeto", session);
    // Usuário corrige
    const corrected = await managerChat(config, "Não é a imagem que eu preciso, preciso que code o site completo", session);
    expect(corrected.message).toContain("Criar repositório GitHub");
    expect(corrected.message).not.toMatch(/^Entendi\. Vou criar o objetivo "Imagem/);
  });
});
