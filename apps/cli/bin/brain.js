#!/usr/bin/env node
import("../src/main.ts").catch((err) => {
  process.stderr.write(`brain: fatal: ${err?.stack ?? err}\n`);
  process.exitCode = 1;
});
