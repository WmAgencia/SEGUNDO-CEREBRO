import { parse as parseYaml } from "yaml";

export interface NoteHeading {
  level: number;
  text: string;
}

export interface WikiLink {
  target: string;
  heading?: string;
  display?: string;
}

export interface ExplicitRelation {
  type: string;
  target: string;
}

export interface ParsedNote {
  relPath: string;
  frontmatter: Record<string, unknown>;
  body: string;
  title: string;
  id?: string;
  type?: string;
  status?: string;
  tags: string[];
  aliases: string[];
  createdAt?: string;
  updatedAt?: string;
  headings: NoteHeading[];
  wikiLinks: WikiLink[];
  explicitRelations: ExplicitRelation[];
}

const FRONTMATTER_RE = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function stripCodeBlocks(body: string): string {
  return body
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/~~~[\s\S]*?~~~/g, " ")
    .replace(/`[^`\n]*`/g, " ");
}

function asStringArray(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) {
    return value.map((v) => String(v).trim()).filter((v) => v !== "");
  }
  const text = String(value).trim();
  if (text === "") return [];
  return text
    .split(/[,\s]+/)
    .map((t) => t.trim())
    .filter((t) => t !== "");
}

function normalizeDate(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const raw = String(value).trim();
  if (raw === "") return undefined;
  if (/^\d{4}-\d{2}-\d{2}(T[\s\S]+)?$/.test(raw)) {
    return raw.length === 10 ? raw : raw.replace(" ", "T");
  }
  const parsed = Date.parse(raw);
  if (!Number.isNaN(parsed)) return new Date(parsed).toISOString();
  return undefined;
}

function extractInlineTags(scannableBody: string): string[] {
  const tags = new Set<string>();
  const re = /(^|[\s(\[])#([A-Za-z][A-Za-z0-9_\-/]*)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(scannableBody)) !== null) {
    const tag = match[2];
    if (tag) tags.add(tag);
  }
  return [...tags];
}

function extractWikiLinks(scannableBody: string): WikiLink[] {
  const links: WikiLink[] = [];
  const re = /\[\[([^\[\]|#]+)(?:#([^\[\]|]+))?(?:\|([^\[\]]+))?\]\]/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(scannableBody)) !== null) {
    const target = (match[1] ?? "").trim();
    if (target === "" || target.startsWith("^")) continue;
    const heading = match[2];
    const display = match[3];
    links.push({
      target,
      heading: heading ? heading.trim() : undefined,
      display: display ? display.trim() : undefined,
    });
  }
  return links;
}

function extractHeadings(body: string): NoteHeading[] {
  const headings: NoteHeading[] = [];
  let inFence = false;
  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(trimmed);
    if (m && m[1] && m[2]) {
      headings.push({ level: m[1].length, text: m[2] });
    }
  }
  return headings;
}

function extractExplicitRelations(frontmatter: Record<string, unknown>): ExplicitRelation[] {
  const raw = frontmatter.relations;
  if (!Array.isArray(raw)) return [];
  const out: ExplicitRelation[] = [];
  for (const entry of raw) {
    if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      const rec = entry as Record<string, unknown>;
      const type = typeof rec.type === "string" ? rec.type.trim().toUpperCase() : "";
      const target = typeof rec.target === "string" ? rec.target.trim() : "";
      if (type !== "" && target !== "") out.push({ type, target });
    }
  }
  return out;
}

export function parseMarkdown(
  raw: string,
  relPath: string,
): ParsedNote {
  let frontmatter: Record<string, unknown> = {};
  const clean = stripBom(raw);
  let body = clean;

  const fmMatch = FRONTMATTER_RE.exec(clean);
  if (fmMatch && fmMatch[1]) {
    try {
      const parsedFm: unknown = parseYaml(fmMatch[1]);
      if (parsedFm && typeof parsedFm === "object" && !Array.isArray(parsedFm)) {
        frontmatter = parsedFm as Record<string, unknown>;
        body = clean.slice(fmMatch[0].length);
      }
    } catch {
      frontmatter = {};
      body = clean;
    }
  }

  const scannableBody = stripCodeBlocks(body);

  const fileName = relPath.split(/[/\\]/).pop() ?? relPath;
  const baseName = fileName.replace(/\.(md|markdown)$/i, "");

  let title = baseName;
  if (typeof frontmatter.title === "string" && frontmatter.title.trim() !== "") {
    title = frontmatter.title.trim();
  } else {
    const h1 = extractHeadings(body).find((h) => h.level === 1);
    if (h1) title = h1.text;
  }

  const fmTags = asStringArray(frontmatter.tags);
  const inlineTags = extractInlineTags(scannableBody);
  const tags = [...new Set([...fmTags, ...inlineTags])];

  const aliases = asStringArray(frontmatter.aliases);

  const id =
    typeof frontmatter.id === "string" && frontmatter.id.trim() !== ""
      ? frontmatter.id.trim()
      : undefined;
  const type =
    typeof frontmatter.type === "string" && frontmatter.type.trim() !== ""
      ? frontmatter.type.trim()
      : undefined;
  const status =
    typeof frontmatter.status === "string" && frontmatter.status.trim() !== ""
      ? frontmatter.status.trim()
      : undefined;

  return {
    relPath,
    frontmatter,
    body,
    title,
    id,
    type,
    status,
    tags,
    aliases,
    createdAt: normalizeDate(frontmatter.created_at),
    updatedAt: normalizeDate(frontmatter.updated_at),
    headings: extractHeadings(body),
    wikiLinks: extractWikiLinks(scannableBody),
    explicitRelations: extractExplicitRelations(frontmatter),
  };
}
