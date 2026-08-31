import Fastify from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import websocket from "@fastify/websocket";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Carrega .env do monorepo raiz
// server.ts está em apps/clipcon-server/server.ts → monorepo é 2 níveis acima
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..", "..");
const envPath = path.join(root, ".env.local");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (match?.[1] && match[2] !== undefined && !process.env[match[1]]) {
      process.env[match[1]] = match[2].trim();
    }
  }
}
// Também carrega o .env do plugin clipcon (NEXXUS_API_KEY, etc)
const pluginEnv = path.join(process.env.USERPROFILE || "", ".claude", "plugins", "local", "clipcon", ".env");
if (existsSync(pluginEnv)) {
  for (const line of readFileSync(pluginEnv, "utf8").split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (match?.[1] && match[2] !== undefined && !process.env[match[1]]) {
      process.env[match[1]] = match[2].trim();
    }
  }
}

const DATA_DIR = path.join(root, "data", "clipcon-projects");
mkdirSync(DATA_DIR, { recursive: true });

console.log(`[clipcon-server] starting…`);
console.log(`[env] NEXXUS_API_KEY=${process.env.NEXXUS_API_KEY ? "present" : "MISSING"}`);
console.log(`[env] ELEVENLABS_API_KEY=${process.env.ELEVENLABS_API_KEY ? "present" : "MISSING"}`);
console.log(`[env] CLIPCON_HELPERS=${process.env.CLIPCON_HELPERS || "default"}`);

const app = Fastify({ logger: true, bodyLimit: 1024 * 1024 * 200 });

await app.register(cors, { origin: true, credentials: true });
await app.register(multipart, {
  limits: { fileSize: 1024 * 1024 * 2000 }, // 2GB
});
await app.register(websocket);

app.get("/api/health", async () => ({ ok: true, ts: Date.now() }));

// Routes
const projectsRoutes = (await import("./routes/projects.ts")).default;
const uploadRoutes = (await import("./routes/upload.ts")).default;
const mediaRoutes = (await import("./routes/media.ts")).default;
const renderRoutes = (await import("./routes/render.ts")).default;
const shortsRoutes = (await import("./routes/shorts.ts")).default;
const chatRoutes = (await import("./routes/chat.ts")).default;

await app.register(projectsRoutes);
await app.register(uploadRoutes);
await app.register(mediaRoutes);
await app.register(renderRoutes);
await app.register(shortsRoutes);
await app.register(chatRoutes);

const port = Number(process.env.CLIPCON_PORT ?? 3300);
const host = process.env.CLIPCON_HOST ?? "0.0.0.0";

app.listen({ port, host }).then(() => {
  console.log(`[clipcon-server] listening on http://${host}:${port}`);
});
