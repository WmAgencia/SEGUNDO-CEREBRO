const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = require("@modelcontextprotocol/sdk/inMemory.js");

process.env.SECOND_BRAIN_LOG_LEVEL = "error";
(async () => {
  const mod = await import("file:///C:/Users/junin/second-brain/mcp/src/server.ts");
  const server = mod.createBrainMcpServer();
  const client = new Client({ name: "m", version: "0" });
  const [a, b] = (await import("@modelcontextprotocol/sdk/inMemory.js")).InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  const tools = await client.listTools();
  let totalChars = 0;
  for (const t of tools.tools) {
    const s = JSON.stringify(t.inputSchema ?? {});
    const d = (t.description ?? "").length;
    totalChars += s.length + d;
    console.log(t.name.padEnd(16), "schema:", String(s.length).padStart(5), "desc:", String(d).padStart(4));
  }
  console.log("TOTAL chars:", totalChars, "≈tokens(~c/4):", Math.round(totalChars / 4));
  await client.close();
})().catch((e) => { console.error(e); process.exit(1); });
