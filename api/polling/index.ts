/**
 * Simple backup polling endpoint.
 * Only used if the Evolution webhook fails to fire.
 * Checks the Evolution API once per call - no self-chaining.
 *
 * For 24/7 operation, use cron-job.org or similar to ping every 1-5 minutes.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';

const EVOLUTION_API_URL = process.env.EVOLUTION_API_URL ?? '';
const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY ?? '';
const EVOLUTION_INSTANCE = process.env.EVOLUTION_INSTANCE ?? 'SECOM';
const OWNER_PHONE = (process.env.OWNER_WHATSAPP ?? '5515981817336').replace(/\D/g, '');
const SELF_URL = process.env.SELF_URL ?? 'https://segundo-cerebro-jet.vercel.app';

interface ChatMessage {
  id: string;
  key: { remoteJid: string; fromMe: boolean; id: string; participant?: string };
  message?: { conversation?: string; extendedTextMessage?: { text?: string } };
}

async function evoRequest<T>(method: string, endpoint: string, body?: Record<string, unknown>): Promise<T> {
  const url = `${EVOLUTION_API_URL}${endpoint}`;
  const res = await fetch(url, {
    method,
    headers: { apikey: EVOLUTION_API_KEY, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`Evolution ${res.status}`);
  return (await res.json()) as T;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  try {
    // Check both direct chats and groups for new messages from owner
    const jidsToCheck = [
      `${OWNER_PHONE}@s.whatsapp.net`,
      `${OWNER_PHONE}@lid`,
      '189494074573054@lid',
    ];

    let processed = 0;

    for (const jid of jidsToCheck) {
      const result = await evoRequest<{ messages: { records: ChatMessage[] } }>(
        'POST',
        `/chat/findMessages/${EVOLUTION_INSTANCE}`,
        { where: { key: { remoteJid: jid } }, limit: 5 }
      );

      const messages = result.messages?.records ?? [];
      // Process oldest first
      for (const msg of messages.reverse()) {
        if (msg.key.fromMe || !msg.key.id) continue;

        const content = msg.message?.conversation ?? msg.message?.extendedTextMessage?.text;
        if (!content?.trim()) continue;

        // Send to brain endpoint
        try {
          await fetch(`${SELF_URL}/api/brain`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: content, from: OWNER_PHONE }),
            signal: AbortSignal.timeout(60_000),
          });
          processed++;
          break;
        } catch {
          // Skip on error
        }
      }
      if (processed > 0) break;
    }

    res.status(200).json({
      ok: true,
      processed,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}