import type { FastifyInstance } from "fastify";
import path from "node:path";
import { nanoid } from "nanoid";
import {
  getProject,
  addSource,
  projectAbsPath,
  ensureProjectSubdir,
  projectRelPath,
  type Source,
} from "../lib/storage.ts";
import { ffprobe, ffmpeg } from "../lib/clipcon-bridge.ts";
import { createJob, updateJob } from "../lib/jobs.ts";

export default async function uploadRoutes(app: FastifyInstance) {
  // Upload de uma source de vídeo
  app.post("/api/projects/:id/upload", async (req, reply) => {
    const id = (req.params as any).id;
    const project = getProject(id);
    if (!project) return reply.code(404).send({ error: "project not found" });

    const data = await (req as any).file();
    if (!data) return reply.code(400).send({ error: "no file uploaded" });

    const sourceId = nanoid(10);
    const ext = path.extname(data.filename || ".mp4") || ".mp4";
    const sourcesDir = ensureProjectSubdir(id, "sources");
    const filename = `${sourceId}${ext}`;
    const absPath = path.join(sourcesDir, filename);
    const relPath = path.posix.join("sources", filename);

    // Salva o arquivo
    const writeStream = (await import("node:fs")).createWriteStream(absPath);
    await new Promise<void>((resolve, reject) => {
      data.file.pipe(writeStream);
      data.file.on("end", resolve);
      data.file.on("error", reject);
    });

    // Probe + metadata
    const meta = await ffprobe(absPath);
    const size = (await import("node:fs")).statSync(absPath).size;

    const source: Source = {
      id: sourceId,
      name: data.filename || filename,
      path: absPath,
      relPath,
      size,
      duration: meta.duration,
      fps: meta.fps,
      width: meta.width,
      height: meta.height,
    };

    // Thumbnail assíncrono (frame em 1s)
    const job = createJob("thumb");
    updateJob(job.id, { status: "running", startedAt: Date.now() });
    try {
      const thumbsDir = ensureProjectSubdir(id, "thumbs");
      const thumbAbs = path.join(thumbsDir, `${sourceId}.jpg`);
      const t = Math.min(1, (meta.duration || 1) / 2);
      const r = await ffmpeg([
        "-y", "-ss", String(t), "-i", absPath,
        "-vframes", "1", "-q:v", "3",
        thumbAbs,
      ]);
      if (r.code === 0) {
        source.thumb = path.posix.join("thumbs", `${sourceId}.jpg`);
      }
      updateJob(job.id, { status: "done", finishedAt: Date.now() });
    } catch (err) {
      updateJob(job.id, { status: "error", error: String(err), finishedAt: Date.now() });
    }

    const updated = addSource(id, source);
    return reply.code(201).send(updated);
  });

  // GET /api/files/:id/<relpath> — serve arquivos do projeto
  app.get("/api/files/:id/*", async (req, reply) => {
    const { id } = req.params as { id: string; "*": string };
    const rel = (req.params as any)["*"];
    const abs = projectAbsPath(id, rel);
    if (!abs.startsWith(projectAbsPath(id, ""))) return reply.code(403).send("forbidden");
    if (!(await import("node:fs")).existsSync(abs)) return reply.code(404).send("not found");

    // Determina content-type pela extensão
    const ext = path.extname(abs).toLowerCase();
    const mime: Record<string, string> = {
      ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime",
      ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp",
      ".json": "application/json", ".srt": "text/plain", ".txt": "text/plain",
    };
    const ct = mime[ext] || "application/octet-stream";
    reply.header("Content-Type", ct);
    reply.header("Cache-Control", "public, max-age=3600");
    const fs = await import("node:fs/promises");
    return reply.send(await fs.readFile(abs));
  });
}
