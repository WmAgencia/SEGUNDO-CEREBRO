import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createBrainMcpServer } from "./server.ts";
import { createLogger } from "../../core/logger/logger.ts";

const log = createLogger("mcp");

async function main(): Promise<void> {
  const server = createBrainMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log.info("second-brain-mcp listening on stdio");
}

main().catch((err) => {
  process.stderr.write(`second-brain-mcp: fatal: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
