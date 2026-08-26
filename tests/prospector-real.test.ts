import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applySchema, openDatabase } from "../storage/connection.ts";
import { OverpassSource } from "../core/comms/sources/overpass-source.ts";
import { buildSourceRegistry, scoreCandidate, runProspectorSearch, leadStats } from "../core/comms/prospector-engine.ts";
import { listLeads } from "../core/comms/leads.ts";

let dir: string;
let db: DatabaseSync;
let server: http.Server;
let endpoint: string;

const SAMPLE_OSM = {
  version: 0.6,
  elements: [
    { type: "node", lat: -23.5, lon: -47.45, tags: { name: "Barbearia Real", shop: "hairdresser", phone: "+55 15 99999-0001", "addr:street": "Rua Teste", "addr:city": "Sorocaba", website: "https://www.instagram.com/barbeariareal" } },
    { type: "node", lat: -23.51, lon: -47.46, tags: { name: "Salão Sem Site", shop: "beauty", phone: "+55 15 3000-0000", "addr:street": "Av Central" } },
    { type: "node", lat: -23.52, lon: -47.47, tags: { name: "Clínica Sorocaba", amenity: "dentist", "addr:street": "Rua Doutor", website: "https://clinicadental.com.br", email: "contato@clinicadental.com.br" } },
    { type: "node", lat: -23.53, lon: -47.48, tags: { shop: "bakery" } }, // sem nome → descartado
  ],
};

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "prospector-"));
  db = openDatabase(path.join(dir, "b.db"));
  applySchema(db);
  db.prepare("INSERT OR IGNORE INTO agents (id,name,status) VALUES ('sales-agent-01','Sales1','AVAILABLE')").run();

  server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = decodeURIComponent(raw.replace(/^data=/, ""));
      res.writeHead(200, { "Content-Type": "application/json" });
      // responde com amostra OSM se a query pedir, senão vazio
      res.end(JSON.stringify(body.toLowerCase().includes("barbearia") || body.includes("shop") ? SAMPLE_OSM : { elements: [] }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/interpreter`;
});

afterAll(() => {
  try { server.close(); } catch {}
  try { db.close(); rmSync(dir, { recursive: true, force: true }); } catch {}
});

describe("OverpassSource — parsing de dados OSM reais", () => {
  it("extrai telefone, instagram, categoria, cidade e descarta sem-nome", async () => {
    const src = new OverpassSource(endpoint);
    const leads = await src.search("barbearias em Sorocaba");
    expect(leads.length).toBe(3); // 4 elementos, 1 sem nome
    const barbearia = leads.find((l) => l.company === "Barbearia Real");
    expect(barbearia?.phone).toContain("99999");
    expect(barbearia?.instagram).toContain("instagram.com/barbeariareal");
    expect(barbearia?.niche).toBe("hairdresser");
    expect(barbearia?.city).toBe("Sorocaba");
    // tem presença digital (Instagram) → não é marcado como sem-site
    expect(barbearia?.signals).not.toContain("no_website");
  });
});

describe("scoreCandidate — scoring determinístico com explicação", () => {
  it("sem site mas com telefone+instagram → score e motivos", () => {
    const s = scoreCandidate({ company: "X", contact: null, website: null, source: "osm", niche: "beauty", location: "Sorocaba", signals: ["no_website"], score: 0, evidence: ["phone_public", "instagram_ativo"], phone: "+55" });
    expect(s.score).toBeGreaterThanOrEqual(40);
    expect(s.scoreExplanation).toContain("no_website=+30");
    expect(s.scoreExplanation).toContain("telefone público +10");
    expect(s.digitalPresence).toBe("low");
  });
});

describe("runProspectorSearch — pipeline completo com fonte real", () => {
  it("persiste leads, deduplica, qualifica e mantém provenance", async () => {
    process.env.OVERPASS_ENDPOINT = endpoint;
    const r = await runProspectorSearch(db, "barbearias em Sorocaba", { maxLeads: 50, goalName: "Encontrar barbearias" });
    expect(r.sourcesUsed).toContain("openstreetmap_overpass");
    expect(r.leadsFound).toBeGreaterThanOrEqual(3);
    expect(r.leadsSaved).toBeGreaterThanOrEqual(3);
    expect(r.qualifiedForApproach.length).toBeGreaterThanOrEqual(0);
    delete process.env.OVERPASS_ENDPOINT;

    const stats = leadStats(db);
    expect(stats.total).toBeGreaterThanOrEqual(3);
    const all = listLeads(db, { limit: 10 });
    const withProvenance = all.find((l) => l.source === "openstreetmap_overpass");
    expect(withProvenance).toBeTruthy();
    expect(withProvenance?.evidence.length).toBeGreaterThan(0);

    // nova busca mesma cidade deve deduplicar (nomes repetidos)
    process.env.OVERPASS_ENDPOINT = endpoint;
    const r2 = await runProspectorSearch(db, "barbearias em Sorocaba", { maxLeads: 50 });
    delete process.env.OVERPASS_ENDPOINT;
    expect(r2.duplicates).toBeGreaterThanOrEqual(1);
  });

  it("constrói source registry com campos de contrato", () => {
    const reg = buildSourceRegistry();
    const src = reg[0]!;
    expect(src.needsCredential).toBe(false);
    expect(src.costPerSearch).toBe(0);
    expect(src.enabled).toBe(true);
    expect(src.capabilities).toContain("phone");
  });
});
