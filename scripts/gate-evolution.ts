import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
  if (m?.[1] && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}

const BASE = process.env.EVOLUTION_API_URL;
const KEY = process.env.EVOLUTION_API_KEY;
if (!BASE || !KEY) {
  console.log("EVOLUTION: BLOCKED — EVOLUTION_API_URL/KEY ausentes");
  process.exit(0);
}
const H = { apikey: KEY, "Content-Type": "application/json" };

// 1) fetchInstances (read-only)
try {
  const r = await fetch(`${BASE}/instance/fetchInstances`, { headers: H, signal: AbortSignal.timeout(30000) });
  const data = await r.json();
  const list = Array.isArray(data) ? data : [];
  console.log(`GATE F.1 fetchInstances: HTTP ${r.status} — ${list.length} instância(s)`);
  for (const i of list) {
    console.log(`  - ${i.instanceName ?? i.name}: ${i.connectionStatus ?? i.state ?? "?"}`);
  }
} catch (e) {
  console.log(`GATE F.1 fetchInstances: PROVIDER_FAILURE ${e instanceof Error ? e.message : e}`);
  process.exit(0);
}

// 2) connect na instância configurada → QR REAL se desconectada
const inst = process.env.EVOLUTION_INSTANCE ?? "SECOM";
try {
  const r = await fetch(`${BASE}/instance/connect/${inst}`, { headers: H, signal: AbortSignal.timeout(60000) });
  const data = await r.json() as Record<string, unknown>;
  if (!r.ok) {
    console.log(`GATE F.2 connect/${inst}: HTTP ${r.status} ${JSON.stringify(data).slice(0, 200)}`);
    process.exit(0);
  }
  const qrcode = (data.qrcode as Record<string, unknown> | undefined) ?? {};
  const qrString = typeof qrcode.pairingCode === "string" ? "pairingCode" : typeof qrcode.code === "string" ? "qr-code(base64)" : null;
  if (qrString) {
    const raw = String(qrcode.pairingCode ?? qrcode.code);
    console.log(`GATE F.2 connect/${inst}: QR REAL RECEBIDO (${qrString}, ${raw.length} chars, prefixo=${raw.slice(0, 12)}…)`);
    console.log(">>> REALITY GATE WHATSAPP QR: PASS REAL");
  } else {
    console.log(`GATE F.2 connect/${inst}: sem QR — state=${JSON.stringify(data.instance?.state ?? data)} (provavelmente já conectada)`);
    console.log(">>> REALITY GATE WHATSAPP CONNECT: PASS REAL (estado consultado na API)");
  }
} catch (e) {
  console.log(`GATE F.2 connect/${inst}: PROVIDER_FAILURE ${e instanceof Error ? e.message : e}`);
}
