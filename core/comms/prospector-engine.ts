import type { ProspectingSource, LeadCandidate } from "../agents/specialized.ts";
import { OverpassSource } from "./sources/overpass-source.ts";
import { saveLead, scoreLeadSignals, listLeads, updateLeadStatus, leadStats } from "./leads.ts";
import type { DatabaseSync } from "node:sqlite";
import { createInitiative } from "../goals/initiatives.ts";
import { planInitiative } from "../goals/initiatives.ts";

/* ══════════════════════════════════════════════════════════
   SOURCE REGISTRY — O Prospector escolhe dinamicamente a fonte.
   Cada fonte: capabilities, status (habilitada/desabilitada), custo,
   rate limit, confiabilidade, provenance.
   ══════════════════════════════════════════════════════════ */

export interface SourceDescriptor {
  id: string;
  name: string;
  capabilities: string[];
  enabled: boolean;
  costPerSearch: number;
  rateLimitPerMin: number;
  reliability: number; // 0-1
  needsCredential: boolean;
  instance: ProspectingSource;
}

function sourceEnabled(id: string, key: string): boolean {
  const v = process.env[key];
  if (v === undefined) return true; // habilitada por padrão (não depende de credencial)
  return v !== "0" && v.toLowerCase() !== "false";
}

/** Registry: fontes disponíveis. Ordem = prioridade de tentativa. */
export function buildSourceRegistry(): SourceDescriptor[] {
  const sources: SourceDescriptor[] = [
    {
      id: "openstreetmap_overpass",
      name: "OpenStreetMap (Overpass)",
      capabilities: ["name", "category", "address", "phone", "website", "instagram"],
      enabled: sourceEnabled("openstreetmap_overpass", "OVERPASS_ENABLED"),
      costPerSearch: 0,
      rateLimitPerMin: 10,
      reliability: 0.7,
      needsCredential: false,
      instance: new OverpassSource(),
    },
  ];
  return sources;
}

/* ══════════════════════════════════════════════════════════
   DETERMINISTIC SCORE — reaproveita peso dos sinais + fit/contato.
   ══════════════════════════════════════════════════════════ */

export interface ScoredLead extends LeadCandidate {
  digitalPresence: "none" | "low" | "medium" | "high";
  scoreExplanation: string;
}

export function scoreCandidate(c: LeadCandidate): ScoredLead {
  const base = scoreLeadSignals(c.signals);
  let score = base.score;

  // fit comercial (nicho mapeado) e contatabilidade
  const hasPhone = c.evidence?.includes("phone_public") || false;
  const hasInsta = c.evidence?.includes("instagram_ativo") || false;
  const hasSite = c.evidence?.includes("website_public") || false;

  const signals = [...c.signals];
  if (hasPhone) signals.push("has_phone_contact");
  const withContact = scoreLeadSignals(signals);

  let explanation: string[] = [`sinais base ${base.score}pt`];
  if (base.breakdown.length) explanation.push(base.breakdown.map((b) => `${b.signal}=+${b.points}`).join(" "));
  if (hasInsta && !hasSite) { score += 5; explanation.push("instagram ativo sem site +5"); }
  if (hasPhone) { score += 10; explanation.push("telefone público +10"); }

  // presença digital
  let digitalPresence: ScoredLead["digitalPresence"] = "none";
  if (hasSite) digitalPresence = "medium";
  if (hasInsta) digitalPresence = digitalPresence === "medium" ? "high" : "low";
  if (hasSite && hasInsta) digitalPresence = "high";
  if (!hasSite && !hasInsta) digitalPresence = "none";

  score = Math.max(0, Math.min(100, score));
  return { ...c, digitalPresence, score, scoreExplanation: explanation.join(";") };
}

/* ══════════════════════════════════════════════════════════
   PROSPECTOR ENGINE — orquestra DISCOVER → ENRICH → SCORE →
   DEDUP → SAVE → QUALIFY → HANDOFF (via scheduler existente).
   ══════════════════════════════════════════════════════════ */

export interface ProspectRunResult {
  sourcesUsed: string[];
  leadsFound: number;
  leadsSaved: number;
  duplicates: number;
  qualifiedForApproach: string[];
  blockedSources: Array<{ source: string; reason: string }>;
  persistedGoal: string | null;
  ledger: Array<{ source: string; count: number }>;
}

export async function runProspectorSearch(
  db: DatabaseSync,
  query: string,
  opts: { maxLeads?: number; projectId?: string; goalName?: string } = {},
): Promise<ProspectRunResult> {
  const registry = buildSourceRegistry().filter((s) => s.enabled);
  const result: ProspectRunResult = {
    sourcesUsed: [],
    leadsFound: 0,
    leadsSaved: 0,
    duplicates: 0,
    qualifiedForApproach: [],
    blockedSources: [],
    persistedGoal: null,
    ledger: [],
  };

  // (opcional) cria iniciativa que registra o pipeline
  if (opts.goalName) {
    try {
      const init = createInitiative(db, { title: opts.goalName, description: `Prospecção: ${query}`, status: "PROPOSED", project: opts.projectId ?? undefined });
      planInitiative(db, init.id, [
        `Coletar leads: ${query}`,
        "Enriquecer e pontuar leads",
        "Deduplicar e qualificar",
        "Fila comercial",
      ]);
      result.persistedGoal = init.id;
    } catch { /* fallback: silently skip */ }
  }

  for (const src of registry) {
    try {
      const candidates = await src.instance.search(query);
      result.sourcesUsed.push(src.id);
      result.ledger.push({ source: src.id, count: candidates.length });
      result.leadsFound += candidates.length;
      for (const c of candidates.slice(0, opts.maxLeads ?? 100)) {
        const scored = scoreCandidate(c);
        const saved = saveLead(db, {
          companyName: scored.company,
          phone: scored.phone ?? undefined,
          website: scored.website ?? undefined,
          instagram: scored.instagram ?? undefined,
          source: scored.source,
          sourceUrl: scored.source,
          category: scored.niche ?? undefined,
          city: scored.city ?? (scored.location ? scored.location.split(",").pop()?.trim() : undefined),
          state: scored.state ?? undefined,
          country: scored.country ?? undefined,
          signals: scored.signals,
          evidence: [...(scored.evidence ?? []), scored.scoreExplanation].filter(Boolean),
          scoreOverride: scored.score,
          statusOverride: scored.score >= 40 ? "QUALIFIED" : "NEW",
        });
        if (saved.saved) {
          result.leadsSaved++;
          if (scored.score >= 40) result.qualifiedForApproach.push(saved.lead.id);
        } else {
          result.duplicates++;
        }
      }
      if (result.leadsFound === 0) break;
    } catch (err) {
      result.blockedSources.push({ source: src.id, reason: err instanceof Error ? err.message : String(err) });
    }
  }
  return result;
}

export { leadStats, listLeads, updateLeadStatus };
