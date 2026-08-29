import type { VercelRequest, VercelResponse } from '@vercel/node';

const EVOLUTION_API_URL = process.env.EVOLUTION_API_URL ?? '';
const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY ?? '';
const EVOLUTION_INSTANCE = process.env.EVOLUTION_INSTANCE ?? 'SECOM';
const OWNER_PHONE = (process.env.OWNER_WHATSAPP ?? '5515981817336').replace(/\D/g, '');

interface ChatMessage {
  key: { remoteJid: string; fromMe: boolean; id: string };
  pushName?: string;
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

interface MemoryEntry {
  id: string;
  processedAt: number;
}

declare global {
  // eslint-disable-next-line no-var
  var __processedMemory: Set<string> | undefined;
}

const getProcessed = (): Set<string> => {
  if (!globalThis.__processedMemory) {
    globalThis.__processedMemory = new Set<string>();
  }
  return globalThis.__processedMemory;
};

async function processOwnerMessage(name: string, content: string): Promise<string> {
  const reply = [
    '🧠 *Second Brain*',
    '',
    `Olá ${name}! Recebi sua mensagem: "${content}"`,
    '',
    '💡 Versão polling ativo.',
    `Chat web: https://segundo-cerebro-jet.vercel.app`,
  ].join('\n');
  return reply;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  try {
    // Polling endpoint: /api/polling
    // Checks Evolution API for new messages and processes them
    const processed = getProcessed();

    // Clean old entries (older than 1 hour)
    const now = Date.now();
    for (const id of [...processed]) {
      // We don't track timestamps in the Set; rely on message IDs being unique enough
      // Limit size to prevent memory bloat
      if (processed.size > 1000) processed.delete(id);
    }

    // Fetch recent messages from owner
    const chats = await evoRequest<Array<{ id: string; name?: string }>>(
      'GET',
      `/chat/findChats/${EVOLUTION_INSTANCE}`
    );

    let processedCount = 0;
    const results: Array<{ id: string; action: string }> = [];

    for (const chat of chats.slice(0, 20)) {
      const phone = chat.id.split('@')[0] ?? '';
      if (phone.replace(/\D/g, '') !== OWNER_PHONE) continue;

      const messages = await evoRequest<{ messages: ChatMessage[] }>(
        'GET',
        `/chat/findMessages/${EVOLUTION_INSTANCE}?where=${encodeURIComponent(JSON.stringify({ key: { remoteJid: chat.id } }))}&limit=5`
      );

      for (const msg of messages.messages ?? []) {
        if (msg.key.fromMe) continue;
        if (!msg.key.id) continue;
        if (processed.has(msg.key.id)) continue;

        const content = msg.message?.conversation ?? msg.message?.extendedTextMessage?.text;
        if (!content || !content.trim()) {
          processed.add(msg.key.id);
          continue;
        }

        processed.add(msg.key.id);
        processedCount++;

        const reply = await processOwnerMessage(msg.pushName ?? phone, content.trim());
        const sent = await sendMessage(phone, reply);
        results.push({ id: msg.key.id, action: `replied:${sent.messageId}` });

        // Only process one new message per poll to avoid spam
        break;
      }

      if (processedCount > 0) break;
    }

    res.status(200).json({
      ok: true,
      processed: processedCount,
      total_chats: chats.length,
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