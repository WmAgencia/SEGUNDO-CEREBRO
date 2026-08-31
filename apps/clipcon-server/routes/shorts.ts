import type { FastifyInstance } from "fastify";
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { runPython } from "../lib/clipcon-bridge.ts";
import { getProject, ensureProjectSubdir, DATA_DIR } from "../lib/storage.ts";
import { createJob, updateJob } from "../lib/jobs.ts";

export default async function shortsRoutes(app: FastifyInstance) {
  // Lista shorts já gerados em <project>/edit/shorts/
  app.get("/api/projects/:id/shorts", async (req, reply) => {
    const { id } = req.params as { id: string };
    const project = getProject(id);
    if (!project) return reply.code(404).send({ error: "project not found" });
    const dir = path.join(DATA_DIR, id, "edit", "shorts");
    if (!existsSync(dir)) return { shorts: [] };
    const shorts = readdirSync(dir)
      .filter((f) => f.endsWith(".mp4"))
      .map((f) => ({
        name: f,
        url: "/api/files/" + id + "/edit/shorts/" + f,
        size: statSync(path.join(dir, f)).size,
        mtime: statSync(path.join(dir, f)).mtimeMs,
      }));
    return { shorts };
  });

  // Gera shorts a partir de uma source específica
  app.post("/api/projects/:id/shorts", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as { sourcePath?: string; platforms?: string[]; count?: number };
    const project = getProject(id);
    if (!project) return reply.code(404).send({ error: "project not found" });

    let sourcePath = body.sourcePath;
    if (!sourcePath) {
      // Pega o último source uploaded
      const last = project.sources[project.sources.length - 1];
      if (!last) return reply.code(400).send({ error: "no sources in project" });
      sourcePath = last.path;
    }

    const editDir = ensureProjectSubdir(id, "edit");
    const shortsDir = path.join(editDir, "shorts");
    mkdirSync(shortsDir, { recursive: true });

    const job = createJob("shorts");
    updateJob(job.id, { status: "running", startedAt: Date.now() });

    const platforms = body.platforms || ["tiktok", "reels", "shorts"];

    // Roda analyze + shorts (sequencial: analyze primeiro para gerar clipes)
    const tmpOut = path.join(editDir, "shorts-analysis.json");
    runPython("nexxus_analyze.py", ["--video", sourcePath, "--output", tmpOut], editDir)
      .then(async (r1) => {
        if (r1.code !== 0) {
          updateJob(job.id, { status: "error", error: "analyze failed: " + r1.stderr.slice(-500), finishedAt: Date.now() });
          return;
        }
        // Renderiza cada plataforma
        const results: string[] = [];
        for (const platform of platforms) {
          const out = path.join(shortsDir, `clip-${platform}.mp4`);
          const r2 = await runPython(
            "nexxus_shorts.py",
            ["--analysis", tmpOut, "--video", sourcePath, "--platform", platform, "-o", out],
            editDir
          );
          if (r2.code === 0 && existsSync(out)) results.push(out);
        }
        updateJob(job.id, {
          status: results.length ? "done" : "error",
          finishedAt: Date.now(),
          result: { files: results.map((f) => "/api/files/" + id + "/edit/shorts/" + path.basename(f)) },
        });
      })
      .catch((err) => {
        updateJob(job.id, { status: "error", error: String(err), finishedAt: Date.now() });
      });

    return reply.code(202).send({ jobId: job.id });
  });
}
