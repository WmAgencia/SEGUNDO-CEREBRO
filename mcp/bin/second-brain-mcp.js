#!/usr/bin/env node
import("../src/main.ts").catch((err) => {
  process.stderr.write(`second-brain-mcp: fatal: ${err?.stack ?? err}\n`);
  process.exitCode = 1;
});
