import type { VercelRequest, VercelResponse } from '@vercel/node';

const SELF_URL = process.env.SELF_URL ?? 'https://segundo-cerebro-jet.vercel.app';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Ping our own endpoints to keep them warm
  try {
    const results = await Promise.allSettled([
      fetch(`${SELF_URL}/api/health`).then((r) => r.json()).catch((e) => ({ error: String(e) })),
      fetch(`${SELF_URL}/api/evolution/status`).then((r) => r.json()).catch((e) => ({ error: String(e) })),
    ]);

    res.status(200).json({
      status: 'alive',
      timestamp: new Date().toISOString(),
      checks: results.map((r, i) => ({
        endpoint: ['/api/health', '/api/evolution/status'][i],
        ok: r.status === 'fulfilled',
        data: r.status === 'fulfilled' ? r.value : null,
      })),
    });
  } catch (err) {
    res.status(200).json({
      status: 'alive',
      timestamp: new Date().toISOString(),
      note: 'self-check failed',
    });
  }
}