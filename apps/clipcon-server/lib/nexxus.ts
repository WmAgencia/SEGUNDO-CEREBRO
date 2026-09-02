/** Cliente HTTP da Nexxus Pro AI (api.nexxus-pro.site).
 *  OpenAI-compatible: /v1/chat/completions, /v1/audio/transcriptions, etc.
 *  Usa ANTHROPIC_BASE_URL e ANTHROPIC_API_KEY (não NEXXUS_*).
 */
const BASE = process.env.ANTHROPIC_BASE_URL || "https://api.nexxus-pro.site";
const KEY  = process.env.ANTHROPIC_API_KEY  || "";

if (!KEY) {
  console.warn("[nexxus] ANTHROPIC_API_KEY não definida — recursos IA vão falhar");
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
}

export interface ChatOptions {
  model?: string;
  temperature?: number;
  max_tokens?: number;
  /** Força resposta em JSON (equivalente a response_format: json_object) */
  json?: boolean;
}

export async function chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<string> {
  const body: Record<string, unknown> = {
    model: opts.model || process.env.ANTHROPIC_MODEL || "claude-opus-5",
    messages,
    temperature: opts.temperature ?? 0.7,
    max_tokens: opts.max_tokens ?? 2048,
  };
  if (opts.json) {
    body.response_format = { type: "json_object" };
  }
  const resp = await fetch(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${KEY}`,
      "Content-Type": "application/json",
      "User-Agent": "Mozilla/5.0",
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`Nexxus chat error ${resp.status}: ${txt.slice(0, 500)}`);
  }
  const data = await resp.json() as { choices: { message: { content: string } }[] };
  return data.choices[0]?.message?.content ?? "";
}

export async function chatStream(messages: ChatMessage[], opts: ChatOptions = {}): Promise<ReadableStream<string>> {
  const resp = await fetch(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${KEY}`,
      "Content-Type": "application/json",
      "User-Agent": "Mozilla/5.0",
    },
    body: JSON.stringify({
      model: opts.model || process.env.ANTHROPIC_MODEL || "claude-opus-5",
      messages,
      temperature: opts.temperature ?? 0.7,
      max_tokens: opts.max_tokens ?? 2048,
      stream: true,
    }),
  });
  if (!resp.ok || !resp.body) {
    throw new Error(`Nexxus stream error ${resp.status}`);
  }
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  return new ReadableStream<string>({
    async pull(ctrl) {
      const { done, value } = await reader.read();
      if (done) { ctrl.close(); return; }
      const chunk = decoder.decode(value);
      // Parse SSE "data: {json}\n\n"
      const lines = chunk.split("\n").filter((l) => l.startsWith("data: "));
      let text = "";
      for (const line of lines) {
        const data = line.slice(6);
        if (data === "[DONE]") continue;
        try {
          const parsed = JSON.parse(data);
          text += parsed.choices?.[0]?.delta?.content || "";
        } catch {}
      }
      ctrl.enqueue(text);
    },
  });
}
