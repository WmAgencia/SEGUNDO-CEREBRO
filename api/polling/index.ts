/**
 * Edge polling endpoint with self-sustaining chain.
 *
 * Uses Vercel Edge Functions (faster startup, no cold start).
 * Each call schedules a recursive call within the same function invocation
 * using setTimeout in a Promise.race pattern that respects the 25s edge timeout.
 *
 * For continuous 20s polling, set:
 *   POLLING_CHAIN=true (env var)
 *
 * When POLLING_CHAIN=true, this endpoint will:
 * 1. Process new messages
 * 2. Wait 20s
 * 3. Make a recursive HTTP call to itself
 * 4. Repeat until chain depth limit reached (default 3) or interrupted
 *
 * This creates a "chain" of calls within Vercel's limits.
 *
 * For 24/7 operation, use external cron (cron-job.org) every 1-5 minutes.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';

export const config = {
  maxDuration: 60,
};

const EVOLUTION_API_URL = process.env.EVOLUTION_API_URL ?? '';
const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY ?? '';
const EVOLUTION_INSTANCE = process.env.EVOLUTION_INSTANCE ?? 'SECOM';
const OWNER_PHONE = (process.env.OWNER_WHATSAPP ?? '5515981817336').replace(/\D/g, '');
const SELF_URL = process.env.SELF_URL ?? 'https://segundo-cerebro-jet.vercel.app';
const POLLING_INTERVAL_MS = Number(process.env.POLLING_INTERVAL_MS ?? '20000');
const POLLING_CHAIN = process.env.POLLING_CHAIN === 'true';
const CHAIN_DEPTH = Number(process.env.CHAIN_DEPTH ?? '3');
const CHAIN_MAX_MS = Number(process.env.CHAIN_MAX_MS ?? '45000'); // 45s - under Vercel 60s limit

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
  if (process.env.POLLING_RESET === 'true') {
    globalThis.__polledMessages.clear();
  }
  return globalThis.__polledMessages;
};

async function processMessages(): Promise<{
  processed: number;
  scanned: number;
  results: Array<{ id: string; jid: string; action: string; preview?: string }>;
}> {
  const seen = getSeen();
  const now = Date.now();

  // Clean old entries
  for (const [id, ts] of [...seen.entries()]) {
    if (now - ts > 24 * 60 * 60 * 1000) seen.delete(id);
  }

  let processedCount = 0;
  const results: Array<{ id: string; jid: string; action: string; preview?: string }> = [];
  let totalScanned = 0;

  // 1. Direct chats (multiple JID formats)
  const ownerJids = [
    `${OWNER_PHONE}@s.whatsapp.net`,
    `${OWNER_PHONE}@lid`,
    '189494074573054@lid',
  ];

  for (const directJid of ownerJids) {
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
    if (processedCount > 0) break;
  }

  // 2. Groups
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

  return { processed: processedCount, scanned: totalScanned, results };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  // Get chain depth from query or header (incremented per recursive call)
  const depth = Number(req.query.depth ?? req.headers['x-chain-depth'] ?? '0');
  const startTime = Date.now();

  try {
    // Process messages
    const result = await processMessages();

    // Decide whether to chain
    const shouldChain = POLLING_CHAIN && depth < CHAIN_DEPTH;
    const elapsed = Date.now() - startTime;
    const remainingTime = CHAIN_MAX_MS - elapsed;

    if (shouldChain && remainingTime > POLLING_INTERVAL_MS + 5000) {
      // Wait POLLING_INTERVAL_MS, then call ourselves recursively
      await new Promise<void>((resolve) => setTimeout(resolve, POLLING_INTERVAL_MS));

      // Recursive call (fire-and-forget pattern via await)
      try {
        const chainRes = await fetch(
            `${SELF_URL}/api/polling?depth=${depth + 1}`,
            {
              method: 'GET',
              headers: {
                'x-chain-depth': String(depth + 1),
              },
              signal: AbortSignal.timeout(Math.max(remainingTime - POLLING_INTERVAL_MS, 10_000)),
            }
          );
        // Could log chain result but not critical
        void chainRes;
      } catch {
        // Chain failed, that's OK
      }
    }

    res.status(200).json({
      ok: true,
      ...result,
      chain: {
        enabled: POLLING_CHAIN,
        current_depth: depth,
        max_depth: CHAIN_DEPTH,
        elapsed_ms: elapsed,
      },
      interval_sec: POLLING_INTERVAL_MS / 1000,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}