/**
 * Video generation via Pollinations unified API (gen.pollinations.ai).
 * Requires POLLINATIONS_API_KEY (free account at enter.pollinations.ai).
 * Free-tier eligible model: nova-reel (paid_only=false). Fallbacks are cheap paid models.
 * Output archived to Google Drive by generateVideoAndArchive (SECOM/videos/<date>/).
 */
import { archiveArtifact } from "./drive-tools.ts";

const GEN_BASE = "https://gen.pollinations.ai";

export interface VideoGenResult {
  status: "GENERATED" | "NOT_CONFIGURED" | "FAILED";
  model: string;
  content?: Buffer;
  error?: string;
}

/** Cheapest first: silent drafts, then free-tier audio model. */
const VIDEO_MODELS = ["wan-fast", "nova-reel", "seedance-2.0-mini"];

async function tryModel(model: string, prompt: string, durationSec: number): Promise<VideoGenResult | null> {
  try {
    const url = `${GEN_BASE}/video/${encodeURIComponent(prompt)}?model=${model}&duration=${durationSec}&key=${process.env.POLLINATIONS_API_KEY}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(600_000) });
    if (res.status === 404) return null;
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      const parsed = body.match(/"message":"([^"]+)"/)?.[1] ?? body.slice(0, 160);
      return { status: "FAILED", model, error: `HTTP ${res.status}: ${parsed}` };
    }
    const contentType = res.headers.get("content-type") ?? "";
    const buffer = Buffer.from(await res.arrayBuffer());
    if (contentType.includes("application/json") || buffer.byteLength < 10_000) {
      return { status: "FAILED", model, error: `resposta nao-video: ${buffer.toString("utf8").slice(0, 160)}` };
    }
    return { status: "GENERATED", model, content: buffer };
  } catch (error) {
    return { status: "FAILED", model, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function generateVideo(prompt: string, durationSec = 5): Promise<VideoGenResult> {
  if (!process.env.POLLINATIONS_API_KEY) return { status: "NOT_CONFIGURED", model: "none", error: "POLLINATIONS_API_KEY not configured" };
  for (const model of VIDEO_MODELS) {
    const result = await tryModel(model, prompt, durationSec);
    if (result === null) continue;
    if (result.status === "GENERATED") return result;
  }
  return { status: "FAILED", model: VIDEO_MODELS.join(","), error: "nenhum modelo de video disponivel com o saldo atual" };
}

function videoFileName(prompt: string): string {
  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const slug = prompt.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50) || "video";
  return `${stamp}-${slug}.mp4`;
}

export interface VideoGenAndArchiveResult extends VideoGenResult { archived?: import("./drive-tools.ts").DriveUploadResult }

/** Generate a video AND archive it to Drive under videos/<date>/. */
export async function generateVideoAndArchive(prompt: string, durationSec = 5): Promise<VideoGenAndArchiveResult> {
  const result = await generateVideo(prompt, durationSec);
  if (result.status !== "GENERATED" || !result.content) return result;
  const archived = await archiveArtifact({
    category: "videos",
    fileName: videoFileName(prompt),
    content: result.content,
    mimeType: "video/mp4",
  });
  return { ...result, archived };
}
