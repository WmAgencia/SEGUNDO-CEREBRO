import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { ValidationError } from "../errors/errors.ts";

export type ClaimStatus = "NEW" | "UPDATED" | "CONFLICTING" | "DUPLICATE";

export interface ResearchQuestion {
  id: string;
  question: string;
}

export interface ClaimInput {
  claim: string;
  source?: string;
  authority?: number;
  sourceDate?: string;
  confidence?: number;
  relatedEntity?: string;
}

export interface ClaimRecord {
  id: number;
  questionId: string;
  claim: string;
  source: string | null;
  authority: number;
  confidence: number;
  status: ClaimStatus;
  relatedEntity: string | null;
}

export function startResearch(
  db: DatabaseSync,
  question: string,
): ResearchQuestion {
  if (!question.trim()) throw new ValidationError("question is empty");
  const id = `rq.${createHash("sha256").update(question.trim()).digest("hex").slice(0, 12)}`;
  db.prepare(
    `INSERT INTO research_questions (id, question) VALUES (?, ?)
     ON CONFLICT(id) DO NOTHING`,
  ).run(id, question.trim());
  return { id, question: question.trim() };
}

function normalizeClaim(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function jaccard(a: Set<string>, b: Set<string>): number {
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

const DUPLICATE_THRESHOLD = 0.85;

export function ingestClaim(
  db: DatabaseSync,
  questionId: string,
  input: ClaimInput,
): ClaimRecord & { comparedTo: number | null } {
  if (!input.claim || input.claim.trim() === "") {
    throw new ValidationError("claim is empty");
  }
  const q = db
    .prepare("SELECT id FROM research_questions WHERE id = ?")
    .get(questionId) as { id: string } | undefined;
  if (!q) throw new ValidationError(`research question not found: ${questionId}`);

  const normalized = normalizeClaim(input.claim);
  if (normalized === "") throw new ValidationError("claim has no content");

  const existing = db
    .prepare("SELECT id, normalized, authority FROM research_claims WHERE question_id = ?")
    .all(questionId) as unknown as Array<{
    id: number;
    normalized: string;
    authority: number;
  }>;

  let status: ClaimStatus = "NEW";
  let comparedTo: number | null = null;
  const tokens = new Set(normalized.split(" ").filter((t) => t.length > 2));

  for (const ex of existing) {
    const sim = jaccard(
      tokens,
      new Set(ex.normalized.split(" ").filter((t) => t.length > 2)),
    );
    if (sim >= DUPLICATE_THRESHOLD) {
      comparedTo = ex.id;
      const myAuthority = input.authority ?? 0.5;
      status =
        Math.abs(myAuthority - ex.authority) > 0.3 ? "CONFLICTING" : "DUPLICATE";
      break;
    }
  }

  const inserted = db
    .prepare(
      `INSERT INTO research_claims
         (question_id, claim, normalized, source, authority, source_date, confidence, status, related_entity)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      questionId,
      input.claim.trim(),
      normalized,
      input.source ?? null,
      input.authority ?? 0.5,
      input.sourceDate ?? null,
      input.confidence ?? 0.6,
      status,
      input.relatedEntity ?? null,
    );

  return {
    id: Number(inserted.lastInsertRowid),
    questionId,
    claim: input.claim.trim(),
    source: input.source ?? null,
    authority: input.authority ?? 0.5,
    confidence: input.confidence ?? 0.6,
    status,
    relatedEntity: input.relatedEntity ?? null,
    comparedTo,
  };
}

export function listClaims(
  db: DatabaseSync,
  questionId: string,
): ClaimRecord[] {
  const rows = db
    .prepare(
      `SELECT * FROM research_claims WHERE question_id = ?
       ORDER BY authority DESC, created_at DESC`,
    )
    .all(questionId) as unknown as Array<{
    id: number;
    question_id: string;
    claim: string;
    source: string | null;
    authority: number;
    confidence: number;
    status: string;
    related_entity: string | null;
  }>;
  return rows.map((r) => ({
    id: r.id,
    questionId: r.question_id,
    claim: r.claim,
    source: r.source,
    authority: r.authority,
    confidence: r.confidence,
    status: r.status as ClaimStatus,
    relatedEntity: r.related_entity,
  }));
}
