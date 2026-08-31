import type { FastifyInstance } from "fastify";
import path from "node:path";
import { existsSync } from "node:fs";
import { ffprobe, ffmpeg, runPython } from "../lib/clipcon-bridge.ts";
import { projectAbsPath, getProject, ensureProjectSubdir } from "../lib/storage.ts";
import { createJob, updateJob } from "../lib/jobs.ts";

export default async function mediaRoutes(app: FastifyInstance) {
  // Probe de um arquivo (ffprobe)
  app.get("/api/media/probe", async (req, reply) => {
    const { path: p } = req.query as { path: string };
    if (!p || !existsSync(p)) return reply.code(404).send({ error: "file not found" });
    const meta = await ffprobe(p);
    return meta;
  });

  // Thumbnail sob demanda
  app.get("/api/media/thumb", async (req, reply) => {
    const { path: p, t = "1", project } = req.query as { path: string; t?: string; project?: string };
    if (!p || !existsSync(p)) return reply.code(404).send({ error: "file not found" });
    const tNum = Number(t) || 1;
    const job = createJob("thumb");
    updateJob(job.id, { status: "running", startedAt: Date.now() });
    const tmpOut = path.join(process.env.TEMP || "/tmp", `thumb-${Date.now()}.jpg`);
    try {
      await ffmpeg(["-y", "-ss", String(tNum), "-i", p, "-vframes", "1", "-q:v", "3", tmpOut]);
      const buf = await (await import("node:fs")).promises.readFile(tmpOut);
      await (await import("node:fs")).promises.unlink(tmpOut).catch(() => {});
      updateJob(job.id, { status: "done", finishedAt: Date.now() });
      reply.header("Content-Type", "image/jpeg");
      return reply.send(buf);
    } catch (err) {
      updateJob(job.id, { status: "error", error: String(err), finishedAt: Date.now() });
      return reply.code(500).send({ error: String(err) });
    }
  });

  // Waveform: gera peaks JSON (512 bins) com ffmpeg
  app.get("/api/media/waveform", async (req, reply) => {
    const { path: p, bins = "512" } = req.query as { path: string; bins?: string };
    if (!p || !existsSync(p)) return reply.code(404).send({ error: "file not found" });
    const nBins = Math.max(64, Math.min(2048, Number(bins) || 512));
    const tmpOut = path.join(process.env.TEMP || "/tmp", `wave-${Date.now()}.raw`);
    try {
      // 1) extrai audio mono 16kHz em raw 16-bit PCM
      await ffmpeg([
        "-y", "-i", p,
        "-ac", "1", "-ar", "8000",
        "-f", "s16le", "-acodec", "pcm_s16le",
        tmpOut,
      ]);
      // 2) lê e agrupa em N bins de peak (max abs)
      const buf = await (await import("node:fs")).promises.readFile(tmpOut);
      const samples = new Int16Array(buf.buffer, buf.byteOffset, buf.byteLength / 2);
      const blockSize = Math.max(1, Math.floor(samples.length / nBins));
      const peaks: number[] = [];
      for (let i = 0; i < nBins; i++) {
        let peak = 0;
        const start = i * blockSize;
        const end = Math.min(samples.length, start + blockSize);
        for (let j = start; j < end; j++) {
          const v = Math.abs(samples[j]);
          if (v > peak) peak = v;
        }
        peaks.push(peak / 32768);
      }
      await (await import("node:fs")).promises.unlink(tmpOut).catch(() => {});
      return { peaks, duration: samples.length / 8000, bins: nBins };
    } catch (err) {
      return reply.code(500).send({ error: String(err) });
    }
  });

  // Silence detection: usa ffmpeg silencedetect, retorna gaps
  app.get("/api/media/silences", async (req, reply) => {
    const { path: p, min = "0.5", noise = "-30dB" } = req.query as { path: string; min?: string; noise?: string };
    if (!p || !existsSync(p)) return reply.code(404).send({ error: "file not found" });
    try {
      const r = await ffmpeg([
        "-i", p,
        "-af", `silencedetect=noise=${noise}:d=${min}`,
        "-f", "null", "-",
      ]);
      const stderr = r.stderr;
      const silences: { start: number; end: number }[] = [];
      const re = /silence_start: ([0-9.]+)|silence_end: ([0-9.]+)/g;
      let m: RegExpExecArray | null;
      let start: number | null = null;
      while ((m = re.exec(stderr))) {
        if (m[1]) start = Number(m[1]);
        if (m[2] && start != null) {
          silences.push({ start, end: Number(m[2]) });
          start = null;
        }
      }
      return { silences };
    } catch (err) {
      return reply.code(500).send({ error: String(err) });
    }
  });
}
