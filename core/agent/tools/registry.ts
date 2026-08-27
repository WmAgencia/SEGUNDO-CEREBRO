/**
 * Tool Registry for the Single Agent architecture.
 * Each tool declares: name, description, schemas, permissions, risk,
 * approval requirement, timeout, provenance and a real executor.
 * No mocks: tools without a real backend are registered as unavailable.
 */

import type { Permission, RiskLevel, SideEffect, ToolResult } from "../types.ts";
import type { BrainConfig } from "../../config/loader.ts";

export interface ToolSchema {
  type: "object" | "string" | "number" | "boolean" | "array";
  properties?: Record<string, { type: string; description?: string }>;
  required?: string[];
  description?: string;
}

export interface ToolExecutionContext {
  config: BrainConfig;
  sessionId?: string;
  userContext?: {
    name?: string;
    requestApproval?: (toolId: string, input: Record<string, unknown>) => Promise<boolean>;
  };
}

export interface ToolDefinition<I = Record<string, unknown>, O = unknown> {
  id: string;
  name: string;
  description: string;
  category: string;
  permissions: Permission[];
  riskLevel: RiskLevel;
  requiresApproval: boolean;
  timeoutMs: number;
  provenance: string;
  inputSchema: ToolSchema;
  outputSchema: ToolSchema;
  available: boolean;
  unavailableReason?: string;
  execute: (input: I, ctx: ToolExecutionContext) => Promise<ToolResult<O>>;
}

export class ToolRegistry {
  private tools = new Map<string, ToolDefinition>();

  register(tool: ToolDefinition): this {
    if (this.tools.has(tool.id)) throw new Error(`tool already registered: ${tool.id}`);
    this.tools.set(tool.id, tool);
    return this;
  }

  get(id: string): ToolDefinition | undefined {
    return this.tools.get(id);
  }

  list(): ToolDefinition[] {
    return [...this.tools.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  available(): ToolDefinition[] {
    return this.list().filter((t) => t.available);
  }

  summarize(): Array<{ id: string; description: string; category: string; risk: RiskLevel; requiresApproval: boolean; available: boolean }> {
    return this.list().map((t) => ({
      id: t.id,
      description: t.description,
      category: t.category,
      risk: t.riskLevel,
      requiresApproval: t.requiresApproval,
      available: t.available,
    }));
  }
}