import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { indexVault } from "../../core/indexing/vault-indexer.ts";
import type { BrainConfig } from "../../core/config/loader.ts";
import {
  closeRelation,
  relatedEdges,
  supersedeRelation,
  traverseGraph,
} from "../../core/relations/graph.ts";
import { resolveEntity } from "../../core/entities/resolver.ts";
import { getEntity, getEntityStats } from "../../core/entities/entity.ts";
import { buildTimeline } from "../../core/retrieval/timeline.ts";

let dir: string;
let vault: string;
let config: BrainConfig;

function write(relPath: string, content: string): void {
  const abs = path.join(vault, relPath.split("/").join(path.sep));
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content, "utf8");
}

function openDb(): DatabaseSync {
  return new DatabaseSync(config.dbPath);
}

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "brain-graph-"));
  vault = path.join(dir, "vault");
  mkdirSync(vault, { recursive: true });
  config = {
    vaultPath: vault,
    dataDir: dir,
    dbPath: path.join(dir, "brain.db"),
    logLevel: "error",
    search: { defaultLimit: 10, maxLimit: 50 },
    context: { maxChars: 12000, defaultDepth: 1, maxDepth: 3 }, ai: { baseUrl: "http://127.0.0.1:11434", model: "qwen3-1.7b" },
  };

  write(
    "01 - Projects/alpha.md",
    `---
id: project.alpha
type: project
title: Alpha
aliases: [Projeto Alfa]
relations:
  - type: USES
    target: system.beta
---

# Alpha

Conecta com [[system.beta]] e [[concept.gamma]].
Palavra rara xilofone para teste FTS.`,
  );
  write(
    "03 - Knowledge/beta.md",
    `---
id: system.beta
type: system
title: Beta
---
Beta depende de [[concept.gamma]].`,
  );
  write(
    "03 - Knowledge/gamma.md",
    `---
id: concept.gamma
type: concept
title: Gamma
---
Conceito base.`,
  );
  write(
    "07 - Entities/eve.md",
    `---
id: person.eve
type: person
title: Eve
---
Trabalha em [[project.alpha]].`,
  );
  write("03 - Knowledge/delta.md", "---\nid: knowledge.delta\ntitle: Delta\n---\nIsolado.");

  indexVault(config);
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("entities/entity", () => {
  it("returns entity with parsed aliases and stats", () => {
    const db = openDb();
    try {
      const entity = getEntity(db, "project.alpha");
      expect(entity.canonicalName).toBe("Alpha");
      expect(entity.aliases).toContain("Projeto Alfa");
      expect(entity.type).toBe("project");

      const stats = getEntityStats(db, "project.alpha");
      expect(stats.outgoingRelations).toBeGreaterThanOrEqual(3);
      expect(stats.incomingRelations).toBeGreaterThanOrEqual(1);
      expect(stats.originDocument?.path).toContain("alpha.md");
    } finally {
      db.close();
    }
  });

  it("throws NotFoundError for unknown entity", () => {
    const db = openDb();
    try {
      expect(() => getEntity(db, "project.nao-existe")).toThrowError(/not found/);
    } finally {
      db.close();
    }
  });
});

describe("entities/resolver", () => {
  it("resolves by exact id with confidence 1", () => {
    const db = openDb();
    try {
      const result = resolveEntity(db, "project.alpha");
      expect(result.best?.method).toBe("id");
      expect(result.best?.confidence).toBe(1);
      expect(result.best?.entity.id).toBe("project.alpha");
    } finally {
      db.close();
    }
  });

  it("resolves by alias case-insensitively", () => {
    const db = openDb();
    try {
      const result = resolveEntity(db, "projeto alfa");
      expect(result.best?.method).toBe("alias");
      expect(result.best?.entity.id).toBe("project.alpha");
    } finally {
      db.close();
    }
  });

  it("resolves by canonical name", () => {
    const db = openDb();
    try {
      const result = resolveEntity(db, "beta");
      expect(result.best?.entity.id).toBe("system.beta");
      expect(["name", "prefix"]).toContain(result.best?.method);
    } finally {
      db.close();
    }
  });

  it("resolves unique prefix", () => {
    const db = openDb();
    try {
      const result = resolveEntity(db, "Gamm");
      expect(result.best?.entity.id).toBe("concept.gamma");
      expect(result.best?.method).toBe("prefix");
    } finally {
      db.close();
    }
  });

  it("falls back to fts for body terms", () => {
    const db = openDb();
    try {
      const result = resolveEntity(db, "xilofone");
      expect(result.best?.method).toBe("fts");
      expect(result.best?.entity.id).toBe("project.alpha");
    } finally {
      db.close();
    }
  });

  it("returns empty result for unknown query", () => {
    const db = openDb();
    try {
      const result = resolveEntity(db, "zzzdesconhecido");
      expect(result.best).toBeNull();
      expect(result.candidates).toHaveLength(0);
    } finally {
      db.close();
    }
  });
});

describe("relations/graph", () => {
  it("lists outgoing edges with types", () => {
    const db = openDb();
    try {
      const edges = relatedEdges(db, "project.alpha", { direction: "out" });
      const pairs = edges.map((e) => `${e.source}->${e.target}:${e.relationType}`);
      expect(pairs).toContain("project.alpha->system.beta:USES");
      expect(pairs.some((p) => p.includes(":LINKS_TO") && p.includes("system.beta"))).toBe(true);
      expect(pairs.some((p) => p.includes("concept.gamma"))).toBe(true);
    } finally {
      db.close();
    }
  });

  it("lists incoming edges", () => {
    const db = openDb();
    try {
      const edges = relatedEdges(db, "project.alpha", { direction: "in" });
      expect(edges.every((e) => e.target === "project.alpha")).toBe(true);
      expect(edges.some((e) => e.source === "person.eve")).toBe(true);
    } finally {
      db.close();
    }
  });

  it("traverses depth 2 and deduplicates nodes", () => {
    const db = openDb();
    try {
      const t1FromBeta = traverseGraph(db, "system.beta", { maxDepth: 1 });
      const ids1 = t1FromBeta.nodes.map((n) => n.id);
      expect(ids1).toContain("system.beta");
      expect(ids1).toContain("concept.gamma");
      expect(ids1).not.toContain("person.eve");

      const t2FromBeta = traverseGraph(db, "system.beta", { maxDepth: 2 });
      const ids2 = t2FromBeta.nodes.map((n) => n.id);
      expect(ids2).toContain("person.eve");
      expect(new Set(ids2).size).toBe(ids2.length);
    } finally {
      db.close();
    }
  });

  it("filters by relation type", () => {
    const db = openDb();
    try {
      const edges = relatedEdges(db, "project.alpha", {
        direction: "out",
        relationTypes: ["USES"],
      });
      expect(edges).toHaveLength(1);
      expect(edges[0]?.target).toBe("system.beta");
    } finally {
      db.close();
    }
  });

  it("respects temporal validity (asOf)", () => {
    const db = openDb();
    try {
      db.prepare(
        `INSERT INTO relations (source_entity, relation_type, target_entity, confidence, valid_from, valid_until)
         VALUES ('project.alpha', 'USES', 'knowledge.delta', 1.0, '2019-01-01', '2020-01-01')`,
      ).run();

      const nowEdges = relatedEdges(db, "project.alpha", { direction: "out" });
      expect(nowEdges.some((e) => e.target === "knowledge.delta")).toBe(false);

      const pastEdges = relatedEdges(db, "project.alpha", {
        direction: "out",
        asOf: "2019-06-01",
      });
      expect(pastEdges.some((e) => e.target === "knowledge.delta")).toBe(true);
    } finally {
      db.close();
    }
  });

  it("supersedes a relation preserving history (never overwrite)", () => {
    const db = openDb();
    try {
      const inserted = db
        .prepare(
          `INSERT INTO relations (source_entity, relation_type, target_entity, confidence, valid_from)
           VALUES ('project.alpha', 'PART_OF', 'concept.gamma', 0.8, '2025-01-01')`,
        )
        .run();
      const oldId = Number(inserted.lastInsertRowid);

      const newId = supersedeRelation(
        db,
        oldId,
        {
          sourceEntity: "project.alpha",
          targetEntity: "system.beta",
          relationType: "part_of",
          confidence: 0.9,
        },
        { closeUntil: "2026-05-31T00:00:00Z", newValidFrom: "2026-06-01T00:00:00Z" },
      );

      const rows = db
        .prepare("SELECT * FROM relations WHERE id IN (?, ?) ORDER BY id")
        .all(oldId, newId) as unknown as Array<{
        id: number;
        valid_until: string | null;
        target_entity: string;
      }>;

      expect(rows).toHaveLength(2);
      const oldRow = rows.find((r) => r.id === oldId);
      const newRow = rows.find((r) => r.id === newId);
      expect(oldRow?.valid_until).toBe("2026-05-31T00:00:00Z");
      expect(newRow?.target_entity).toBe("system.beta");
      expect(newRow?.valid_until).toBeNull();

      expect(closeRelation(db, oldId, "2027-01-01")).toBe(false);
      expect(closeRelation(db, newId, "2027-01-01")).toBe(true);
    } finally {
      db.close();
    }
  });

  it("rejects superseding an already-closed relation", () => {
    const db = openDb();
    try {
      const inserted = db
        .prepare(
          `INSERT INTO relations (source_entity, relation_type, target_entity, valid_until)
           VALUES ('person.eve', 'LINKS_TO', 'concept.gamma', '2025-12-31')`,
        )
        .run();
      expect(() =>
        supersedeRelation(db, Number(inserted.lastInsertRowid), {
          sourceEntity: "person.eve",
          targetEntity: "system.beta",
          relationType: "LINKS_TO",
        }),
      ).toThrowError(/already closed/);
    } finally {
      db.close();
    }
  });
});

describe("retrieval/timeline", () => {
  it("builds entity timeline sorted desc with kinds", () => {
    const db = openDb();
    try {
      const timeline = buildTimeline(db, { entityId: "project.alpha", limit: 20 });
      expect(timeline.length).toBeGreaterThan(0);

      const kinds = new Set(timeline.map((t) => t.kind));
      expect(kinds.has("relation")).toBe(true);
      expect(kinds.has("document")).toBe(true);

      for (let i = 1; i < timeline.length; i++) {
        const prev = timeline[i - 1];
        const curr = timeline[i];
        expect(prev && curr ? prev.at >= curr.at : true).toBe(true);
      }
    } finally {
      db.close();
    }
  });

  it("filters timeline by kind", () => {
    const db = openDb();
    try {
      const onlyRelations = buildTimeline(db, {
        entityId: "project.alpha",
        kinds: ["relation"],
        limit: 50,
      });
      expect(onlyRelations.every((t) => t.kind === "relation")).toBe(true);
      expect(onlyRelations.length).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });
});
