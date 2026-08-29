/**
 * Simple backup polling endpoint.
 * Only used if the Evolution webhook fails to fire.
 * Checks the Evolution API once per call - no self-chaining.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';

const EVOLUTION_API_URL = process.env.EVOLUTION_API_URL ?? '';
const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY ?? '';
const EVOLUTION_INSTANCE = process.env.EVOLUTION_INSTANCE ?? 'SECOM';
const SELF_URL = process.env.SELF_URL ?? 'https://segundo-cerebro-jet.vercel.app';

interface ChatMessage {
  id: string;
  key: { remoteJid: string; fromMe: boolean; id: string; participant?: string };
  pushName?: string;
  message?: { conversation?: string; extendedTextMessage?: { text?: string } };
  messageTimestamp?: number;
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

declare global {
  // eslint-disable-next-line no-var
  var __processedMessages: Set<string> | undefined;
}

const getProcessed = (): Set<string> => {
  if (!globalThis.__processedMessages) {
    globalThis.__processedMessages = new Set<string>();
  }
  if (globalThis.__processedMessages.size > 1000) {
    // Keep only recent 500
    const arr = [...globalThis.__processedMessages];
    globalThis.__processedMessages = new Set(arr.slice(-500));
  }
  return globalThis.__processedMessages;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  try {
    const processed = getProcessed();
    let processedCount = 0;
    const results: Array<{ id: string; action: string; preview?: string }> = [];

    // Check both direct chats and groups for new messages from owner
    const jidsToCheck = [
      '189494074573054@lid',  // LID format (primary based on observed messages)
      '5515981817336@s.whatsapp.net',
      '5515981817336@lid',
    ];

    for (const jid of jidsToCheck) {
      const result = await evoRequest<{ messages: { records: ChatMessage[] } }>(
        'POST',
        `/chat/findMessages/${EVOLUTION_INSTANCE}`,
        { where: { key: { remoteJid: jid } }, limit: 10 }
      );

      const messages = result.messages?.records ?? [];
      // Process oldest first (reverse to get chronological order)
      const chronological = [...messages].reverse();

      for (const msg of chronological) {
        if (msg.key.fromMe || !msg.key.id) continue;
        if (processed.has(msg.key.id)) continue;

        const content = msg.message?.conversation ?? msg.message?.extendedTextMessage?.text;
        if (!content?.trim()) continue;

        processed.add(msg.key.id);
        processedCount++;

        try {
          const brainRes = await fetch(`${SELF_URL}/api/brain`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              message: content,
              from: jid,
            }),
            signal: AbortSignal.timeout(60_000),
          });

          const brainData = await brainRes.json();
          results.push({
            id: msg.key.id,
            action: brainData.action ?? brainData.ok ? 'brain_called' : 'brain_failed',
            preview: content.slice(0, 50),
          });
        } catch (err) {
          results.push({
            id: msg.key.id,
            action: `brain_error:${err instanceof Error ? err.message : String(err)}`,
          });
        }
        break; // one per poll to avoid spam
      }
      if (processedCount > 0) break;
    }

    res.status(200).json({
      ok: true,
      processed: processedCount,
      seen_total: processed.size,
      results,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}