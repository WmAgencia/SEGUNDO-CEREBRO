/**
 * Brain endpoint - calls Claude (via Nexxus) and sends response via WhatsApp.
 * This is the core agent that talks to the user.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';

const EVOLUTION_API_URL = process.env.EVOLUTION_API_URL ?? '';
const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY ?? '';
const EVOLUTION_INSTANCE = process.env.EVOLUTION_INSTANCE ?? 'SECOM';
const OWNER_PHONE = (process.env.OWNER_WHATSAPP ?? '5515981817336').replace(/\D/g, '');
const ANTHROPIC_BASE_URL = process.env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? '';
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-5';

async function callClaude(userMessage: string): Promise<string> {
  const res = await fetch(`${ANTHROPIC_BASE_URL.replace(/\/$/, '')}/v1/messages`, {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 800,
      system: `Você é o Second Brain OS, assistente pessoal do Junin (brasileiro, desenvolvedor, trabalha com IA).

Diretrizes:
- Responda em português do Brasil, natural e amigável
- Seja conciso (WhatsApp)
- Use emojis com moderação
- Se não souber, diga honestamente
- Converse como um parceiro humano
- Não use markdown pesado
- Você tem acesso ao Second Brain (notas Obsidian, projetos: Nutriva, ClipCom, Vyntra, Consecom)

Responda de forma útil e natural.`,
      messages: [{ role: 'user', content: userMessage }],
      temperature: 0.7,
    }),
    signal: AbortSignal.timeout(60_000),
  });

  if (!res.ok) {
    const err = await res.text().catch(() => '');
    throw new Error(`Claude ${res.status}: ${err.slice(0, 200)}`);
  }

  const data = await res.json();
  const text = data.content?.filter((c: { type: string; text?: string }) => c.type === 'text').map((c: { text: string }) => c.text).join('\n');
  return text || '';
}

async function sendWhatsApp(toNumber: string, text: string): Promise<{ messageId: string }> {
  const normalized = toNumber.replace(/\D/g, '');
  const res = await fetch(`${EVOLUTION_API_URL}/message/sendText/${EVOLUTION_INSTANCE}`, {
    method: 'POST',
    headers: { apikey: EVOLUTION_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      number: normalized.startsWith('55') ? normalized : `55${normalized}`,
      text,
    }),
  });
  if (!res.ok) throw new Error(`Evolution ${res.status}`);
  const data = await res.json();
  return { messageId: data.key?.id ?? 'unknown' };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  // Health check
  if (req.method === 'GET') {
    res.status(200).json({ ok: true, model: ANTHROPIC_MODEL, timestamp: new Date().toISOString() });
    return;
  }

  try {
    const body = (typeof req.body === 'string' ? JSON.parse(req.body) : req.body) as { message?: string; from?: string };
    const message = (body?.message ?? '').trim();
    const from = (body?.from ?? OWNER_PHONE).replace(/\D/g, '');

    if (!message) {
      res.status(400).json({ ok: false, error: 'message required' });
      return;
    }

    // Owner can be identified by either:
    // - Exact match against OWNER_PHONE (5515981817336)
    // - The LID format (189494074573054)
    const fromDigits = from.replace(/\D/g, '');
    const ownerDigits = OWNER_PHONE.replace(/\D/g, '');
    const ownerLid = '189494074573054';
    const isOwner =
      fromDigits === ownerDigits ||
      fromDigits === ownerLid ||
      fromDigits === `55${ownerDigits}`;

    if (!isOwner) {
      res.status(200).json({ ok: true, action: 'skipped:not_owner' });
      return;
    }

    const reply = await callClaude(message);
    if (!reply) throw new Error('Empty Claude response');

    const sent = await sendWhatsApp(from, reply);

    res.status(200).json({
      ok: true,
      messageId: sent.messageId,
      reply_preview: reply.slice(0, 200),
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}