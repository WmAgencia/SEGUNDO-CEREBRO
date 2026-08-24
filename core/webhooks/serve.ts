import { startServer } from "./webhook-server.ts";
import { loadConfig } from "../config/loader.ts";

const config = loadConfig();
const port = Number(process.env.WEBHOOK_PORT ?? "3001");
startServer(config, port);
