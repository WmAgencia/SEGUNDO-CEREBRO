import { startServer } from "./webhook-server.ts";
import { loadConfig } from "../config/loader.ts";
import { existsSync, readFileSync } from "node:fs";

function loadLocalEnv(): void {
  const file = ".env.local";
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match?.[1] && process.env[match[1]] === undefined) {
      process.env[match[1]] = match[2] ?? "";
    }
  }
}

loadLocalEnv();
const config = loadConfig();
const port = Number(process.env.WEBHOOK_PORT ?? "3001");
startServer(config, port);
