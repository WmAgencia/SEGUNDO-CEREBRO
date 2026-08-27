/**
 * Agenda tools — real persistence in `agenda_events` table.
 * - agenda_create → register event (WRITE, approval)
 * - agenda_list   → query events (READ)
 */

import { ToolDefinition, ToolExecutionContext } from "./registry.js";

export const agendaCreateTool: ToolDefinition = {
  id: "agenda_create",
  name: "Criar compromisso na agenda",
  description:
    "Registra um evento/compromisso na agenda do Second Brain. Ex.: 'reunião amanhã às 15h'. Aceita datas ISO (aaaammdd ou ISO 8601).",
  category: "planning",
  permissions: ["WRITE"],
  riskLevel: "MEDIUM",
  requiresApproval: true,
  timeoutMs: 10_000,
  provenance: "second-brain:agenda",
  inputSchema: {
    type: "object",
    properties: {
      title: { type: "string", description: "título do compromisso" },
      startsAt: { type: "string", description: "início ISO (ex.: 2026-08-28T15:00:00-03:00)" },
      description: { type: "string" },
      project: { type: "string" },
    },
    required: ["title", "startsAt"],
  },
  outputSchema: { type: "object", required: [] },
  available: true,
  execute: async (input, ctx) => {
    const { openDatabase } = await import("../../../storage/connection.ts");
    const db = openDatabase(ctx.config.dbPath);
    try {
      const startsAt = String(input.startsAt ?? "");
      const parsed = new Date(startsAt);
      if (Number.isNaN(parsed.getTime())) {
        return { success: false, output: null, error: `data inválida: ${startsAt}` };
      }
      const result = db.prepare(
        "INSERT INTO agenda_events (title, description, starts_at, project, status) VALUES (?, ?, ?, ?, 'scheduled')",
      ).run(String(input.title ?? ""), String(input.description ?? ""), parsed.toISOString(), input.project ? String(input.project) : null);
      return {
        success: true,
        output: { id: Number(result.lastInsertRowid), title: String(input.title ?? ""), startsAt: parsed.toISOString() },
      };
    } finally {
      db.close();
    }
  },
};

export const agendaListTool: ToolDefinition = {
  id: "agenda_list",
  name: "Consultar agenda",
  description:
    "Lista compromissos da agenda (próximos por padrão). Use para lembrar reuniões, prazos e compromissos do usuário.",
  category: "planning",
  permissions: ["READ"],
  riskLevel: "LOW",
  requiresApproval: false,
  timeoutMs: 10_000,
  provenance: "second-brain:agenda",
  inputSchema: {
    type: "object",
    properties: {
      from: { type: "string", description: "a partir de (ISO); default agora" },
      limit: { type: "number", description: "máx. de eventos (default 10)" },
    },
    required: [],
  },
  outputSchema: { type: "object", required: [] },
  available: true,
  execute: async (input, ctx) => {
    const { openDatabase } = await import("../../../storage/connection.ts");
    const db = openDatabase(ctx.config.dbPath);
    try {
      const from = input.from ? new Date(String(input.from)) : new Date();
      const rows = db.prepare(
        "SELECT id, title, description, starts_at, ends_at, project, status, created_at FROM agenda_events WHERE starts_at >= ? ORDER BY starts_at ASC LIMIT ?",
      ).all(from.toISOString(), Number(input.limit ?? 10)) as Array<{
        id: number; title: string; description: string; starts_at: string; ends_at: string | null; project: string | null;
        status: string; created_at: string;
      }>;
      return {
        success: true,
        output: rows.map((r) => ({
          id: r.id,
          title: r.title,
          description: r.description,
          startsAt: r.starts_at,
          endsAt: r.ends_at,
          project: r.project,
          status: r.status,
        })),
      };
    } finally {
      db.close();
    }
  },
};