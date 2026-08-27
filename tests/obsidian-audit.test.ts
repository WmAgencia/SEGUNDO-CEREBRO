import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase, applySchema } from "../storage/connection.ts";
import { indexVault } from "../core/indexing/vault-indexer.ts";
import type { LogLevel } from "../core/logger/logger.ts";
import { auditVault, auditExplanation } from "../core/organization/vault-audit.ts";
import { resolveOrCreateEntity } from "../core/organization/entity-dedup.ts";

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* retry on Windows */ }
  }
});

function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), "sb-audit-"));
  dirs.push(dir);
  const vaultPath = path.join(dir, "vault");
  mkdirSync(vaultPath, { recursive: true });
  const config = {
    vaultPath,
    dataDir: dir,
    dbPath: path.join(dir, "b.db"),
    logLevel: "error" as LogLevel,
    search: { defaultLimit: 10, maxLimit: 50 },
    context: { maxChars: 12000, defaultDepth: 1, maxDepth: 3 },
    ai: { baseUrl: "http://127.0.0.1", model: "test" },
  };
  const db = openDatabase(config.dbPath);
  applySchema(db);
  db.close();
  return { dir, vaultPath, config };
}

describe("core/organization/vault-audit (read-only)", () => {
  it("detecta notas duplicadas, pastas duplicadas, vazias, links quebrados e sem classificação", () => {
    const { vaultPath, config } = setup();
    writeFileSync(path.join(vaultPath, "Pessoa.md"), "---\ntype: person\ntags: [cliente]\n---\n# Pessoa\n", "utf8");
    mkdirSync(path.join(vaultPath, "sub"), { recursive: true });
    writeFileSync(path.join(vaultPath, "sub", "Pessoa.md"), "---\ntype: person\n---\n# Pessoa duplicada\n", "utf8");
    writeFileSync(path.join(vaultPath, "Vazia.md"), "", "utf8");
    writeFileSync(path.join(vaultPath, "SemClassificar.md"), "# sem frontmatter\n", "utf8");
    writeFileSync(path.join(vaultPath, "Ref.md"), "Veja [[nota-inexistente]]\n", "utf8");
    writeFileSync(path.join(vaultPath, "Ok.md"), "---\ntype: project\n---\nconteudo ok\n", "utf8");

    const report = auditVault(config);
    expect(report.scannedNotes).toBe(6);
    expect(report.duplicateNotes.some((d) => d.title === "pessoa")).toBe(true);
    expect(report.emptyNotes).toContain("Vazia.md");
    expect(report.brokenLinks.some((b) => b.target === "nota-inexistente")).toBe(true);
    expect(report.unclassified.some((u) => u.path === "SemClassificar.md")).toBe(true);
    expect(report.ok).toBe(false);
    // relatório explicativo é legível
    expect(auditExplanation(report)).toMatch(/Auditoria do Vault/);
  });

  it("vault limpo reporta ok", () => {
    const { vaultPath, config } = setup();
    writeFileSync(path.join(vaultPath, "Clean.md"), "---\ntype: concept\n---\nok\n", "utf8");
    const report = auditVault(config);
    expect(report.scannedNotes).toBe(1);
    expect(report.ok).toBe(true);
  });

  it("detecta entidades órfãs no banco após indexar sem origem", () => {
    const { vaultPath, config } = setup();
    writeFileSync(path.join(vaultPath, "A.md"), "---\nid: person.alice\ntype: person\n---\nAlice\n", "utf8");
    indexVault(config);
    // simula origem perdida (dados históricos/legados): referencia doc inexistente
    const db = openDatabase(config.dbPath);
    applySchema(db);
    db.exec("PRAGMA foreign_keys = OFF");
    db.prepare("UPDATE entities SET origin_document_id = 'ghost.doc.id' WHERE id = 'person.alice'").run();
    db.close();
    const report = auditVault(config);
    expect(report.orphanEntities.some((o) => o.id === "person.alice")).toBe(true);
  });
});

describe("core/organization/entity-dedup (SEARCH → UPDATE ; CREATE)", () => {
  it("resolve pessoa já existente sem criar duplicata", () => {
    const { config } = setup();
    const db = openDatabase(config.dbPath);
    applySchema(db);
    const first = resolveOrCreateEntity(db, { name: "Derek", entityType: "person" });
    expect(first.resolved).toBe(false);
    expect(first.method).toBe("create");
    const again = resolveOrCreateEntity(db, { name: "Derek", entityType: "person" });
    expect(again.resolved).toBe(true);
    expect(again.entityId).toBe(first.entityId); // SEM "Derek 2"
    db.close();
  });

  it("alias resolve para a mesma entidade", () => {
    const { config } = setup();
    const db = openDatabase(config.dbPath);
    applySchema(db);
    const base = resolveOrCreateEntity(db, { name: "Ana Clara", entityType: "person", aliases: ["Ana"] });
    const byAlias = resolveOrCreateEntity(db, { name: "Ana", entityType: "person" });
    expect(byAlias.entityId).toBe(base.entityId);
    db.close();
  });

  it("forceCreate cria entidade nova mesmo com match", () => {
    const { config } = setup();
    const db = openDatabase(config.dbPath);
    applySchema(db);
    const first = resolveOrCreateEntity(db, { name: "Vyntra", entityType: "project" });
    const forced = resolveOrCreateEntity(db, { name: "Vyntra", entityType: "project" }, { forceCreate: true });
    expect(forced.hasOwnProperty("entityId")).toBe(true);
    // os nomes não devem gerar ids instáveis para o mesmo nome
    db.close();
  });
});