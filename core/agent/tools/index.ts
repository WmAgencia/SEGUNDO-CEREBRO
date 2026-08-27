/**
 * Assembles the default ToolRegistry for the Single Agent.
 * Every tool wraps a REAL backend. Tools without a backend are NOT registered
 * (no mocks). Availability is declared per tool; runtime availability
 * (e.g. WhatsApp open state) is checked at execution time.
 */

import { ToolRegistry } from "./registry.ts";
import { brainSearchTool, memorySearchTool, memoryWriteTool, obsidianSyncTool } from "./knowledge-tools.ts";
import { webSearchTool, webFetchTool, imageGenerateTool, goalCreateTool, goalListTool } from "./web-media-tools.ts";
import { whatsappSendTool, whatsappStatusTool, opencodeRunTool } from "./comms-tools.ts";
import { agendaCreateTool, agendaListTool } from "./agenda-tools.ts";
import { graphPlanTool, graphExecuteTool, graphStatusTool, graphListTool, graphRecoverTool } from "./graph-tools.ts";

export function createDefaultRegistry(): ToolRegistry {
  return new ToolRegistry()
    .register(brainSearchTool)
    .register(memorySearchTool)
    .register(memoryWriteTool)
    .register(obsidianSyncTool)
    .register(webSearchTool)
    .register(webFetchTool)
    .register(imageGenerateTool)
    .register(goalCreateTool)
    .register(goalListTool)
    .register(whatsappSendTool)
    .register(whatsappStatusTool)
    .register(opencodeRunTool)
    .register(agendaCreateTool)
    .register(agendaListTool)
    .register(graphPlanTool)
    .register(graphExecuteTool)
    .register(graphStatusTool)
    .register(graphListTool)
    .register(graphRecoverTool);
}

export { ToolRegistry } from "./registry.ts";
export { ToolExecutor } from "./executor.ts";
export type { ToolDefinition, ToolExecutionContext } from "./registry.ts";
export type { ExecutedTool, ExecuteOptions } from "./executor.ts";