import type { FastifyInstance } from "fastify";
import path from "node:path";
import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import { EDLSchema, toRenderEDL } from "../lib/edl.ts";
import { runPython } from "../lib/clipcon-bridge.ts";
import { getProject, ensureProjectSubdir, DATA_DIR } from "../lib/storage.ts";
import { createJob, updateJob, getJob } from "../lib/jobs.ts";

export default async function renderRoutes(app: FastifyInstance) {
  // Renderiza EDL → final.mp4
  app.post("/api/projects/:id/render", async (req, reply) => {
    const { id } = req.params as { id: string };
    const project = getProject(id);
    if (!project) return reply.code(404).send({ error: "project not found" });
    if (!project.sources.length) return reply.code(400).send({ error: "project has no sources" });

    const body = req.body as any;
    const parsed = EDLSchema.safeParse(body.edl);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid edl", details: parsed.error.flatten() });
    }

    // Ajusta paths das sources para absolutos (renderer espera paths reais)
    const edlForRender = {
      ...toRenderEDL(parsed.data),
      sources: Object.fromEntries(
        Object.entries(parsed.data.sources).map(([k, s]) => [
          k,
          {
            path: path.isAbsolute(s.path) ? s.path : path.join(DATA_DIR, id, s.relPath),
            duration: s.duration,
            fps: s.fps,
          },
        ])
      ),
    };

    const editDir = ensureProjectSubdir(id, "edit");
    const edlPath = path.join(editDir, "edl.json");
    writeFileSync(edlPath, JSON.stringify(edlForRender, null, 2));

    const outFile = path.join(editDir, "final.mp4");
    const job = createJob("render");
    updateJob(job.id, { status: "running", startedAt: Date.now() });

    // Roda render.py em background
    runPython("render.py", [edlPath, "-o", outFile, "--no-subtitles"], editDir)
      .then((r) => {
        if (r.code === 0 && existsSync(outFile)) {
          updateJob(job.id, { status: "done", finishedAt: Date.now(), result: { file: "/api/files/" + id + "/edit/final.mp4" } });
        } else {
          updateJob(job.id, { status: "error", error: r.stderr.slice(-1500), finishedAt: Date.now() });
        }
      })
      .catch((err) => {
        updateJob(job.id, { status: "error", error: String(err), finishedAt: Date.now() });
      });

    return reply.code(202).send({ jobId: job.id });
  });

  app.get("/api/jobs/:jobId", async (req, reply) => {
    const job = getJob((req.params as any).jobId);
    if (!job) return reply.code(404).send({ error: "job not found" });
    return job;
  });
}
