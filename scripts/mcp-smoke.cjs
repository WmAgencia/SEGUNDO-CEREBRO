const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");

(async () => {
  const transport = new StdioClientTransport({
    command: "node",
    args: ["mcp/src/main.ts"],
    cwd: process.cwd(),
    env: {
      ...(process.env),
      SECOND_BRAIN_VAULT: process.env.SECOND_BRAIN_VAULT,
      SECOND_BRAIN_LOG_LEVEL: "error",
    },
  });
  const client = new Client({ name: "smoke", version: "0" });
  await client.connect(transport);

  const tools = await client.listTools();
  console.log("tools:", tools.tools.map((t) => t.name).join(", "));

  const health = await client.callTool({ name: "brain_health", arguments: {} });
  console.log("health.isError:", health.isError === true);
  const h = JSON.parse(health.content[0].text);
  console.log("counts:", JSON.stringify(h.counts), "| schema v" + h.schemaVersion);

  const search = await client.callTool({
    name: "brain_search",
    arguments: { query: "segundo cerebro vault" },
  });
  const s = JSON.parse(search.content[0].text);
  console.log("search total:", s.total);

  await client.close();
})().catch((e) => {
  console.error("SMOKE FAIL:", e.message);
  process.exit(1);
});
