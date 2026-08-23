import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { applySchema, openDatabase } from "../../storage/connection.ts";
import {
  ingestClaim,
  listClaims,
  startResearch,
} from "../../core/research/research-engine.ts";

let dir: string;
let db: DatabaseSync;
let qid: string;

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "brain-research-"));
  const config = {
    vaultPath: path.join(dir, "v"),
    dataDir: dir,
    dbPath: path.join(dir, "b.db"),
    logLevel: "error" as const,
    search: { defaultLimit: 10, maxLimit: 50 },
    context: { maxChars: 12000, defaultDepth: 1, maxDepth: 3 },
    ai: { baseUrl: "http://127.0.0.1:11434", model: "qwen3-1.7b" },
  };
  void config;
  mkdirSync(config.vaultPath, { recursive: true });
  db = openDatabase(config.dbPath);
  applySchema(db);
  qid = startResearch(db, "Quais as melhores praticas de onboarding de vendas em 2026?").id;
});

afterAll(() => {
  try {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  } catch {}
});

describe("research engine (fase 15)", () => {
  it("starts research and stores NEW claims with provenance", () => {
    const c1 = ingestClaim(db, qid, {
      claim: "Onboarding ideal tem duracao de 30 dias com metas semanais",
      source: "https://exemplo.com/sales-playbook-2026",
      authority: 0.8,
      sourceDate: "2026-06-01",
      confidence: 0.75,
    });
    expect(c1.status).toBe("NEW");
    expect(c1.source).toContain("https://");
  });

  it("marks near-duplicate claims as DUPLICATE", () => {
    const dup = ingestClaim(db, qid, {
      claim: "Onboarding ideal tem duracao de 30 dias com metas semanais!",
      source: "outra-fonte.com",
      authority: 0.6,
    });
    expect(dup.status).toBe("DUPLICATE");
    expect(dup.comparedTo).not.toBeNull();
  });

  it("detects CONFLICTING when authority differs significantly", () => {
    const conflict = ingestClaim(db, qid, {
      claim: "Onboarding deve durar 90 dias focados em produto antes de vender",
      source: "estudo-academico.edu",
      authority: 0.9,
    });
    // jaccard baixo (texto diferente) -> NEW; testamos conflito via claim parecida:
    const similar = ingestClaim(db, qid, {
      claim: "Onboarding ideal tem duracao de 30 dias com metas semanais e revisao",
      source: "especialista-x.io",
      authority: 0.2,
    });
    expect(similar.status).toBe("CONFLICTING");
    expect(conflict.status).toBe("NEW");
  });

  it("lists claims ranked by authority", () => {
    const claims = listClaims(db, qid);
    expect(claims.length).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < claims.length; i++) {
      const prev = claims[i - 1];
      const curr = claims[i];
      expect(prev && curr ? prev.authority >= curr.authority : true).toBe(true);
    }
  });
});
