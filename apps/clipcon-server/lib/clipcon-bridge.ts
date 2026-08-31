import { spawn } from "node:child_process";
import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MONOREPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const PLUGIN_HELPERS = path.join(
  process.env.USERPROFILE || "",
  ".claude",
  "plugins",
  "local",
  "clipcon",
  "helpers",
);

export const PYTHON = process.env.CLIPCON_PYTHON || (process.platform === "win32" ? "python" : "python3");
export const HELPERS_DIR = existsSync(PLUGIN_HELPERS) ? PLUGIN_HELPERS : path.join(MONOREPO_ROOT, "clipcon-helpers");

export function runPython(script: string, args: string[], cwd?: string): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const scriptPath = path.join(HELPERS_DIR, script);
    if (!existsSync(scriptPath)) {
      return reject(new Error(`Python helper not found: ${scriptPath}`));
    }
    const proc = spawn(PYTHON, [scriptPath, ...args], {
      cwd: cwd || HELPERS_DIR,
      env: { ...process.env, PYTHONUNBUFFERED: "1", PYTHONIOENCODING: "utf-8" },
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("close", (code) => resolve({ stdout, stderr, code: code ?? -1 }));
    proc.on("error", reject);
  });
}

export function ffmpeg(args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", args, { env: process.env });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("close", (code) => resolve({ stdout, stderr, code: code ?? -1 }));
    proc.on("error", reject);
  });
}

export function ffprobe(videoPath: string): Promise<{ duration?: number; fps?: number; width?: number; height?: number; hasAudio?: boolean }> {
  return new Promise((resolve) => {
    const proc = spawn("ffprobe", [
      "-v", "error",
      "-select_streams", "v:0",
      "-show_entries", "stream=avg_frame_rate,width,height",
      "-show_entries", "format=duration",
      "-of", "json",
      videoPath,
    ]);
    let out = "";
    proc.stdout.on("data", (d) => (out += d.toString()));
    proc.on("close", async () => {
      try {
        const parsed = JSON.parse(out);
        const stream = parsed.streams?.[0] || {};
        const format = parsed.format || {};
        let fps: number | undefined;
        const fr = stream.avg_frame_rate;
        if (fr && fr !== "0/0") {
          const [n, d] = fr.split("/").map(Number);
          if (d) fps = n / d;
        }
        resolve({
          duration: format.duration ? Number(format.duration) : undefined,
          fps,
          width: stream.width,
          height: stream.height,
        });
        // checa audio em paralelo
        const audioProc = spawn("ffprobe", [
          "-v", "error",
          "-select_streams", "a",
          "-show_entries", "stream=index",
          "-of", "csv=p=0",
          videoPath,
        ]);
        let aout = "";
        audioProc.stdout.on("data", (d) => (aout += d.toString()));
        audioProc.on("close", () => {
          resolve({ ...resolve as any, hasAudio: !!aout.trim() });
        });
      } catch {
        resolve({});
      }
    });
    proc.on("error", () => resolve({}));
  });
}
