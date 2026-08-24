import { DatabaseSync } from "node:sqlite";
import { ValidationError } from "../errors/errors.ts";

export interface SkillRegistryEntry {
  id: string; name: string; description?: string; version?: string; source: string; license: string;
  capabilities: string[]; tools: string[]; agents: string[]; permissions: string[]; risk: "LOW"|"MEDIUM"|"HIGH"|"CRITICAL";
  estimatedCost?: number; dependencies: string[]; tests: string[]; documentationUrl?: string; provenance: Record<string, unknown>;
}

export interface SkillScan { safe: boolean; risk: "LOW"|"MEDIUM"|"HIGH"; findings: string[]; }

const DANGEROUS_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\beval\s*\(/i, label: "eval() usage" },
  { pattern: /new\s+Function\s*\(/i, label: "new Function() usage" },
  { pattern: /child_process/i, label: "child_process import" },
  { pattern: /\.exec\s*\(|exec\s*\(/i, label: "exec() usage" },
  { pattern: /\.spawn\s*\(|spawn\s*\(/i, label: "spawn() usage" },
  { pattern: /curl\s+.*\|\s*(sh|bash)/i, label: "piped shell installer" },
  { pattern: /powershell.*-enc/i, label: "encoded PowerShell" },
  { pattern: /base64.*decode|atob\s*\(/i, label: "base64 decode" },
  { pattern: /api[_-]?key/i, label: "API key access" },
  { pattern: /\btoken\b/i, label: "token access" },
  { pattern: /\bpassword\b/i, label: "password access" },
  { pattern: /\bsecret\b/i, label: "secret access" },
];

export function scanSkillSource(source: string): SkillScan {
  const findings: string[] = [];
  for (const { pattern, label } of DANGEROUS_PATTERNS) {
    if (pattern.test(source)) findings.push(label);
  }
  const risk = findings.length >= 3 ? "HIGH" : findings.length >= 1 ? "MEDIUM" : "LOW";
  return { safe: findings.length === 0, risk, findings };
}

export function registerSkill(db: DatabaseSync, entry: SkillRegistryEntry, scan?: SkillScan): void {
  if (!entry.id.trim() || !entry.name.trim()) throw new ValidationError("skill id and name are required");
  const effectiveRisk = scan && scan.risk !== "LOW" ? scan.risk : entry.risk;
  if (scan && !scan.safe && entry.risk === "LOW") throw new ValidationError("unsafe skill cannot be registered as LOW risk");
  db.prepare(`INSERT INTO skills (id,name,description,version,source,status,metadata,license,capabilities_json,tools_json,agents_json,permissions_json,risk_level,estimated_cost,dependencies_json,tests_json,documentation_url,provenance_json)
    VALUES (?,?,?,?,?,'candidate','{}',?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,description=excluded.description,version=excluded.version,source=excluded.source,license=excluded.license,capabilities_json=excluded.capabilities_json,tools_json=excluded.tools_json,agents_json=excluded.agents_json,permissions_json=excluded.permissions_json,risk_level=excluded.risk_level,estimated_cost=excluded.estimated_cost,dependencies_json=excluded.dependencies_json,tests_json=excluded.tests_json,documentation_url=excluded.documentation_url,provenance_json=excluded.provenance_json`)
    .run(entry.id, entry.name, entry.description ?? "", entry.version ?? "", entry.source, entry.license, JSON.stringify(entry.capabilities), JSON.stringify(entry.tools), JSON.stringify(entry.agents), JSON.stringify(entry.permissions), effectiveRisk, entry.estimatedCost ?? null, JSON.stringify(entry.dependencies), JSON.stringify(entry.tests), entry.documentationUrl ?? null, JSON.stringify(entry.provenance));
}
