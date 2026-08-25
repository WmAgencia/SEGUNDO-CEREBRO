import { DatabaseSync } from "node:sqlite";
import { archiveArtifact } from "./drive-tools.ts";

export interface ImageGenResult { status: 'GENERATED'|'NOT_CONFIGURED'|'FAILED'; urls: string[]; model: string; error?: string; }
export interface ImageGenAndArchiveResult extends ImageGenResult { archived?: import("./drive-tools.ts").DriveUploadResult }

/**
 * Generate images via Pollinations.ai — FREE, no API key, no signup.
 * Uses FLUX model. Rate limit: ~1 request per 15 seconds (anonymous).
 * URL: https://image.pollinations.ai/prompt/{encoded_prompt}?width=1024&height=1024&model=flux
 */
export async function generateImageFree(prompt: string, width = 1024, height = 1024): Promise<ImageGenResult> {
  // Long prompts blow past URL limits and fail silently — always cap.
  const capped = prompt.length > 180 ? `${prompt.slice(0, 177)}...` : prompt;
  const encoded = encodeURIComponent(capped);
  const url = `https://image.pollinations.ai/prompt/${encoded}?width=${width}&height=${height}&model=flux&nologo=true`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) return { status:'FAILED', urls:[], model:'pollinations/flux', error:`HTTP ${res.status}` };
    const buffer = await res.arrayBuffer();
    if (buffer.byteLength < 1000) return { status:'FAILED', urls:[], model:'pollinations/flux', error:'Response too small to be an image' };
    // Return the URL directly — Pollinations serves the image at that URL
    return { status:'GENERATED', urls:[url], model:'pollinations/flux' };
  } catch (error) {
    return { status:'FAILED', urls:[], model:'pollinations/flux', error:error instanceof Error ? error.message : String(error) };
  }
}

/** Generate images via OpenRouter Image API. Requires OPENROUTER_API_KEY + privacy config. */
export async function generateImageOpenRouter(prompt: string, count = 1): Promise<ImageGenResult> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return { status:'NOT_CONFIGURED', urls:[], model:'none', error:'OPENROUTER_API_KEY not configured' };
  const res = await fetch('https://openrouter.ai/api/v1/images/generations', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'openai/gpt-image-1', prompt, n: count, size: '1024x1024' }),
    signal: AbortSignal.timeout(120_000),
  });
  const data = await res.json() as { data?: Array<{url?:string}>; error?: {message?:string} };
  if (!res.ok) return { status:'FAILED', urls:[], model:'openai/gpt-image-1', error:data.error?.message ?? `HTTP ${res.status}` };
  const urls = (data.data ?? []).map(d => d.url ?? '').filter(Boolean);
  return { status:'GENERATED', urls, model:'openai/gpt-image-1' };
}

/** Smart router: Pollinations (free). OpenRouter fallback removed — its image endpoint is blocked by data policy and only produced confusing errors. */
export async function generateImage(prompt: string, count = 1): Promise<ImageGenResult> {
  return generateImageFree(prompt);
}

function imageFileName(prompt: string, ext = 'png'): string {
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const slug = prompt.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'imagem';
  return `${stamp}-${slug}.${ext}`;
}

/**
 * Generate an image AND archive it to Google Drive (`Secom/imagens/<data>/arquivo.png`).
 * Returns generation result plus `archived` with the Drive link when configured.
 */
export async function generateImageAndArchive(prompt: string): Promise<ImageGenAndArchiveResult> {
  const result = await generateImage(prompt);
  if (result.status !== 'GENERATED' || result.urls.length === 0) return result;
  try {
    const imgRes = await fetch(result.urls[0]!, { signal: AbortSignal.timeout(60_000) });
    if (!imgRes.ok) return { ...result, archived: { status: 'FAILED', path: '', error: `download HTTP ${imgRes.status}` } };
    const contentType = imgRes.headers.get('content-type') ?? 'image/png';
    const ext = contentType.includes('jpeg') ? 'jpg' : 'png';
    const buffer = Buffer.from(await imgRes.arrayBuffer());
    const archived = await archiveArtifact({
      category: 'imagens',
      fileName: imageFileName(prompt, ext),
      content: buffer,
      mimeType: contentType,
    });
    return { ...result, archived };
  } catch (error) {
    return { ...result, archived: { status: 'FAILED', path: '', error: error instanceof Error ? error.message : String(error) } };
  }
}

/** Register image generation in the model_generations ledger. */
export function logImageGeneration(db: DatabaseSync, prompt: string, result: ImageGenResult, latencyMs: number): void {
  db.prepare("INSERT INTO model_generations (provider,model,status,prompt_tokens,completion_tokens,total_tokens,latency_ms,error) VALUES (?,?,?,?,?,?,?,?,?)")
    .run(result.model.includes('pollinations') ? 'pollinations' : 'openrouter', result.model, result.status, 0, 0, 0, latencyMs, result.error ?? null);
}
