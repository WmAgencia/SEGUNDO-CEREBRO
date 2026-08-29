/**
 * Evolution webhook handler - receives WhatsApp messages and processes them.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';

const OWNER_PHONE = (process.env.OWNER_WHATSAPP ?? '5515981817336').replace(/\D/g, '');
const OWNER_LID = '189494074573054';
const SELF_URL = process.env.SELF_URL ?? 'https://segundo-cerebro-jet.vercel.app';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

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
      res.status(200).json({ ok: false, action: 'skipped:from_me_or_no_id' });
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

    // Identify sender - accepts phone, LID, with or without 55 prefix
    const remoteJid = key.remoteJid ?? '';
    const participant = key.participant ?? '';
    const remoteDigits = remoteJid.replace(/\D/g, '');
    const participantDigits = participant.replace(/\D/g, '');

    const isFromOwner =
      remoteDigits === OWNER_PHONE ||
      remoteDigits === OWNER_LID ||
      remoteDigits === OWNER_PHONE.replace(/^55/, '') ||
      participantDigits === OWNER_LID ||
      participantDigits === OWNER_PHONE ||
      participantDigits === OWNER_PHONE.replace(/^55/, '');

    if (!isFromOwner) {
      res.status(200).json({ ok: true, action: 'skipped:not_owner', from: remoteJid });
      return;
    }

    // Forward to brain endpoint
    const brainRes = await fetch(`${SELF_URL}/api/brain`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: content.trim(),
        from: remoteJid || participant,
        pushName: body.data?.pushName,
      }),
      signal: AbortSignal.timeout(90_000),
    });

    const brainData = await brainRes.json();
    res.status(200).json({
      ok: true,
      action: 'forwarded',
      reply_preview: brainData.reply_preview,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}