import { redactSecrets } from "../exec/redact.ts";

const BASE_URL = () => process.env.EVOLUTION_API_URL ?? "";
const API_KEY = () => process.env.EVOLUTION_API_KEY ?? "";
const INSTANCE = () => process.env.EVOLUTION_INSTANCE ?? "SECOM";
const OWNER_PHONE = () => (process.env.OWNER_WHATSAPP ?? "5515981817336").replace(/\D/g, "");

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
  return sendMessageInternal(toNumber, text, false);
}

/**
 * Envia mensagem mesmo para o owner (para agentes pessoais).
 * ATENÇÃO: Use com cuidado para evitar loops de mensagens.
 */
export async function sendMessageToOwner(text: string): Promise<{ messageId: string; status: string }> {
  return sendMessageInternal(OWNER_PHONE, text, true);
}

async function sendMessageInternal(toNumber: string, text: string, allowOwner: boolean): Promise<{ messageId: string; status: string }> {
  const normalized = toNumber.replace(/\D/g, "");
  const owner = OWNER_PHONE();
  if (!allowOwner && (normalized === owner || normalized === `55${owner}`)) {
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

export interface ConnectResult {
  state: string;
  qrBase64: string | null;
  pairingCode: string | null;
  error: string | null;
}

/**
 * FASE 3.7 — conexão real via Evolution: consulta a instância; se não existir,
 * cria; pede o QR code (base64) para pareamento. Nunca inventa estado: se a
 * Evolution API não estiver configurada, retorna estado honesto.
 */
export async function connectInstance(): Promise<ConnectResult> {
  if (!API_KEY() || !BASE_URL()) {
    return { state: "unconfigured", qrBase64: null, pairingCode: null, error: "EVOLUTION_API_URL/EVOLUTION_API_KEY ausentes" };
  }
  const name = INSTANCE();
  try {
    const instances = await evoRequest<Array<{ name: string; connectionStatus: string }>>("GET", "/instance/fetchInstances");
    const existing = instances.find((i) => i.name === name);
    if (existing?.connectionStatus === "open") {
      return { state: "open", qrBase64: null, pairingCode: null, error: null };
    }
    if (!existing) {
      await evoRequest("POST", "/instance/create", {
        instanceName: name,
        qrcode: true,
        integration: "WHATSAPP-BAILEYS",
      });
    }
    const connect = await evoRequest<{ base64?: string; code?: string; pairingCode?: string }>("GET", `/instance/connect/${name}`);
    return {
      state: "qrcode",
      qrBase64: connect.base64 ?? null,
      pairingCode: connect.pairingCode ?? connect.code ?? null,
      error: null,
    };
  } catch (err) {
    return { state: "error", qrBase64: null, pairingCode: null, error: err instanceof Error ? err.message.slice(0, 300) : String(err) };
  }
}
