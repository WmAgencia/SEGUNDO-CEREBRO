import type { VercelRequest, VercelResponse } from '@vercel/node';

const EVOLUTION_API_URL = process.env.EVOLUTION_API_URL ?? '';
const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY ?? '';
const EVOLUTION_INSTANCE = process.env.EVOLUTION_INSTANCE ?? 'SECOM';
const OWNER_PHONE = (process.env.OWNER_WHATSAPP ?? '5515981817336').replace(/\D/g, '');

interface EvolutionMessage {
  key: { remoteJid: string; fromMe: boolean; id: string };
  pushName?: string;
  message?: { conversation?: string; extendedTextMessage?: { text?: string } };
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
    '💡 O backend completo está sendo finalizado.',
    `Acesse o chat web para consultas completas: https://segundo-cerebro-jet.vercel.app`,
    '',
    '_Resposta automática via Vercel Function_',
  ].join('\n');
  return reply;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method not allowed' });
    return;
  }

  try {
    const body = (typeof req.body === 'string' ? JSON.parse(req.body) : req.body) as {
      event: string;
      instance: string;
      data?: EvolutionMessage;
    };

    if (!body?.event || !body?.instance) {
      res.status(200).json({ ok: false, error: 'missing event or instance' });
      return;
    }

    const event = body.event.toUpperCase().replace(/[.\-\s]+/g, '_');
    if (event !== 'MESSAGES_UPSERT') {
      res.status(200).json({ ok: true, action: `ignored:${event}` });
      return;
    }

    const key = body.data?.key;
    if (!key || key.fromMe || !key.id) {
      res.status(200).json({ ok: false, action: 'skipped:from_me_or_no_id' });
      return;
    }

    const msgContent =
      body.data?.message?.conversation ??
      body.data?.message?.extendedTextMessage?.text ??
      '';
    if (!msgContent.trim()) {
      res.status(200).json({ ok: false, action: 'no_text_content' });
      return;
    }

    const remoteJid = key.remoteJid ?? '';
    const phone = remoteJid.split('@')[0] ?? remoteJid;
    const pushName = body.data?.pushName ?? phone;

    if (phone.replace(/\D/g, '') !== OWNER_PHONE) {
      res.status(200).json({ ok: true, action: 'skipped:not_owner', recipient: phone });
      return;
    }

    const reply = await processOwnerMessage(pushName, msgContent.trim());
    const sent = await sendMessage(phone, reply);

    res.status(200).json({
      ok: true,
      action: 'owner_reply_sent',
      messageId: sent.messageId,
      recipient: phone,
    });
  } catch (err) {
    res.status(200).json({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}