/**
 * Tool Executor — policy/permission → approval gate → execution → result.
 *
 * Flow: LLM decides tool → registry validates → policy → approval if needed
 * → execute with timeout → provenance → result back to the agent.
 *
 * READ tools: auto-executed (low risk).
 * WRITE/EXTERNAL/DESTRUCTIVE tools: require in-band approval via
 * userContext.requestApproval. If no approval function is provided or the
 * user rejects, execution is BLOCKED (never silently executed).
 */

import { DatabaseSync } from "node:sqlite";
import { ToolRegistry } from "./registry.ts";
import type { ToolExecutionContext } from "./registry.ts";
import type { ToolResult } from "../types.ts";

export interface ExecutedTool extends ToolResult<unknown> {
  toolId: string;
  latencyMs: number;
  provenance: string;
  approved: boolean;
}

export interface ExecuteOptions {
  toolId: string;
  input: Record<string, unknown>;
  ctx: ToolExecutionContext;
  approvalPolicy?: "auto" | "always";
  sessionId?: string;
  /** True when the human already approved this exact call (resume flow). */
  preApproved?: boolean;
}

function validateInput(toolId: string, input: Record<string, unknown>, schema: { required?: string[] }): void {
  if (!input || typeof input !== "object") throw new Error(`input must be an object for tool ${toolId}`);
  for (const field of schema.required ?? []) {
    const value = input[field];
    if (value === undefined || value === null || value === "") {
      throw new Error(`missing required field: ${field}`);
    }
  }
}

export class ToolExecutor {
  private registry: ToolRegistry;

  constructor(registry: ToolRegistry) {
    this.registry = registry;
  }

  async execute(options: ExecuteOptions): Promise<ExecutedTool> {
    const started = Date.now();
    const tool = this.registry.get(options.toolId);
    if (!tool) return { success: false, toolId: options.toolId, error: `tool not found: ${options.toolId}`, output: null, latencyMs: Date.now() - started, provenance: "registry", approved: false };
    if (!tool.available) return { success: false, toolId: tool.id, error: `tool unavailable: ${tool.unavailableReason ?? "not configured"}`, output: null, latencyMs: Date.now() - started, provenance: tool.provenance, approved: false };

    try {
      validateInput(tool.id, options.input, tool.inputSchema);
    } catch (error) {
      return { success: false, toolId: tool.id, error: error instanceof Error ? error.message : String(error), output: null, latencyMs: Date.now() - started, provenance: tool.provenance, approved: false };
    }

    // ── APPROVAL GATE ──
    const requiresApproval = options.approvalPolicy === "always" || tool.requiresApproval;
    if (requiresApproval && !options.preApproved) {
      const requestApproval = options.ctx.userContext?.requestApproval;
      if (!requestApproval) {
        return { success: false, toolId: tool.id, error: `approval required for ${tool.id} but no approval channel available`, output: null, latencyMs: Date.now() - started, provenance: tool.provenance, approved: false };
      }
      let approved = false;
      try {
        approved = await requestApproval(tool.id, options.input);
      } catch {
        approved = false;
      }
      if (!approved) {
        return { success: false, toolId: tool.id, error: `execution rejected by user (${tool.id})`, output: null, latencyMs: Date.now() - started, provenance: tool.provenance, approved: false };
      }
    }

    // ── EXECUTE WITH TIMEOUT ──
    try {
      const result = await Promise.race([
        tool.execute(options.input, options.ctx),
        new Promise<ToolResult<unknown>>((resolve) => setTimeout(() => resolve({ success: false, output: null, error: `timeout after ${tool.timeoutMs}ms` }), tool.timeoutMs)),
      ]);
      return { ...result, toolId: tool.id, latencyMs: Date.now() - started, provenance: tool.provenance, approved: requiresApproval };
    } catch (error) {
      return { success: false, toolId: tool.id, error: error instanceof Error ? error.message : String(error), output: null, latencyMs: Date.now() - started, provenance: tool.provenance, approved: requiresApproval };
    }
  }

  recordEvent(config: { dbPath: string }, event: { toolId: string; success: boolean; latencyMs: number; input: Record<string, unknown>; error?: string; sessionId?: string }): void {
    try {
      const db = new DatabaseSync(config.dbPath);
      try {
        db.prepare("INSERT INTO events (event_type, subject, payload) VALUES ('tool_execution', ?, ?)").run(
          event.toolId,
          JSON.stringify({
            success: event.success,
            latency_ms: event.latencyMs,
            session: event.sessionId ?? null,
            error: event.error ?? null,
          }),
        );
      } finally {
        db.close();
      }
    } catch {
      // provenance is best-effort; never fails the tool call
    }
  }
}