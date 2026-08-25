import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";

export interface LeadRecord {
  id: string;
  companyName: string;
  contactName: string | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  instagram: string | null;
  linkedin: string | null;
  tiktok: string | null;
  source: string;
  sourceUrl: string | null;
  category: string | null;
  city: string | null;
  state: string | null;
  country: string;
  qualificationScore: number;
  signals: string[];
  evidence: string[];
  status: LeadStatus;
  lastContact: string | null;
  assignedAgent: string | null;
  createdAt: string;
  updatedAt: string;
}

export type LeadStatus =
  | "NEW" | "QUALIFIED" | "APPROACH_QUEUED" | "CONTACTED"
  | "IN_CONVERSATION" | "WON" | "LOST" | "BLOCKED_SOURCE";

interface RawLead {
  id: string;
  company_name: string;
  contact_name: string | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  instagram: string | null;
  linkedin: string | null;
  tiktok: string | null;
  source: string;
  source_url: string | null;
  category: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  qualification_score: number;
  signals_json: string;
  evidence_json: string;
  status: string;
  last_contact: string | null;
  assigned_agent: string | null;
  created_at: string;
  updated_at: string;
}

function toLead(r: RawLead): LeadRecord {
  const list = (raw: string): string[] => {
    try {
      const p = JSON.parse(raw);
      return Array.isArray(p) ? p.filter((x): x is string => typeof x === "string") : [];
    } catch { return []; }
  };
  return {
    id: r.id,
    companyName: r.company_name,
    contactName: r.contact_name,
    phone: r.phone,
    email: r.email,
    website: r.website,
    instagram: r.instagram,
    linkedin: r.linkedin,
    tiktok: r.tiktok,
    source: r.source,
    sourceUrl: r.source_url,
    category: r.category,
    city: r.city,
    state: r.state,
    country: r.country ?? "BR",
    qualificationScore: r.qualification_score,
    signals: list(r.signals_json),
    evidence: list(r.evidence_json),
    status: r.status as LeadStatus,
    lastContact: r.last_contact,
    assignedAgent: r.assigned_agent,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/**
 * Deterministic qualification scoring for website-selling prospecting.
 * Each signal has a fixed weight; total clamped to 0..100.
 */
const SIGNAL_WEIGHTS: Record<string, number> = {
  "no_website": 30,
  "outdated_website": 20,
  "slow_website": 15,
  "no_cta": 10,
  "no_whatsapp_widget": 10,
  "active_instagram_bad_site": 15,
  "has_phone_contact": 5,
};

export function scoreLeadSignals(signals: string[]): { score: number; breakdown: Array<{ signal: string; points: number }> } {
  let score = 0;
  const breakdown: Array<{ signal: string; points: number }> = [];
  for (const s of signals) {
    const w = SIGNAL_WEIGHTS[s];
    if (w && Number.isFinite(w)) {
      score += w;
      breakdown.push({ signal: s, points: w });
    }
  }
  return { score: Math.max(0, Math.min(100, score)), breakdown };
}

function leadId(companyName: string, source: string): string {
  const slug = companyName.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "lead";
  const hash = createHash("sha256").update(`${source}|${companyName}`).digest("hex").slice(0, 8);
  return `lead.${slug}.${hash}`;
}

export interface SaveLeadInput {
  companyName: string;
  contactName?: string;
  phone?: string;
  email?: string;
  website?: string;
  instagram?: string;
  linkedin?: string;
  tiktok?: string;
  source: string;
  sourceUrl?: string;
  category?: string;
  city?: string;
  state?: string;
  country?: string;
  signals?: string[];
  evidence?: string[];
}

export type SaveLeadResult =
  | { saved: true; lead: LeadRecord; created: boolean }
  | { saved: false; reason: "duplicate"; existing: LeadRecord };

/** Save a lead with provenance. Dedupes by (source, company_name, city) and by phone/website globally. */
export function saveLead(db: DatabaseSync, input: SaveLeadInput): SaveLeadResult {
  if (!input.companyName?.trim()) throw new Error("company_name is required");
  if (!input.source?.trim()) throw new Error("source (provenance) is required");

  // Global dedupe: same phone or same website = same lead regardless of source.
  if (input.phone) {
    const normPhone = input.phone.replace(/\D/g, "");
    if (normPhone) {
      const dup = db.prepare("SELECT * FROM leads WHERE REPLACE(REPLACE(REPLACE(phone,'(',''),')',''),'-','') LIKE ? LIMIT 1")
        .get(`%${normPhone.slice(-10)}%`) as RawLead | undefined;
      if (dup) return { saved: false, reason: "duplicate", existing: toLead(dup) };
    }
  }
  if (input.website) {
    const host = normalizeHost(input.website);
    if (host) {
      const dup = db.prepare("SELECT * FROM leads WHERE website LIKE ? LIMIT 1").get(`%${host}%`) as RawLead | undefined;
      if (dup) return { saved: false, reason: "duplicate", existing: toLead(dup) };
    }
  }

  const id = leadId(input.companyName, input.source);
  const { score } = scoreLeadSignals(input.signals ?? []);
  const status: LeadStatus = score >= 40 ? "QUALIFIED" : "NEW";

  db.prepare(
    `INSERT INTO leads (id, company_name, contact_name, phone, email, website, instagram, linkedin, tiktok,
       source, source_url, category, city, state, country, qualification_score, signals_json, evidence_json, status)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET
       contact_name=excluded.contact_name, phone=excluded.phone, email=excluded.email,
       website=excluded.website, instagram=excluded.instagram, linkedin=excluded.linkedin, tiktok=excluded.tiktok,
       qualification_score=excluded.qualification_score, signals_json=excluded.signals_json,
       evidence_json=excluded.evidence_json, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
  ).run(
    id, input.companyName.trim(), input.contactName ?? null, input.phone ?? null, input.email ?? null,
    input.website ?? null, input.instagram ?? null, input.linkedin ?? null, input.tiktok ?? null,
    input.source, input.sourceUrl ?? null, input.category ?? null, input.city ?? null, input.state ?? null,
    input.country ?? "BR", score, JSON.stringify(input.signals ?? []), JSON.stringify(input.evidence ?? []), status,
  );

  const row = db.prepare("SELECT * FROM leads WHERE id=?").get(id) as unknown as RawLead;
  return { saved: true, lead: toLead(row), created: true };
}

function normalizeHost(url: string): string | null {
  try {
    const u = new URL(url.startsWith("http") ? url : `https://${url}`);
    return u.hostname.replace(/^www\./, "");
  } catch { return null; }
}

export function getLead(db: DatabaseSync, id: string): LeadRecord | null {
  const row = db.prepare("SELECT * FROM leads WHERE id=?").get(id) as RawLead | undefined;
  return row ? toLead(row) : null;
}

export function listLeads(
  db: DatabaseSync,
  filters: { status?: LeadStatus; minScore?: number; limit?: number } = {},
): LeadRecord[] {
  const where: string[] = [];
  const values: Array<string | number> = [];
  if (filters.status) { where.push("status=?"); values.push(filters.status); }
  if (filters.minScore !== undefined) { where.push("qualification_score>=?"); values.push(filters.minScore); }
  const params: Array<string | number> = [...values, filters.limit ?? 50];
  const rows = db.prepare(
    `SELECT * FROM leads ${where.length ? "WHERE " + where.join(" AND ") : ""}
     ORDER BY qualification_score DESC, created_at DESC LIMIT ?`,
  ).all(...params) as unknown as RawLead[];
  return rows.map(toLead);
}

export function updateLeadStatus(db: DatabaseSync, id: string, status: LeadStatus, assignedAgent?: string): LeadRecord | null {
  db.prepare(
    `UPDATE leads SET status=?, assigned_agent=COALESCE(?, assigned_agent),
       last_contact=CASE WHEN ? IN ('CONTACTED','IN_CONVERSATION') THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE last_contact END,
       updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE id=?`,
  ).run(status, assignedAgent ?? null, status, id);
  return getLead(db, id);
}

export function leadStats(db: DatabaseSync): { total: number; qualified: number; newLeads: number; queued: number } {
  const row = db.prepare(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN status='QUALIFIED' THEN 1 ELSE 0 END) AS qualified,
            SUM(CASE WHEN status='NEW' THEN 1 ELSE 0 END) AS new_leads,
            SUM(CASE WHEN status='APPROACH_QUEUED' THEN 1 ELSE 0 END) AS queued
     FROM leads`,
  ).get() as { total: number; qualified: number | null; new_leads: number | null; queued: number | null };
  return {
    total: row.total ?? 0,
    qualified: row.qualified ?? 0,
    newLeads: row.new_leads ?? 0,
    queued: row.queued ?? 0,
  };
}
