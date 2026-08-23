import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { BrainConfig } from "../../core/config/loader.ts";
import { applySchema, openDatabase } from "../../storage/connection.ts";
import { indexVault } from "../../core/indexing/vault-indexer.ts";
import { redactSecrets } from "../../core/exec/redact.ts";
import { classifyRisk, evaluatePolicy } from "../../core/exec/policy.ts";
import { LocalExecutor } from "../../core/exec/executor.ts";
import {
  requestExecution,
  runAuthorizedExecution,
  listExecutions,
} from "../../core/exec/execution-engine.ts";
import {
  startCollaboration,
  postCollaborationMessage,
  listCollaborationMessages,
  resolveCollaboration,
  createDecision,
  overrideDecision,
} from "../../core/collab/collaboration.ts";
import {
  buildConsultationContext,
} from "../../core/collab/external-ai.ts";
import { seedBrainTools } from "../../core/tools/tool-registry.ts";

let dir: string;
let config: BrainConfig;
let d: DatabaseSync;

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "brain-exec-"));
  config = {
    vaultPath: path.join(dir, "vault"),
    dataDir: dir,
    dbPath: path.join(dir, "brain.d"),
    logLevel: "error",
    search: { defaultLimit: 10, maxLimit: 50 },
    context: { maxChars: 12000, defaultDepth: 1, maxDepth: 3 },
    ai: { baseUrl: "http://127.0.0.1:11434", model: "qwen3-1.7b" },
  };
  mkdirSync(config.vaultPath, { recursive: true });
  d = openDatabase(config.dbPath);
  applySchema(d);
  writeFileSync(
    path.join(config.vaultPath, "vyntra.md"),
    "---\nid: project.vyntra\ntype: project\ntitle: Vyntra\nstatus: active\n---\n# Vyntra\nVendas.",
    "utf8",
  );
  indexVault(config);
  seedBrainTools(d);

  d.prepare(
    `INSERT OR IGNORE INTO agents (id, name, permissions) VALUES ('exec-agent', 'Executor Agent', '[\"READ\",\"WRITE\",\"EXECUTE\"]')`,
  ).run();
});

afterAll(() => {
  try {
    d.close();
    rmSync(dir, { recursive: true, force: true });
  } catch {}
});

describe("exec/redact", () => {
  it("redacts API keys and tokens", () => {
    const input = "Minha chave é gsk_ABCDEFGHIJKLMNOPQRSTUV e uso Bearer eyJhbGc123";
    const output = redactSecrets(input);
    expect(output).not.toContain("gsk_");
    expect(output).toContain("[REDACTED");
  });
});

describe("exec/policy", () => {
  it("classifies risk by category and permissions", () => {
    expect(classifyRisk("search", ["READ"])).toBe("LOW");
    expect(classifyRisk("automation", ["WRITE"])).toBe("MEDIUM");
    expect(classifyRisk("external", ["EXECUTE"])).toBe("HIGH");
    expect(classifyRisk("infra", ["ADMIN"])).toBe("CRITICAL");
  });

  it("blocks execution when initiative not approved", () => {
    d.prepare(
      `INSERT OR IGNORE INTO initiatives (id, title, status) VALUES ('init.draft', 'Draft', 'DRAFT')`,
    ).run();
    const check = evaluatePolicy(d, {
      agentId: "exec-agent",
      toolId: "brain_search",
      initiativeId: "init.draft",
    });
    expect(check.decision).toBe("BLOCKED");
    expect(check.reasons.join(" ")).toContain("APPROVED");
  });

  it("blocks unknown tool", () => {
    const check = evaluatePolicy(d, {
      agentId: "exec-agent",
      toolId: "tool.inexistente",
    });
    expect(check.decision).toBe("BLOCKED");
    expect(check.reasons.some((r) => r.includes("não registrada"))).toBe(true);
  });
});

describe("execution engine (fase 20)", () => {
  it("allows LOW risk execution and produces result", async () => {
    const executor = new LocalExecutor();
    executor.register("brain_search", async (input) => ({
      output: JSON.stringify({ query: input.query }),
      summary: "busca executada",
    }));

    const req = requestExecution(config, executor, {
      agentId: "exec-agent",
      toolId: "brain_search",
      params: { query: "vendas" },
      idempotencyKey: "exec-test-001",
    });
    expect(req.status).toBe("AUTHORIZED");

    const done = await runAuthorizedExecution(config, executor, req.id);
    expect(done.status).toBe("COMPLETED");
    expect(done.output).toBeTruthy();

    const all = listExecutions(config, { agentId: "exec-agent" });
    expect(all.length).toBeGreaterThan(0);
  });

  it("enforces idempotency via unique key", () => {
    const dup = requestExecution(config, new LocalExecutor(), {
      agentId: "exec-agent",
      toolId: "brain_search",
      params: { query: "vendas" },
      idempotencyKey: "exec-test-001",
    });
    expect(dup.duplicate).toBe(true);
  });

  it("requires approval for HIGH risk tools", () => {
    d.prepare(
      `INSERT INTO tools_registry (id, description, category, permissions, available)
       VALUES ('whatsapp_send', 'Envia mensagens', 'external', '[\"EXECUTE\",\"NETWORK\"]', 1)
       ON CONFLICT(id) DO NOTHING`,
    ).run();
    const req = requestExecution(config, new LocalExecutor(), {
      agentId: "exec-agent",
      toolId: "whatsapp_send",
      params: {},
      idempotencyKey: "wa-test-001",
    });
    expect(req.status).toBe("REQUIRES_APPROVAL");
    expect(req.risk).toBe("HIGH");
  });
});

describe("collaboration (fase 20)", () => {
  let sessionId: number;

  it("starts collaboration session", () => {
    const session = startCollaboration(d, {
      topic: "Escolher abordagem para campanha",
      objective: "Aumentar conversão",
      participants: ["research-agent", "copy-agent", "human"],
      maxRounds: 1,
    });
    sessionId = session.id;
    expect(session.status).toBe("ACTIVE");
    expect(session.maxRounds).toBe(1);
  });

  it("posts messages and enforces round limit", () => {
    postCollaborationMessage(d, {
      sessionId,
      fromParticipant: "research-agent",
      toParticipant: "copy-agent",
      type: "QUESTION",
      content: { question: "Qual tom devo usar?" },
    });
    postCollaborationMessage(d, {
      sessionId,
      fromParticipant: "copy-agent",
      toParticipant: "research-agent",
      type: "ANSWER",
      content: { answer: "Tom consultivo." },
    });
    postCollaborationMessage(d, {
      sessionId,
      fromParticipant: "research-agent",
      type: "COUNTERARGUMENT",
      content: { argumento: "dados sugerem tom direto" },
    });
    expect(() =>
      postCollaborationMessage(d, {
        sessionId,
        fromParticipant: "copy-agent",
        type: "COUNTERARGUMENT",
        content: {},
      }),
    ).toThrowError(/limite.*round/i);
  });

  it("creates decision with options and evidence", () => {
    const decision = createDecision(d, {
      sessionId,
      question: "Qual abordagem de copy?",
      options: ["consultivo", "direto"],
      selectedOption: "consultivo",
      participants: ["research-agent", "copy-agent"],
      reasons: ["dados favorecem tom consultivo"],
      confidence: 0.85,
    });
    expect(decision.selectedOption).toBe("consultivo");
    expect(decision.confidence).toBe(0.85);
  });

  it("supports human override", () => {
    const decision = createDecision(d, {
      question: "Usar WhatsApp ou email?",
      options: ["whatsapp", "email"],
      selectedOption: "email",
      decidedBy: "agents",
    });
    const overridden = overrideDecision(d, decision.id, {
      by: "humano",
      reason: "WhatsApp tem maior taxa de resposta no nosso público",
      newSelectedOption: "whatsapp",
    });
    expect(overridden.humanOverride).toBeTruthy();
    expect(overridden.selectedOption).toBe("whatsapp");
  });

  it("resolves collaboration session", () => {
    resolveCollaboration(d, sessionId);
    const session = d
      .prepare("SELECT status FROM collab_sessions WHERE id = ?")
      .get(sessionId) as { status: string };
    expect(session.status).toBe("RESOLVED");
  });

  it("lists messages in chronological order", () => {
    const msgs = listCollaborationMessages(d, sessionId);
    expect(msgs.length).toBeGreaterThan(0);
    for (let i = 1; i < msgs.length; i++) {
      const prev = msgs[i - 1];
      const curr = msgs[i];
      expect(prev && curr ? prev.createdAt <= curr.createdAt : true).toBe(true);
    }
  });
});

describe("context security (fase 20)", () => {
  it("redacts secrets in consultation context", () => {
    const pieces = [
      { label: "config", content: "API key é gsk_ABCDEFGHIJKLMNOPQRSTUV1234567890" },
      { label: "notes", content: "Conteúdo normal sem secrets" },
    ];
    const ctx = buildConsultationContext(pieces);
    expect(ctx[0]).not.toContain("gsk_ABCDEF");
    expect(ctx[1]).toContain("normal");
  });
});
