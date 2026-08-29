/**
 * DIRECT connection between WhatsApp (Evolution API) and Claude.
 * No intermediaries. One endpoint does everything:
 * 1. Receives message from Evolution webhook
 * 2. Calls Claude (via Nexxus)
 * 3. Sends reply back via Evolution
 *
 * All in a single function call. Maximum speed, minimum failure points.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';

const EVOLUTION_API_URL = process.env.EVOLUTION_API_URL ?? '';
const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY ?? '';
const EVOLUTION_INSTANCE = process.env.EVOLUTION_INSTANCE ?? 'SECOM';
const ANTHROPIC_BASE_URL = process.env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? '';
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-5';

// Owner phone in multiple formats
const OWNER_NUMBERS = new Set([
  '5515981817336',
  '15981817336',
  '189494074573054', // LID format
]);

/**
 * Send a WhatsApp message via Evolution API.
 */
async function sendWhatsApp(number: string, text: string): Promise<{ messageId: string } | null> {
  let normalized = number.replace(/\D/g, '');
  if (normalized === '189494074573054') normalized = '5515981817336';
  if (normalized.length === 11 && !normalized.startsWith('55')) normalized = '55' + normalized;

  try {
    const res = await fetch(`${EVOLUTION_API_URL}/message/sendText/${EVOLUTION_INSTANCE}`, {
      method: 'POST',
      headers: { apikey: EVOLUTION_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ number: normalized, text }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      const err = await res.text().catch(() => '');
      console.error('[send] Evolution error', res.status, err.slice(0, 200));
      return null;
    }
    const data = await res.json() as { key?: { id?: string } };
    return { messageId: data.key?.id ?? 'unknown' };
  } catch (err) {
    console.error('[send] Network error', err);
    return null;
  }
}

/**
 * Call Claude via Nexxus/Anthropic.
 */
async function callClaude(userMessage: string): Promise<string | null> {
  try {
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
        system: `Você é o Second Brain OS, assistente pessoal do Junin (Wesley Rocha Santos Junior).

Sobre o Junin:
- Brasileiro, fala português
- Trabalha com desenvolvimento e IA
- Projetos: Nutriva (nutrição), ClipCom, Vyntra, Consecom (publicidade)
- Comunica via WhatsApp pessoal

Diretrizes:
- Responda em português do Brasil, natural
- Seja conciso (WhatsApp)
- Use emojis com moderação
- Sem markdown pesado
- Converse como um parceiro humano

Responda de forma útil e natural.`,
        messages: [{ role: 'user', content: userMessage }],
        temperature: 0.7,
      }),
      signal: AbortSignal.timeout(60_000),
    });

    if (!res.ok) {
      const err = await res.text().catch(() => '');
      console.error('[claude] API error', res.status, err.slice(0, 200));
      return null;
    }

    const data = await res.json() as { content: Array<{ type: string; text?: string }> };
    const text = data.content
      .filter((c) => c.type === 'text' && c.text)
      .map((c) => c.text)
      .join('\n');
    return text || null;
  } catch (err) {
    console.error('[claude] Network error', err);
    return null;
  }
}

/**
 * Main handler: direct Evolution → Claude → Evolution
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  // Health check
  if (req.method === 'GET') {
    res.status(200).json({
      ok: true,
      mode: 'direct',
      model: ANTHROPIC_MODEL,
      instance: EVOLUTION_INSTANCE,
      owner_known: [...OWNER_NUMBERS],
      timestamp: new Date().toISOString(),
    });
    return;
  }

  try {
    const body = (typeof req.body === 'string' ? JSON.parse(req.body) : req.body) as {
      event?: string;
      instance?: string;
      data?: {
        key?: { remoteJid?: string; fromMe?: boolean; id?: string; participant?: string };
        pushName?: string;
        message?: { conversation?: string; extendedTextMessage?: { text?: string } };
      };
    };

    // Filter events
    const event = body?.event?.toUpperCase().replace(/[.\-\s]+/g, '_');
    if (event !== 'MESSAGES_UPSERT') {
      return res.status(200).json({ ok: true, action: `ignored:${event}` });
    }

    // Get sender + content
    const key = body?.data?.key;
    if (!key || key.fromMe) {
      return res.status(200).json({ ok: false, action: 'skipped:from_me' });
    }

    const remoteJid = key.remoteJid ?? '';
    const participant = key.participant ?? '';
    const senderDigits = (remoteJid + participant).replace(/\D/g, '');

    // Check if from owner (any of the known formats)
    const isOwner = [...OWNER_NUMBERS].some((n) => senderDigits.includes(n)) ||
                    senderDigits === '189494074573054';

    if (!isOwner) {
      return res.status(200).json({ ok: true, action: 'skipped:not_owner', sender: senderDigits });
    }

    // Get text
    const content = body?.data?.message?.conversation
      ?? body?.data?.message?.extendedTextMessage?.text
      ?? '';

    if (!content.trim()) {
      return res.status(200).json({ ok: false, action: 'no_content' });
    }

    // Reply target: prefer the actual sender (LID or jid)
    const replyTarget = remoteJid || participant;

    console.log('[agent] Message from owner:', content.slice(0, 100));

    // 1. Call Claude directly
    const reply = await callClaude(content.trim());
    if (!reply) {
      console.error('[agent] Claude returned no reply');
      // Send error to user
      await sendWhatsApp(replyTarget, 'Tive um problema ao processar. Tenta de novo em alguns segundos.');
      return res.status(500).json({ ok: false, error: 'claude_failed' });
    }

    // 2. Send reply directly via Evolution
    const sent = await sendWhatsApp(replyTarget, reply);

    console.log('[agent] Reply sent:', sent?.messageId ?? 'failed');

    return res.status(200).json({
      ok: true,
      action: 'replied',
      messageId: sent?.messageId,
      reply_preview: reply.slice(0, 200),
    });
  } catch (err) {
    console.error('[agent] Error:', err);
    return res.status(500).json({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}