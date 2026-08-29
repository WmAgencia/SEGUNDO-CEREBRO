/**
 * Vercel Function: Uses Nexxus (Anthropic-compatible) to generate intelligent
 * responses to WhatsApp messages from the owner.
 *
 * This is the brain of the WhatsApp integration - it calls Claude via Nexxus
 * to actually understand and respond to messages.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';

const EVOLUTION_API_URL = process.env.EVOLUTION_API_URL ?? '';
const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY ?? '';
const EVOLUTION_INSTANCE = process.env.EVOLUTION_INSTANCE ?? 'SECOM';
const OWNER_PHONE = (process.env.OWNER_WHATSAPP ?? '5515981817336').replace(/\D/g, '');
const ANTHROPIC_BASE_URL = process.env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? '';
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-5';

interface AnthropicRequest {
  model: string;
  max_tokens: number;
  system: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  temperature?: number;
}

interface AnthropicResponse {
  content: Array<{ type: string; text?: string }>;
  model: string;
  usage?: { input_tokens: number; output_tokens: number };
}

// Secret redaction
const SECRET_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  { pattern: /gsk_[A-Za-z0-9]{20,}/g, replacement: '[REDACTED:gsk]' },
  { pattern: /sk-ant-[A-Za-z0-9_-]{16,}/g, replacement: '[REDACTED:sk-ant]' },
  { pattern: /sk-nx-[A-Za-z0-9]{20,}/g, replacement: '[REDACTED:sk-nx]' },
  { pattern: /sk-or-v1-[A-Za-z0-9]{20,}/g, replacement: '[REDACTED:openrouter]' },
  { pattern: /hf_[A-Za-z0-9]{20,}/g, replacement: '[REDACTED:huggingface]' },
  { pattern: /ghp_[A-Za-z0-9]{20,}/g, replacement: '[REDACTED:github]' },
  { pattern: /AIza[0-9A-Za-z_-]{35}/g, replacement: '[REDACTED:google]' },
  { pattern: /Bearer\s+[A-Za-z0-9_.\-]{20,}/gi, replacement: 'Bearer [REDACTED]' },
  { pattern: /([a-zA-Z0-9._%+-]+):([a-zA-Z0-9._%+-]+)@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, replacement: '[REDACTED:credentials]' },
];

function redact(text: string): string {
  if (!text) return text;
  let result = text;
  for (const { pattern, replacement } of SECRET_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

async function callAnthropic(system: string, userMessage: string, history: Array<{ role: 'user' | 'assistant'; content: string }> = []): Promise<string> {
  if (!ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY not configured');
  }

  const body: AnthropicRequest = {
    model: ANTHROPIC_MODEL,
    max_tokens: 800,
    system,
    messages: [...history, { role: 'user', content: userMessage }],
    temperature: 0.7,
  };

  const url = `${ANTHROPIC_BASE_URL.replace(/\/$/, '')}/v1/messages`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(`Anthropic ${response.status}: ${errorText.slice(0, 300)}`);
  }

  const data = (await response.json()) as AnthropicResponse;
  const textContent = data.content
    .filter((c) => c.type === 'text' && c.text)
    .map((c) => c.text)
    .join('\n');
  return textContent || '';
}

async function sendWhatsApp(toNumber: string, text: string): Promise<{ messageId: string }> {
  const normalized = toNumber.replace(/\D/g, '');
  const result = await fetch(`${EVOLUTION_API_URL}/message/sendText/${EVOLUTION_INSTANCE}`, {
    method: 'POST',
    headers: {
      apikey: EVOLUTION_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      number: normalized.startsWith('55') ? normalized : `55${normalized}`,
      text,
    }),
  });
  if (!result.ok) {
    const errText = await result.text().catch(() => '');
    throw new Error(`Evolution sendMessage ${result.status}: ${errText.slice(0, 200)}`);
  }
  const data = (await result.json()) as { key?: { id?: string } };
  return { messageId: data.key?.id ?? 'unknown' };
}

const SYSTEM_PROMPT = `Você é o Second Brain OS, um assistente pessoal de IA conversacional do Junin (seu dono único).

Diretrizes:
- Responda SEMPRE em português do Brasil, de forma natural e amigável
- Seja conciso (WhatsApp tem limite prático de leitura)
- Use emojis com moderação
- Se não souber algo, diga honestamente
- Converse como um parceiro humano, não como robô
- Não use markdown pesado (WhatsApp não renderiza bem)
- Para listas use • ou emojis

Você tem acesso ao Second Brain (notas do Obsidian, memórias, projetos). Use essas informações quando relevante.

Sobre o Junin:
- Ele é brasileiro, fala português
- Trabalha com desenvolvimento e IA
- Tem projetos: Nutriva, ClipCom, Vyntra, Consecom
- Usa WhatsApp pessoal (5515981817336) para falar com você

Responda de forma útil e natural.`;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  try {
    if (!ANTHROPIC_API_KEY) {
      res.status(500).json({
        ok: false,
        error: 'ANTHROPIC_API_KEY not configured in Vercel',
      });
      return;
    }

    // Test/health endpoint
    if (req.method === 'GET') {
      res.status(200).json({
        ok: true,
        provider: 'anthropic',
        model: ANTHROPIC_MODEL,
        base_url: ANTHROPIC_BASE_URL,
        owner_phone: OWNER_PHONE,
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Process incoming message
    const body = (typeof req.body === 'string' ? JSON.parse(req.body) : req.body) as {
      message?: string;
      from?: string;
      pushName?: string;
    };

    const message = (body?.message ?? '').trim();
    const from = (body?.from ?? OWNER_PHONE).replace(/\D/g, '');

    if (!message) {
      res.status(400).json({ ok: false, error: 'message required' });
      return;
    }

    if (from !== OWNER_PHONE) {
      res.status(200).json({ ok: true, action: 'skipped:not_owner' });
      return;
    }

    // Redact secrets before sending to LLM
    const safeMessage = redact(message);

    console.log('[BRAIN] Processing message from owner', { length: message.length, preview: safeMessage.slice(0, 100) });

    // Call Anthropic
    const startTime = Date.now();
    const reply = await callAnthropic(SYSTEM_PROMPT, safeMessage);
    const latencyMs = Date.now() - startTime;

    if (!reply.trim()) {
      throw new Error('Empty response from LLM');
    }

    // Send via WhatsApp
    const sent = await sendWhatsApp(OWNER_PHONE, reply);

    console.log('[BRAIN] Reply sent', { messageId: sent.messageId, latencyMs });

    res.status(200).json({
      ok: true,
      action: 'brain_reply_sent',
      messageId: sent.messageId,
      latencyMs,
      model: ANTHROPIC_MODEL,
      reply_preview: reply.slice(0, 200),
    });
  } catch (err) {
    console.error('[BRAIN] Error:', err);
    const errorMsg = err instanceof Error ? err.message : String(err);

    // Try to send error notification to owner
    try {
      await sendWhatsApp(
        OWNER_PHONE,
        '⚠️ Ops! Tive um problema ao processar sua mensagem.\n\n' +
        `Erro: ${errorMsg.slice(0, 200)}\n\n` +
        'Tente novamente em alguns segundos.'
      );
    } catch {
      // Ignore secondary errors
    }

    res.status(500).json({
      ok: false,
      error: errorMsg,
    });
  }
}