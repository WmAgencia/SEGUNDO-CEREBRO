export interface TranscriptionRequest {
  audio: Uint8Array;
  mimeType: string;
  durationMs?: number;
}

export interface TranscriptionResult {
  status: "TRANSCRIBED" | "TRANSCRIPTION_PROVIDER_NOT_CONFIGURED" | "TRANSCRIPTION_FAILED";
  text: string | null;
  confidence: number | null;
  provider: string;
  durationMs: number | null;
  createdAt: string;
}

export interface TranscriptionProvider {
  readonly name: string;
  transcribe(request: TranscriptionRequest): Promise<{ text: string; confidence?: number }>;
}

export class NotConfiguredTranscriptionProvider implements TranscriptionProvider {
  readonly name = "not-configured";
  async transcribe(_request: TranscriptionRequest): Promise<{ text: string }> {
    throw new Error("TRANSCRIPTION_PROVIDER_NOT_CONFIGURED");
  }
}

export class OpenAICompatibleTranscriptionProvider implements TranscriptionProvider {
  readonly name = "openai-compatible-transcription";
  private readonly url: string;
  private readonly apiKey: string;
  constructor(url = process.env.SECOND_BRAIN_TRANSCRIPTION_URL ?? "", apiKey = process.env.SECOND_BRAIN_TRANSCRIPTION_KEY ?? "") { this.url = url; this.apiKey = apiKey; }
  async transcribe(request: TranscriptionRequest): Promise<{ text: string; confidence?: number }> {
    if (!this.url || !this.apiKey) throw new Error("TRANSCRIPTION_PROVIDER_NOT_CONFIGURED");
    const form = new FormData(); form.append("file", new Blob([request.audio], { type: request.mimeType }), "command.webm"); form.append("model", "whisper-1");
    const response = await fetch(this.url, { method: "POST", headers: { Authorization: `Bearer ${this.apiKey}` }, body: form, signal: AbortSignal.timeout(60_000) });
    if (!response.ok) throw new Error(`transcription provider HTTP ${response.status}`);
    const data = await response.json() as { text?: string; confidence?: number };
    if (!data.text) throw new Error("transcription provider returned no text");
    return { text: data.text, confidence: data.confidence };
  }
}

export async function transcribeAudio(request: TranscriptionRequest, provider: TranscriptionProvider = new OpenAICompatibleTranscriptionProvider()): Promise<TranscriptionResult> {
  const createdAt = new Date().toISOString();
  try { const result = await provider.transcribe(request); return { status: "TRANSCRIBED", text: result.text, confidence: result.confidence ?? null, provider: provider.name, durationMs: request.durationMs ?? null, createdAt }; }
  catch (error) { const message = error instanceof Error ? error.message : String(error); return { status: message === "TRANSCRIPTION_PROVIDER_NOT_CONFIGURED" ? "TRANSCRIPTION_PROVIDER_NOT_CONFIGURED" : "TRANSCRIPTION_FAILED", text: null, confidence: null, provider: provider.name, durationMs: request.durationMs ?? null, createdAt }; }
}
