import { DatabaseSync } from "node:sqlite";

export interface WhatsAppInstanceRecord {
  name: string;
  connected: boolean;
  aiEnabled: boolean;
  assignedAgent: string | null;
  phone: string | null;
  updatedAt: string;
}

interface RawInstance {
  name: string;
  connected: number;
  ai_enabled: number;
  assigned_agent: string | null;
  phone: string | null;
  updated_at: string;
}

function toInstance(r: RawInstance): WhatsAppInstanceRecord {
  return {
    name: r.name,
    connected: r.connected === 1,
    aiEnabled: r.ai_enabled === 1,
    assignedAgent: r.assigned_agent,
    phone: r.phone,
    updatedAt: r.updated_at,
  };
}

/** Get local state for an instance. Creates default row (connected=false, ai_enabled=false) if absent. */
export function getInstance(db: DatabaseSync, name: string): WhatsAppInstanceRecord {
  db.prepare("INSERT OR IGNORE INTO whatsapp_instances (name) VALUES (?)").run(name);
  const row = db.prepare("SELECT * FROM whatsapp_instances WHERE name=?").get(name) as unknown as RawInstance;
  return toInstance(row);
}

export function listInstances(db: DatabaseSync): WhatsAppInstanceRecord[] {
  const rows = db.prepare("SELECT * FROM whatsapp_instances ORDER BY name").all() as unknown as RawInstance[];
  return rows.map(toInstance);
}

/** Toggle AI for an instance. Does NOT change connection state — they are independent. */
export function setAiEnabled(db: DatabaseSync, name: string, enabled: boolean, assignedAgent?: string): WhatsAppInstanceRecord {
  db.prepare(
    `INSERT INTO whatsapp_instances (name, ai_enabled, assigned_agent) VALUES (?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET
       ai_enabled=excluded.ai_enabled,
       assigned_agent=COALESCE(excluded.assigned_agent, whatsapp_instances.assigned_agent),
       updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
  ).run(name, enabled ? 1 : 0, assignedAgent ?? null);
  db.prepare(
    "INSERT INTO events (event_type, subject, payload) VALUES ('whatsapp_ai_toggled', ?, ?)",
  ).run(name, JSON.stringify({ aiEnabled: enabled }));
  return getInstance(db, name);
}

/** Mark instance connected/disconnected locally (mirrors Evolution state after connect/logout events). */
export function setConnected(db: DatabaseSync, name: string, connected: boolean, phone?: string): WhatsAppInstanceRecord {
  db.prepare(
    `INSERT INTO whatsapp_instances (name, connected, phone) VALUES (?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET
       connected=excluded.connected,
       phone=COALESCE(excluded.phone, whatsapp_instances.phone),
       updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
  ).run(name, connected ? 1 : 0, phone ?? null);
  return getInstance(db, name);
}

/** Vincula uma instância a um agente (um WhatsApp por atendente). */
export function assignAgentToInstance(db: DatabaseSync, name: string, agentId: string): WhatsAppInstanceRecord {
  const previous = db.prepare("SELECT assigned_agent FROM whatsapp_instances WHERE name=?").get(name) as { assigned_agent: string | null } | undefined;
  db.prepare(
    `INSERT INTO whatsapp_instances (name, assigned_agent) VALUES (?, ?)
     ON CONFLICT(name) DO UPDATE SET assigned_agent=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
  ).run(name, agentId, agentId);
  // garante que nenhum outro agente use a MESMA instância (um WhatsApp = um atendente)
  db.prepare("UPDATE whatsapp_instances SET assigned_agent=NULL WHERE assigned_agent=? AND name<>?").run(agentId, name);
  db.prepare(
    "INSERT INTO events (event_type, subject, payload) VALUES ('whatsapp_instance_assigned', ?, ?)",
  ).run(name, JSON.stringify({ agentId, previous: previous?.assigned_agent ?? null }));
  return getInstance(db, name);
}

/** Instância vinculada a um agente (null se ainda não tem). */
export function instanceForAgent(db: DatabaseSync, agentId: string): WhatsAppInstanceRecord | null {
  const row = db.prepare("SELECT * FROM whatsapp_instances WHERE assigned_agent=? ORDER BY name LIMIT 1").get(agentId) as unknown as RawInstance | undefined;
  return row ? toInstance(row) : null;
}

/** Camada Evolution: qual nome usar para um atendente — reusa a instância dele ou cria uma nova dedicada. */
export function planInstanceForAgent(db: DatabaseSync, agentId: string, existingNames: string[]): string {
  const inst = instanceForAgent(db, agentId);
  if (inst) return inst.name;
  // cria a próxima instância livre (ex.: whatsapp-01, whatsapp-02...)
  let n = 1;
  while (existingNames.includes(`whatsapp-${n}`)) n++;
  const name = `whatsapp-${n}`;
  assignAgentToInstance(db, name, agentId);
  return name;
}


export interface InboundPolicyResult {
  action: "PROCESS" | "SKIP_AI_DISABLED" | "SKIP_NOT_CONNECTED";
  reason: string;
}

/**
 * Policy gate for inbound messages.
 * Sem configuração explícita da instância no banco → PROCESS (compatibilidade
 * com deployments existentes; opt-out explícito via painel).
 * connected=false → SKIP_NOT_CONNECTED
 * connected=true + ai_enabled=false → mensagem persistida, agente NÃO responde
 * connected=true + ai_enabled=true → PROCESS
 */
export function inboundPolicy(db: DatabaseSync, instanceName: string): InboundPolicyResult {
  const row = db.prepare("SELECT * FROM whatsapp_instances WHERE name=?").get(instanceName) as unknown as RawInstance | undefined;
  if (!row) return { action: "PROCESS", reason: "no explicit instance configuration — default allow" };
  if (row.connected !== 1) return { action: "SKIP_NOT_CONNECTED", reason: "instance not marked connected" };
  if (row.ai_enabled !== 1) return { action: "SKIP_AI_DISABLED", reason: "ai disabled for this instance" };
  return { action: "PROCESS", reason: "connected and ai enabled" };
}
