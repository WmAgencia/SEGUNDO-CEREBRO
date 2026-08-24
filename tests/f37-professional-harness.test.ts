import { describe, expect, it } from "vitest";
import { openDatabase, applySchema } from "../storage/connection.ts";
import { ProfessionalAgentHarness, authorizeSecomCommand, budgetExceeded, canTransition, compileContext, evaluateRun, nutrivaSandbox, validateSandbox } from "../core/agents/professional-harness.ts";
import { compilePersonalContext, isAna, qualityGate } from "../core/personal/personal-agent.ts";
import { ensureCommTables, resolveContact, resolveConversation, saveMessage } from "../core/comms/pipeline.ts";
import { sendMessage } from "../core/comms/evolution-api.ts";

describe("fase 37 professional agent harness", () => {
  it("persiste run, transições, checkpoint, kill switch e recovery", () => {
    const db = openDatabase(":memory:"); applySchema(db);
    const harness = new ProfessionalAgentHarness(db);
    const run = harness.start({ task: "Continue o desenvolvimento do Nutriva.", agentId: "opencode", projectId: "nutriva" });
    expect(run.state).toBe("IDLE");
    harness.move(run.id, "READY"); harness.move(run.id, "PLANNING"); harness.move(run.id, "RUNNING"); harness.checkpoint(run.id, { current: "worker" });
    expect(harness.kill(run.id).state).toBe("CANCELLED");
    expect(db.prepare("SELECT count(*) AS n FROM agent_checkpoints").get()).toEqual({ n: 1 });
    expect(canTransition("PAUSED", "RUNNING")).toBe(false);
    db.close();
  });
  it("limita contexto, budgets, sandbox e SECOM", () => {
    expect(compileContext({ task: "Nutriva", state: "RUNNING", memories: ["x".repeat(100)], maxChars: 20 }).chars).toBe(20);
    expect(budgetExceeded({ maxToolCalls: 2 }, { toolCalls: 2 })).toBe("tool budget exceeded");
    const sandbox = nutrivaSandbox("C:/workspace/apps/nutriva");
    expect(validateSandbox(sandbox, "src/server.ts").allowed).toBe(true);
    expect(validateSandbox(sandbox, ".env.local").allowed).toBe(false);
    expect(authorizeSecomCommand({ senderId: "15981817336", groupId: "120363427273069174@g.us", text: "pare tudo" })).toBe(true);
    expect(authorizeSecomCommand({ senderId: "15981817336", groupId: "5515981817336@s.whatsapp.net", text: "pare tudo" })).toBe(false);
  });
  it("evaluator independente retorna rework quando há falha", () => {
    const result = evaluateRun({ correct_project: true, policy_compliance: false });
    expect(result.status).toBe("NEEDS_REWORK"); expect(result.failed).toContain("policy_compliance");
  });
  it("executa pipeline planejado com checkpoint por etapa", async () => {
    const db = openDatabase(":memory:"); applySchema(db);
    const harness = new ProfessionalAgentHarness(db);
    const run = harness.start({ task: "Nutriva benchmark", agentId: "opencode" });
    const result = await harness.run(run.id, [{ id: "observe", title: "OBSERVE", role: "WORKER" }], async () => ({ ok: true }));
    expect(result.state).toBe("COMPLETED");
    expect((db.prepare("SELECT count(*) AS n FROM agent_checkpoints").get() as { n: number }).n).toBe(1);
    db.close();
  });
  it("isola Ana no contexto pessoal e bloqueia canal privado do owner", async () => {
    const db = openDatabase(":memory:"); applySchema(db); ensureCommTables(db);
    const contact = resolveContact(db, "15981142057", "Ana"); const conversation = resolveConversation(db, contact.id);
    saveMessage(db, conversation.id, "ana-1", "inbound", "Oi");
    const context = compilePersonalContext(db);
    expect(isAna("+55 15 98114-2057")).toBe(true); expect(context?.conversationId).toBe(conversation.id);
    expect(qualityGate(context, "Tudo bem por aqui.").allowed).toBe(true);
    await expect(sendMessage("15981817336", "status administrativo")).rejects.toThrow("OWNER_PRIVATE_CHANNEL_DISABLED");
    db.close();
  });
});
