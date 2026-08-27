/**
 * Communication tools — wrap REAL backends:
 * - whatsapp_send  → Evolution API (core/comms/evolution-api.ts) [EXTERNAL, approval]
 * - whatsapp_status → real connection state
 * - opencode_run  → OpenCodeRuntime (core/factory/opencode-runtime.ts) [EXECUTE, approval]
 */

import { ToolDefinition, ToolExecutionContext } from "./registry.js";

export const whatsappSendTool: ToolDefinition = {
  id: "whatsapp_send",
  name: "Enviar WhatsApp",
  description:
    "Envia uma mensagem de texto via Evolution API para um número (formato 5515999999999). Requer instância conectada.",
  category: "communication",
  permissions: ["WRITE", "EXTERNAL"],
  riskLevel: "HIGH",
  requiresApproval: true,
  timeoutMs: 20_000,
  provenance: "external:evolution-api",
  inputSchema: {
    type: "object",
    properties: {
      to: { type: "string", description: "número com DDI/DDD, ex.: 5515981817336" },
      text: { type: "string", description: "conteúdo da mensagem" },
    },
    required: ["to", "text"],
  },
  outputSchema: { type: "object", required: [] },
  available: true,
  execute: async (input) => {
    const { sendMessage, isAvailable } = await import("../../comms/evolution-api.ts");
    const available = await isAvailable();
    if (!available) {
      return { success: false, output: null, error: "Evolution API não configurada ou instância desconectada" };
    }
    const sent = await sendMessage(String(input.to ?? ""), String(input.text ?? ""));
    return { success: true, output: sent };
  },
};

export const whatsappStatusTool: ToolDefinition = {
  id: "whatsapp_status",
  name: "Status do WhatsApp",
  description: "Retorna o estado real da conexão Evolution (open/close/connecting/UNKNOWN).",
  category: "communication",
  permissions: ["READ"],
  riskLevel: "LOW",
  requiresApproval: false,
  timeoutMs: 15_000,
  provenance: "external:evolution-api",
  inputSchema: { type: "object", properties: {}, required: [] },
  outputSchema: { type: "object", required: [] },
  available: true,
  execute: async () => {
    const { isAvailable, getConnectionState } = await import("../../comms/evolution-api.ts");
    const state = await getConnectionState();
    return { success: true, output: { state, usable: await isAvailable() } };
  },
};

export const opencodeRunTool: ToolDefinition = {
  id: "opencode_run",
  name: "Executar trabalho com OpenCode",
  description:
    "Delega uma tarefa de engenharia ao OpenCode CLI (agente externo para código, testes e refatoração). Requer workspace válido.",
  category: "engineering",
  permissions: ["EXECUTE", "WRITE"],
  riskLevel: "HIGH",
  requiresApproval: true,
  timeoutMs: 300_000,
  provenance: "external:opencode",
  inputSchema: {
    type: "object",
    properties: {
      task: { type: "string", description: "descrição da tarefa de engenharia" },
      workspacePath: { type: "string", description: "caminho do projeto (ex.: C:/Users/junin/Clipcon)" },
      model: { type: "string", description: "modelo opcional" },
    },
    required: ["task", "workspacePath"],
  },
  outputSchema: { type: "object", required: [] },
  available: true,
  execute: async (input, ctx) => {
    const { OpenCodeRuntime } = await import("../../factory/opencode-runtime.ts");
    const runtime = new OpenCodeRuntime();
    const session = await runtime.execute(ctx.config, String(input.task ?? ""), {
      workspacePath: String(input.workspacePath ?? ""),
      model: input.model ? String(input.model) : undefined,
    });
    return {
      success: session.status === "COMPLETED",
      output: {
        sessionId: session.sessionId,
        status: session.status,
        output: session.output.slice(0, 5000),
        filesChanged: session.filesChanged,
        testsPassed: session.testsPassed,
        error: session.error,
      },
    };
  },
};