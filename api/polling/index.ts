import type { VercelRequest, VercelResponse } from '@vercel/node';

const EVOLUTION_API_URL = process.env.EVOLUTION_API_URL ?? '';
const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY ?? '';
const EVOLUTION_INSTANCE = process.env.EVOLUTION_INSTANCE ?? 'SECOM';
const OWNER_PHONE = (process.env.OWNER_WHATSAPP ?? '5515981817336').replace(/\D/g, '');

interface ChatMessage {
  id: string;
  key: { remoteJid: string; fromMe: boolean; id: string };
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

async function sendMessage(toNumber: string, text: string): Promise<{ messageId: string }> {
  const normalized = toNumber.replace(/\D/g, '');
  const result = await evoRequest<{ key: { id: string } }>('POST', `/message/sendText/${EVOLUTION_INSTANCE}`, {
    number: normalized.startsWith('55') ? normalized : `55${normalized}`,
    text,
  });
  return { messageId: result.key?.id ?? 'unknown' };
}

async function processOwnerMessage(name: string, content: string): Promise<string> {
  const reply = [
    '🧠 *Second Brain*',
    '',
    `Olá ${name}! Recebi sua mensagem: "${content}"`,
    '',
    '💡 Via polling ativo (30s).',
    `Chat web: https://segundo-cerebro-jet.vercel.app`,
  ].join('\n');
  return reply;
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

    // Clean old entries (older than 24 hours)
    for (const [id, ts] of [...seen.entries()]) {
      if (now - ts > 24 * 60 * 60 * 1000) seen.delete(id);
    }

    // Fetch recent messages from the owner chat
    const result = await evoRequest<{ messages: { records: ChatMessage[]; total: number } }>(
      'POST',
      `/chat/findMessages/${EVOLUTION_INSTANCE}`,
      {
        where: { key: { remoteJid: `${OWNER_PHONE}@s.whatsapp.net` } },
        limit: 10,
      }
    );

    const messages = result.messages?.records ?? [];
    let processedCount = 0;
    const results: Array<{ id: string; action: string; preview?: string }> = [];

    // Process from oldest to newest, skipping already-seen
    for (const msg of messages.reverse()) {
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
        const reply = await processOwnerMessage(msg.pushName ?? OWNER_PHONE, content.trim());
        const sent = await sendMessage(OWNER_PHONE, reply);
        results.push({ id: msg.key.id, action: `replied:${sent.messageId}`, preview: content.slice(0, 50) });
      } catch (err) {
        results.push({ id: msg.key.id, action: `error:${err instanceof Error ? err.message : String(err)}` });
      }
    }

    res.status(200).json({
      ok: true,
      processed: processedCount,
      seen_total: seen.size,
      scanned: messages.length,
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