/**
 * Simple Evolution webhook handler.
 * Receives WhatsApp messages and processes them through the brain.
 *
 * This is the primary handler - the polling endpoint is just a backup.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';

const EVOLUTION_API_URL = process.env.EVOLUTION_API_URL ?? '';
const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY ?? '';
const EVOLUTION_INSTANCE = process.env.EVOLUTION_INSTANCE ?? 'SECOM';
const OWNER_PHONE = (process.env.OWNER_WHATSAPP ?? '5515981817336').replace(/\D/g, '');
const SELF_URL = process.env.SELF_URL ?? 'https://segundo-cerebro-jet.vercel.app';

async function sendWhatsApp(toNumber: string, text: string): Promise<{ messageId: string }> {
  const normalized = toNumber.replace(/\D/g, '');
  const res = await fetch(`${EVOLUTION_API_URL}/message/sendText/${EVOLUTION_INSTANCE}`, {
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
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Evolution sendMessage ${res.status}: ${errText.slice(0, 200)}`);
  }
  const data = (await res.json()) as { key?: { id?: string } };
  return { messageId: data.key?.id ?? 'unknown' };
}

async function callBrain(message: string, pushName?: string): Promise<string> {
  const brainRes = await fetch(`${SELF_URL}/api/brain`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, from: OWNER_PHONE, pushName }),
    signal: AbortSignal.timeout(60_000),
  });

  if (!brainRes.ok) {
    throw new Error(`Brain endpoint returned ${brainRes.status}`);
  }

  const data = await brainRes.json();
  if (!data.ok) {
    throw new Error(`Brain error: ${data.error ?? 'unknown'}`);
  }

  // Extract the reply text from the brain response
  // The brain endpoint sends the reply via WhatsApp and returns metadata
  return data.reply_preview ?? '(resposta enviada)';
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') {
    res.status(204).end();
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

    const event = body?.event?.toUpperCase().replace(/[.\-\s]+/g, '_');
    if (event !== 'MESSAGES_UPSERT') {
      res.status(200).json({ ok: true, action: `ignored:${event}` });
      return;
    }

    const key = body?.data?.key;
    if (!key || key.fromMe || !key.id) {
      res.status(200).json({ ok: false, action: 'skipped:not_from_owner' });
      return;
    }

    const content =
      body.data?.message?.conversation ??
      body.data?.message?.extendedTextMessage?.text ??
      '';

    if (!content.trim()) {
      res.status(200).json({ ok: false, action: 'no_content' });
      return;
    }

    // Check if it's from the owner (handles both s.whatsapp.net and @lid formats)
    const remoteJid = key.remoteJid ?? '';
    const participant = key.participant ?? '';
    const isFromOwner =
      remoteJid.replace(/\D/g, '') === OWNER_PHONE ||
      participant.replace(/\D/g, '') === OWNER_PHONE;

    if (!isFromOwner) {
      res.status(200).json({ ok: true, action: 'skipped:not_owner' });
      return;
    }

    // Process through brain
    const reply = await callBrain(content.trim(), body.data?.pushName);

    res.status(200).json({
      ok: true,
      action: 'processed',
      reply_preview: reply,
    });
  } catch (err) {
    console.error('[webhook] Error:', err);
    res.status(200).json({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}