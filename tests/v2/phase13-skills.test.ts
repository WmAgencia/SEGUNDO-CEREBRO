import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import type { BrainConfig } from "../../core/config/loader.ts";
import { applySchema } from "../../storage/connection.ts";
import {
  indexSkillSource,
  searchSkills,
} from "../../core/skills/skill-engine.ts";

let dir: string;
let config: BrainConfig;
let db: DatabaseSync;
let repoA: string;

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "brain-skills-"));
  config = {
    vaultPath: path.join(dir, "v"),
    dataDir: dir,
    dbPath: path.join(dir, "b.db"),
    logLevel: "error",
    search: { defaultLimit: 10, maxLimit: 50 },
    context: { maxChars: 12000, defaultDepth: 1, maxDepth: 3 },
    ai: { baseUrl: "http://127.0.0.1:11434", model: "qwen3-1.7b" },
  };
  mkdirSync(config.vaultPath, { recursive: true });
  db = new DatabaseSync(config.dbPath);
  applySchema(db);

  repoA = path.join(dir, "repo-marketing");
  const skillDir = path.join(repoA, "skills", "cro");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    path.join(skillDir, "SKILL.md"),
    `---
name: cro
description: Conversion rate optimization para landing pages e funis de vendas
category: marketing
---
# CRO
Melhorar conversao.`,
    "utf8",
  );
  const wfDir = path.join(repoA, "workflows", "seo-audit");
  mkdirSync(wfDir, { recursive: true });
  writeFileSync(
    path.join(wfDir, "SKILL.md"),
    `---
name: seo-audit
description: Auditoria completa de SEO tecnico e conteudo
category: marketing
type: workflow
---
# SEO Audit`,
    "utf8",
  );

  indexSkillSource(db, {
    sourceId: "marketing-skills",
    repoUrl: "https://github.com/coreyhaines31/marketingskills.git",
    localPath: repoA,
  });
});

afterAll(() => {
  try {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  } catch {}
});

describe("skills engine (fase 13)", () => {
  it("indexes skills with provenance and infers kinds", () => {
    const rows = db
      .prepare("SELECT id, kind, source, hash FROM skills ORDER BY id")
      .all() as unknown as Array<{ id: string; kind: string; source: string; hash: string }>;
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.id.includes("seo-audit"))?.kind).toBe("workflow");
    expect(rows.every((r) => r.source === "marketing-skills")).toBe(true);
    expect(rows.every((r) => r.hash.length === 64)).toBe(true);

    const src = db
      .prepare("SELECT last_indexed_at FROM skill_sources WHERE id = ?")
      .get("marketing-skills") as { last_indexed_at: string };
    expect(src.last_indexed_at).toBeTruthy();
  });

  it("resolves primary and supporting skills within budget", () => {
    const res = searchSkills(db, "quero melhorar a conversao da landing page", {
      primary: 1,
      supporting: 2,
    });
    expect(res.primary[0]?.id).toContain("cro");
    expect(res.primary[0]?.score).toBeGreaterThan(0.3);
    expect(res.primary.length).toBeLessThanOrEqual(1);
    expect(res.supporting.length).toBeLessThanOrEqual(2);
  });

  it("returns nothing for unrelated tasks", () => {
    const res = searchSkills(db, "debugar kernel panic");
    expect(res.primary).toHaveLength(0);
  });
});
