import { describe, expect, it } from "vitest";
import { scanSkillSource } from "../core/skills/skill-registry.ts";
import { openDatabase, applySchema } from "../storage/connection.ts";
import { registerSkill } from "../core/skills/skill-registry.ts";

describe("Skill Registry", () => {
  it("flags dynamic execution as HIGH risk", () => {
    const scan = scanSkillSource("const x = eval(userInput); require('child_process').exec(cmd);");
    expect(scan.safe).toBe(false);
    expect(scan.risk).toBe("HIGH");
    expect(scan.findings.length).toBeGreaterThanOrEqual(2);
  });

  it("flags secret access as MEDIUM risk", () => {
    const scan = scanSkillSource("const key = process.env.API_KEY;");
    expect(scan.risk).toBe("MEDIUM");
    expect(scan.findings).toContain("API key access");
  });

  it("marks clean source as LOW risk", () => {
    const scan = scanSkillSource("export function greet(name: string) { return `Hello ${name}`; }");
    expect(scan.safe).toBe(true);
    expect(scan.risk).toBe("LOW");
  });

  it("refuses to register HIGH-risk scan as LOW risk entry", () => {
    const db = openDatabase(":memory:"); applySchema(db);
    const dangerous = scanSkillSource("eval(code); exec(cmd);");
    expect(() => registerSkill(db, {
      id: "bad-skill", name: "Bad", description: "", source: "test", license: "MIT",
      capabilities: [], tools: [], agents: [], permissions: [], risk: "LOW",
      dependencies: [], tests: [], provenance: {},
    }, dangerous)).toThrow("unsafe skill cannot be registered as LOW risk");
    db.close();
  });

  it("registers a clean skill and persists metadata", () => {
    const db = openDatabase(":memory:"); applySchema(db);
    const clean = scanSkillSource("export function search(query) { return db.query(query); }");
    registerSkill(db, {
      id: "search-helper", name: "Search Helper", description: "Helper for search", version: "1.0.0",
      source: "internal", license: "MIT", capabilities: ["search"], tools: ["brain_search"],
      agents: ["research-agent"], permissions: ["READ"], risk: "LOW",
      dependencies: [], tests: [], provenance: { origin: "internal" },
    }, clean);
    const row = db.prepare("SELECT name, license, risk_level FROM skills WHERE id='search-helper'").get() as { name: string; license: string; risk_level: string };
    expect(row.name).toBe("Search Helper");
    expect(row.license).toBe("MIT");
    expect(row.risk_level).toBe("LOW");
    db.close();
  });
});
