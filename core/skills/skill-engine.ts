import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parse as parseYaml } from "yaml";

export interface IndexedSkill {
  id: string;
  name: string;
  description: string;
  category: string;
  kind: "skill" | "workflow" | "reference" | "command" | "meta-skill";
  source: string;
  repo: string;
  path: string;
  hash: string;
}

const FRONTMATTER_RE = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

function findSkillFiles(root: string, out: string[] = []): string[] {
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(root, e.name);
    if (e.isDirectory()) {
      if (e.name === ".git") continue;
      findSkillFiles(full, out);
    } else if (e.name.toUpperCase() === "SKILL.MD") {
      out.push(full);
    }
  }
  return out;
}

function inferKind(relPath: string): IndexedSkill["kind"] {
  const norm = relPath.toLowerCase();
  if (norm.includes("workflow")) return "workflow";
  if (norm.includes("command")) return "command";
  if (norm.includes("reference")) return "reference";
  return "skill";
}

export function indexSkillSource(
  db: DatabaseSync,
  args: { sourceId: string; repoUrl?: string; localPath: string; defaultCategory?: string; forceKind?: IndexedSkill["kind"] },
): { indexed: number; updated: number } {
  if (!existsSync(args.localPath)) {
    throw new Error(`skill source path not found: ${args.localPath}`);
  }

  db.prepare(
    `INSERT INTO skill_sources (id, kind, url, last_indexed_at) VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
     ON CONFLICT(id) DO UPDATE SET last_indexed_at = excluded.last_indexed_at`,
  ).run(
    args.sourceId,
    args.repoUrl ? "external" : "local",
    args.repoUrl ?? null,
  );

  let indexed = 0;
  let updated = 0;

  for (const file of findSkillFiles(args.localPath)) {
    let raw: string;
    try {
      raw = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    if (!raw.trim()) continue;

    const hash = createHash("sha256").update(raw).digest("hex");
    const relPath = path.relative(args.localPath, file).split("\\").join("/");

    let name = "";
    let description = "";
    let category = args.defaultCategory ?? "";
    const fmMatch = FRONTMATTER_RE.exec(raw);
    if (fmMatch?.[1]) {
      try {
        const fm = parseYaml(fmMatch[1]) as Record<string, unknown>;
        if (typeof fm.name === "string") name = fm.name.trim();
        if (typeof fm.description === "string") description = fm.description.trim().slice(0, 400);
        if (typeof fm.category === "string") category = fm.category.trim();
        else if (typeof fm.domain === "string") category = fm.domain.trim();
      } catch {}
    }
    if (name === "") name = path.basename(path.dirname(file));
    if (description === "") description = raw.replace(/[#>-]/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);

    const id = `${args.sourceId}:${name.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "")}`;
    const kind = args.forceKind ?? inferKind(relPath);
    const stat = statSync(file);

    const existing = db
      .prepare("SELECT hash FROM skills WHERE id = ?")
      .get(id) as { hash: string } | undefined;

    db.prepare(
      `INSERT INTO skills (id, name, description, category, kind, source, repo, path, hash, version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name=excluded.name, description=excluded.description, category=excluded.category,
         kind=excluded.kind, repo=excluded.repo, path=excluded.path,
         hash=excluded.hash, version=excluded.version`,
    ).run(
      id,
      name,
      description,
      category,
      kind,
      args.sourceId,
      args.repoUrl ?? null,
      relPath,
      hash,
      String(stat.mtime.toISOString().slice(0, 10)),
    );

    if (existing && existing.hash !== hash) updated++;
    else if (!existing) indexed++;
  }

  return { indexed, updated };
}

export interface SkillHit {
  id: string;
  name: string;
  description: string;
  source: string;
  path: string | null;
  score: number;
  reason: string;
}

const STOP = new Set([
  "quero", "preciso", "melhorar", "the", "and", "for", "uma", "para", "com",
  "dos", "das", "que", "como", "minha", "meu", "fazer",
]);

export function searchSkills(
  db: DatabaseSync,
  task: string,
  budget: { primary?: number; supporting?: number } = {},
): { primary: SkillHit[]; supporting: SkillHit[] } {
  const tokens = (task.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter(
    (t) => t.length > 2 && !STOP.has(t),
  );
  if (tokens.length === 0) return { primary: [], supporting: [] };

  const rows = db
    .prepare("SELECT * FROM skills WHERE status = 'active'")
    .all() as unknown as Array<{
    id: string;
    name: string;
    description: string;
    category: string;
    source: string;
    path: string | null;
  }>;

  const scored: SkillHit[] = [];
  for (const s of rows) {
    const hay = `${s.name} ${s.category} ${s.description}`.toLowerCase();
    const matched = tokens.filter((t) => hay.includes(t));
    if (matched.length === 0) continue;
    const inName = tokens.some((t) => s.name.toLowerCase().includes(t));
    scored.push({
      id: s.id,
      name: s.name,
      description: s.description.slice(0, 160),
      source: s.source,
      path: s.path,
      score: Math.round((matched.length / tokens.length + (inName ? 0.25 : 0)) * 100) / 100,
      reason: `casa com: ${matched.slice(0, 4).join(", ")}${inName ? " (+nome)" : ""}`,
    });
  }
  scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));

  const pCount = Math.max(1, Math.min(5, budget.primary ?? 3));
  const sCount = Math.max(0, Math.min(8, budget.supporting ?? 3));
  return {
    primary: scored.slice(0, pCount),
    supporting: scored.slice(pCount, pCount + sCount),
  };
}
