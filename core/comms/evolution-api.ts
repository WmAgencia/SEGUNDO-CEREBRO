import { redactSecrets } from "../exec/redact.ts";

const BASE_URL = () => process.env.EVOLUTION_API_URL ?? "";
const API_KEY = () => process.env.EVOLUTION_API_KEY ?? "";
const INSTANCE = () => process.env.EVOLUTION_INSTANCE ?? "SECOM";
const OWNER_PHONE = "15981817336";

export interface EvolutionMessage {
  key: { remoteJid: string; fromMe: boolean; id: string };
  pushName?: string;
  status?: string;
  message?: { conversation?: string; extendedTextMessage?: { text?: string } };
  messageType?: string;
  messageTimestamp?: number;
}

export interface ContactInfo {
  id: string;
  name: string;
  phone: string;
}

async function evoRequest<T>(
  method: "GET" | "POST" | "DELETE",
  endpoint: string,
  body?: Record<string, unknown>,
): Promise<T> {
  const url = `${BASE_URL()}${endpoint}`;
  const res = await fetch(url, {
    method,
    headers: {
      apikey: API_KEY(),
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Evolution API ${res.status}: ${redactSecrets(text.slice(0, 200))}`);
  }
  return (await res.json()) as T;
}

export async function sendMessage(toNumber: string, text: string): Promise<{ messageId: string; status: string }> {
  const normalized = toNumber.replace(/\D/g, "");
  if (normalized === OWNER_PHONE || normalized === `55${OWNER_PHONE}`) {
    throw new Error("OWNER_PRIVATE_CHANNEL_DISABLED");
  }
  const result = await evoRequest<{
    key: { id: string };
    status?: string;
  }>("POST", `/message/sendText/${INSTANCE()}`, {
    number: normalized.startsWith("55") ? normalized : `55${normalized}`,
    text: redactSecrets(text),
  });
  return {
    messageId: result.key?.id ?? "unknown",
    status: result.status ?? "SENT",
  };
}

export async function getConnectionState(): Promise<string> {
  try {
    const instances = await evoRequest<Array<{ name: string; connectionStatus: string }>>(
      "GET",
      "/instance/fetchInstances",
    );
    const inst = instances.find((i) => i.name === INSTANCE());
    return inst?.connectionStatus ?? "UNKNOWN";
  } catch {
    return "UNKNOWN";
  }
}

export async function isAvailable(): Promise<boolean> {
  if (!API_KEY() || !BASE_URL()) return false;
  const state = await getConnectionState();
  return state === "open";
}
