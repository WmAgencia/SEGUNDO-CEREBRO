import { DatabaseSync } from "node:sqlite";

export interface ImageGenResult { status: 'GENERATED'|'NOT_CONFIGURED'|'FAILED'; urls: string[]; model: string; error?: string; }

/** Generate images via OpenRouter Image API. Requires OPENROUTER_API_KEY. */
export async function generateImage(prompt: string, count = 1): Promise<ImageGenResult> {
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

/** Register image generation in the model_generations ledger. */
export function logImageGeneration(db: DatabaseSync, prompt: string, result: ImageGenResult, latencyMs: number): void {
  db.prepare("INSERT INTO model_generations (provider,model,status,prompt_tokens,completion_tokens,total_tokens,latency_ms,error) VALUES (?,?,?,?,?,?,?,?,?)")
    .run('openrouter', result.model, result.status, 0, 0, 0, latencyMs, result.error ?? null);
}
