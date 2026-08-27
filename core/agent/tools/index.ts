/**
 * Assembles the default ToolRegistry for the Single Agent.
 * Every tool wraps a REAL backend. Tools without a backend are NOT registered
 * (no mocks). Availability is declared per tool; runtime availability
 * (e.g. WhatsApp open state) is checked at execution time.
 */

import { ToolRegistry } from "./registry.js";
import { brainSearchTool, memorySearchTool, memoryWriteTool, obsidianSyncTool } from "./knowledge-tools.js";
import { webSearchTool, webFetchTool, imageGenerateTool, goalCreateTool, goalListTool } from "./web-media-tools.js";
import { whatsappSendTool, whatsappStatusTool, opencodeRunTool } from "./comms-tools.js";
import { agendaCreateTool, agendaListTool } from "./agenda-tools.js";

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
    .register(agendaListTool);
}

export { ToolRegistry } from "./registry.js";
export { ToolExecutor } from "./executor.js";
export type { ToolDefinition, ToolExecutionContext } from "./registry.js";
export type { ExecutedTool, ExecuteOptions } from "./executor.js";