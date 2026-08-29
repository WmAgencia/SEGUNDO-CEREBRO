import type { VercelRequest, VercelResponse } from '@vercel/node';

const EVOLUTION_API_URL = process.env.EVOLUTION_API_URL ?? '';
const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY ?? '';
const EVOLUTION_INSTANCE = process.env.EVOLUTION_INSTANCE ?? 'SECOM';
const OWNER_PHONE = (process.env.OWNER_WHATSAPP ?? '5515981817336').replace(/\D/g, '');

export default function handler(req: VercelRequest, res: VercelResponse) {
  res.status(200).json({
    status: 'ok',
    version: 'vercel-function-1.0',
    timestamp: new Date().toISOString(),
    evolution: EVOLUTION_API_URL ? 'configured' : 'unconfigured',
    instance: EVOLUTION_INSTANCE,
    ownerPhone: OWNER_PHONE,
  });
}