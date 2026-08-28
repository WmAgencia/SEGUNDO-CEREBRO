/**
 * FASE DE CONSOLIDAÇÃO — Agent Runtime (seções 16 e 17).
 *
 * O loop real (single-agent.ts) é exercitado de verdade: sessão, contexto,
 * tool executor e aprovação reais. O LLM é stub porque o ambiente não tem
 * capacidade de LLM externo (Groq 8k TPM / OpenRouter sem créditos) — isso é
 * documentado como BLOCKED, não mascarado. As ferramentas, o loop e as
 * salvaguardas rodam de verdade.
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase, applySchema } from "../storage/connection.ts";
import type { LogLevel } from "../core/logger/logger.ts";
import type { BrainConfig } from "../core/config/loader.ts";
import { SingleAgent, ChatMessage } from "../core/agent/single-agent.ts";
import { getMessages } from "../core/agent/session-store.ts";
import { classifyIntent } from "../core/orchestration/planner.ts";

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) { try { rmSync(d, { recursive: true, force: true }); } catch {} }
});

function setup(): { config: BrainConfig } {
  const dir = mkdtempSync(path.join(tmpdir(), "sb-cons-"));
  dirs.push(dir);
  mkdirSync(path.join(dir, "vault"), { recursive: true });
  const config = {
    vaultPath: path.join(dir, "vault"),
    dataDir: dir,
    dbPath: path.join(dir, "b.db"),
    logLevel: "error" as LogLevel,
    search: { defaultLimit: 10, maxLimit: 50 },
    context: { maxChars: 12000, defaultDepth: 1, maxDepth: 3 },
    ai: { baseUrl: "http://127.0.0.1", model: "test" },
  } as BrainConfig;
  const db = openDatabase(config.dbPath);
  applySchema(db);
  db.close();
  return { config };
}

describe("FASE CONSOLIDAÇÃO — decisão SIMPLE/TOOL/PLAN/GRAPH (não Graph para tudo)", () => {
  it("'Oi' é SIMPLE (não vira Graph)", () => {
    expect(classifyIntent("Oi")).toBe("SIMPLE");
    expect(classifyIntent("Você está aí?")).toBe("SIMPLE");
  });
  it("ação única é TOOL", () => {
    expect(classifyIntent("Crie um objetivo de R$5.000")).toBe("TOOL");
  });
  it("problema a analisar é PLAN", () => {
    expect(classifyIntent("Quero melhorar minha estratégia de prospecção")).toBe("PLAN");
  });
  it("multi-etapas com dependências é GRAPH", () => {
    expect(classifyIntent("Encontre 100 empresas sem site, analise cada uma e classifique os leads")).toBe("GRAPH");
  });
});

describe("FASE CONSOLIDAÇÃO — suíte conversacional real (seção 16)", () => {
  it("'Oi' → resposta natural, sem template de roteador", async () => {
    const { config } = setup();
    const agent = new SingleAgent({ llm: async () => ({ content: "Oi! Estou aqui. O que você quer fazer?" }) });
    const res = await agent.chat(config, "conv-oi", "Oi");
    expect(res.type).toBe("answer");
    expect(res.message?.content).toMatch(/Oi/);
    // comportamento proibido pela fase: roteador oferecendo cardápio de comandos
    expect(res.message?.content.toLowerCase()).not.toContain("posso criar um objetivo, consultar o second brain ou verificar");
  });

  it("'O que temos sobre Nutriva?' → busca contexto via ferramenta real", async () => {
    const { config } = setup();
    let call = 0;
    const agent = new SingleAgent({
      llm: async () => {
        call++;
        if (call === 1) return { content: JSON.stringify({ tool: "brain_search", input: { query: "Nutriva" } }) };
        return { content: "Sobre o Nutriva: encontrei o registro no Second Brain." };
      },
    });
    const res = await agent.chat(config, "conv-nutriva", "O que temos sobre Nutriva?");
    expect(res.type).toBe("answer");
    expect(res.toolResults?.some((t) => t.toolId === "brain_search")).toBe(true);
  });

  it("'Faça isso.' → executa ferramenta real (goal_create)", async () => {
    const { config } = setup();
    let call = 0;
    const agent = new SingleAgent({
      llm: async () => {
        call++;
        if (call === 1) return { content: JSON.stringify({ tool: "goal_create", input: { name: "Meta de teste consolidação", type: "BUSINESS" } }) };
        return { content: "Pronto, criei o objetivo." };
      },
    });
    const res = await agent.chat(config, "conv-faca", "Faça isso.", async () => true);
    expect(res.type).toBe("answer");
    expect(res.toolResults?.some((t) => t.toolId === "goal_create" && t.success)).toBe(true);
  });

  it("'Pare.' → kill switch interrompe o loop", async () => {
    const { config } = setup();
    const ac = new AbortController();
    ac.abort(); // já cancelado
    const agent = new SingleAgent({ llm: async () => ({ content: JSON.stringify({ tool: "goal_list", input: {} }) }) });
    const res = await agent.chat(config, "conv-pare", "Pare.", undefined, { signal: ac.signal });
    expect(res.type).toBe("answer");
    expect(res.message?.content).toMatch(/[Ii]nterrompido/);
    // nenhuma ferramenta chegou a executar
    expect(res.toolResults?.length ?? 0).toBe(0);
  });

  it("'Continue.' → sessão recupera histórico persistido", async () => {
    const { config } = setup();
    const agent1 = new SingleAgent({ llm: async () => ({ content: "Vamos trabalhar no Nutriva hoje." }) });
    await agent1.chat(config, "conv-cont", "Quero melhorar o Nutriva.");
    const agent2 = new SingleAgent({ llm: async () => ({ content: "Retomando de onde paramos." }) });
    const res = await agent2.chat(config, "conv-cont", "Continue.");
    expect(res.type).toBe("answer");
    const msgs = getMessages(config, "conv-cont", 20);
    expect(msgs.some((m) => m.content.includes("Nutriva"))).toBe(true);
    expect(msgs.length).toBeGreaterThanOrEqual(4); // 2 turnos completos persistidos
  });
});

describe("FASE CONSOLIDAÇÃO — salvaguardas do loop autônomo (seção 2)", () => {
  it("loop infinito: mesma tool+input repetida é detectada e o agente para com honestidade", async () => {
    const { config } = setup();
    // LLM que insiste na MESMA chamada de ferramenta sem progredir
    const agent = new SingleAgent({ llm: async () => ({ content: JSON.stringify({ tool: "goal_list", input: {} }) }) });
    const res = await agent.chat(config, "loop-rep", "lista os objetivos");
    expect(res.type).toBe("answer");
    expect(res.message?.content).toMatch(/sem progresso/i);
    // parou após o limite de repetições (não loopou até maxTurns silenciosamente)
    expect(res.toolResults?.length).toBe(3);
  });

  it("falha persistente: mesma tool falhando seguidamente é detectada e o agente para", async () => {
    const { config } = setup();
    // web_fetch com URL inválida (variando a entrada p/ não cair na detecção de
    // repetição) → falha real de rede/parse repetida
    let n = 0;
    const agent = new SingleAgent({
      llm: async () => {
        n++;
        return { content: JSON.stringify({ tool: "web_fetch", input: { url: `not-a-valid-url-${n}` } }) };
      },
    });
    const res = await agent.chat(config, "loop-fail", "busca algo", async () => true);
    expect(res.type).toBe("answer");
    expect(res.message?.content).toMatch(/falhou .* vezes seguidas|Interrompi/i);
  });

  it("timeout do loop: execução que não conclui no prazo é interrompida", async () => {
    const { config } = setup();
    let call = 0;
    const agent = new SingleAgent({
      loopTimeoutMs: 1, // prazo mínimo para forçar o estouro
      llm: async () => {
        call++;
        if (call === 1) return { content: JSON.stringify({ tool: "goal_list", input: {} }) };
        return { content: "resposta final que não deve chegar" };
      },
    });
    const res = await agent.chat(config, "loop-timeout", "faz algo");
    expect(res.type).toBe("answer");
    expect(res.message?.content).toMatch(/tempo limite|retomar/i);
  });

  it("intenção sugerida é injetada no contexto (dica, não ordem)", async () => {
    const { config } = setup();
    let seenCtx = "";
    const agent = new SingleAgent({
      llm: async (messages) => {
        seenCtx = messages.map((m) => m.content).join("\n");
        return { content: "ok" };
      },
    });
    await agent.chat(config, "loop-intent", "Encontre 50 empresas sem site e classifique os leads");
    expect(seenCtx).toContain("INTENÇÃO SUGERIDA");
    expect(seenCtx).toContain("GRAPH");
  });
});

describe("FASE CONSOLIDAÇÃO — autonomia (seção 17, mapeamento)", () => {
  it("TESTE A/B — objetivo simples + uma tool real executada", async () => {
    const { config } = setup();
    let call = 0;
    const agent = new SingleAgent({
      llm: async () => {
        call++;
        if (call === 1) return { content: JSON.stringify({ tool: "goal_create", input: { name: "Autonomia A", type: "PERSONAL" } }) };
        return { content: "Objetivo criado." };
      },
    });
    const res = await agent.chat(config, "auto-a", "cria um objetivo pessoal", async () => true);
    expect(res.toolResults?.some((t) => t.toolId === "goal_create" && t.success)).toBe(true);
  });

  it("TESTE C — múltiplas tools em sequência no mesmo turno", async () => {
    const { config } = setup();
    let call = 0;
    const agent = new SingleAgent({
      llm: async () => {
        call++;
        if (call === 1) return { content: JSON.stringify({ tool: "goal_create", input: { name: "Autonomia C", type: "BUSINESS" } }) };
        if (call === 2) return { content: JSON.stringify({ tool: "goal_list", input: {} }) };
        return { content: "Criei e listei os objetivos." };
      },
    });
    const res = await agent.chat(config, "auto-c", "cria e lista objetivos", async () => true);
    expect(res.toolResults?.some((t) => t.toolId === "goal_create" && t.success)).toBe(true);
    expect(res.toolResults?.some((t) => t.toolId === "goal_list" && t.success)).toBe(true);
  });

  it("TESTE E/F/G/H — Graph, paralelismo, rework e recovery: cobertos em graph-runtime-real.test.ts (execução real)", () => {
    // Estes cenários exigem o Graph Engine real e estão validados com execução
    // real em tests/graph-runtime-real.test.ts: paralelismo (maxActive por
    // timestamps), rework (FAILED→REWORK→RETRY→SUCCESS), recovery (COMPLETED não
    // re-executado) e long-horizon. Aqui apenas documentamos o mapeamento para
    // não duplicar testes.
    expect(true).toBe(true);
  });
});