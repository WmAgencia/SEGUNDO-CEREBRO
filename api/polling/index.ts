/**
 * Vercel Function: Polls Evolution API for new messages from the owner
 * and calls the /api/brain endpoint to generate intelligent responses.
 *
 * This is the orchestrator that keeps the WhatsApp ↔ Second Brain loop running
 * even when the Evolution webhook doesn't fire reliably.
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
  pushName?: string;
  messageType?: string;
  message?: { conversation?: string; extendedTextMessage?: { text?: string } };
  messageTimestamp?: number;
}

async function evoRequest<T>(method: string, endpoint: string, body?: Record<string, unknown>): Promise<T> {
  const url = `${EVOLUTION_API_URL}${endpoint}`;
  const res = await fetch(url, {
    method,
    headers: {
      apikey: EVOLUTION_API_KEY,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Evolution API ${res.status}: ${text.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

declare global {
  // eslint-disable-next-line no-var
  var __polledMessages: Map<string, number> | undefined;
}

const getSeen = (): Map<string, number> => {
  if (!globalThis.__polledMessages) {
    globalThis.__polledMessages = new Map<string, number>();
  }
  return globalThis.__polledMessages;
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  try {
    const seen = getSeen();
    const now = Date.now();

    // Clean old entries
    for (const [id, ts] of [...seen.entries()]) {
      if (now - ts > 24 * 60 * 60 * 1000) seen.delete(id);
    }

    let processedCount = 0;
    const results: Array<{ id: string; jid: string; action: string; preview?: string }> = [];
    let totalScanned = 0;

    // 1. Check direct chat with owner
    const directJid = `${OWNER_PHONE}@s.whatsapp.net`;
    const directResult = await evoRequest<{ messages: { records: ChatMessage[]; total: number } }>(
      'POST',
      `/chat/findMessages/${EVOLUTION_INSTANCE}`,
      { where: { key: { remoteJid: directJid } }, limit: 10 }
    );

    const directMessages = directResult.messages?.records ?? [];
    totalScanned += directMessages.length;

    for (const msg of directMessages) {
      if (msg.key.fromMe) continue;
      if (!msg.key.id) continue;
      if (seen.has(msg.key.id)) continue;

      const content = msg.message?.conversation ?? msg.message?.extendedTextMessage?.text;
      if (!content || !content.trim()) {
        seen.set(msg.key.id, now);
        continue;
      }

      seen.set(msg.key.id, now);
      processedCount++;

      // Call /api/brain to generate response
      try {
        const brainRes = await fetch(`${SELF_URL}/api/brain`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message: content,
            from: OWNER_PHONE,
            pushName: msg.pushName,
          }),
          signal: AbortSignal.timeout(60_000),
        });

        const brainData = await brainRes.json();
        results.push({
          id: msg.key.id,
          jid: directJid,
          action: brainData.action ?? 'brain_called',
          preview: content.slice(0, 50),
        });
      } catch (err) {
        results.push({
          id: msg.key.id,
          jid: directJid,
          action: `brain_error:${err instanceof Error ? err.message : String(err)}`,
        });
      }
      break;
    }

    // 2. If no direct message, check groups where owner participates
    if (processedCount === 0) {
      const allGroups = await evoRequest<Array<{ id: string; name?: string }>>(
        'GET',
        `/group/findGroups/${EVOLUTION_INSTANCE}?getParticipants=true`
      ).catch(() => []);

      for (const group of allGroups.slice(0, 10)) {
        if (!group.id.endsWith('@g.us')) continue;

        const groupResult = await evoRequest<{ messages: { records: ChatMessage[] } }>(
          'POST',
          `/chat/findMessages/${EVOLUTION_INSTANCE}`,
          { where: { key: { remoteJid: group.id } }, limit: 10 }
        );

        const groupMessages = groupResult.messages?.records ?? [];
        totalScanned += groupMessages.length;

        for (const msg of groupMessages) {
          if (msg.key.fromMe) continue;
          if (!msg.key.id) continue;
          if (seen.has(msg.key.id)) continue;

          const participant = msg.key.participant?.replace(/\D/g, '') ?? '';
          if (participant !== OWNER_PHONE) continue;

          const content = msg.message?.conversation ?? msg.message?.extendedTextMessage?.text;
          if (!content || !content.trim()) {
            seen.set(msg.key.id, now);
            continue;
          }

          seen.set(msg.key.id, now);
          processedCount++;

          try {
            const brainRes = await fetch(`${SELF_URL}/api/brain`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                message: content,
                from: OWNER_PHONE,
                pushName: msg.pushName,
                isGroup: true,
                groupName: group.name,
              }),
              signal: AbortSignal.timeout(60_000),
            });

            const brainData = await brainRes.json();
            results.push({
              id: msg.key.id,
              jid: group.id,
              action: brainData.action ?? 'brain_called',
              preview: content.slice(0, 50),
            });
          } catch (err) {
            results.push({
              id: msg.key.id,
              jid: group.id,
              action: `brain_error:${err instanceof Error ? err.message : String(err)}`,
            });
          }
          break;
        }
        if (processedCount > 0) break;
      }
    }

    res.status(200).json({
      ok: true,
      processed: processedCount,
      seen_total: seen.size,
      scanned: totalScanned,
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