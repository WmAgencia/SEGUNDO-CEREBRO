import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export interface IgnoreRule {
  pattern: string;
  fileRegex: RegExp | null;
  dirBaseRegex: RegExp | null;
}

const ALWAYS_IGNORED = [
  ".env",
  ".env.*",
  "**/*.pem",
  "**/*.key",
  "**/secrets/**",
  "**/credentials/**",
  ".obsidian/",
  ".trash/",
  "_system/indexes/**",
];

function escapeRegex(text: string): string {
  return text.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}

function segmentToRegex(segment: string): string {
  let out = "";
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i];
    if (ch === undefined) break;
    if (ch === "*") {
      if (segment[i + 1] === "*") {
        out += ".*";
        i++;
      } else {
        out += "[^/]*";
      }
    } else if (ch === "?") {
      out += "[^/]";
    } else {
      out += escapeRegex(ch);
    }
  }
  return out;
}

function translatePattern(pattern: string): string {
  const segments = pattern.split("/");
  const parts: string[] = [];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i] ?? "";
    if (seg === "**") {
      const isFirst = i === 0;
      const isLast = i === segments.length - 1;
      if (isFirst && !isLast) parts.push("(?:.*/)?");
      else if (isLast) {
        const lastPart = parts[parts.length - 1];
        if (parts.length > 0 && lastPart?.endsWith("/")) {
          parts[parts.length - 1] = lastPart.slice(0, -1);
          parts.push("(?:/.*)?");
        } else {
          parts.push("(?:/.*)?");
        }
      } else parts.push(".*/");
    } else if (seg === "") {
      continue;
    } else {
      parts.push(segmentToRegex(seg));
      if (i < segments.length - 1) parts.push("/");
    }
  }
  return parts.join("");
}

function compileRule(rawPattern: string): IgnoreRule | null {
  let pattern = rawPattern.trim();
  if (pattern === "" || pattern.startsWith("#")) return null;
  pattern = pattern.replace(/^!/, "");
  if (pattern === "") return null;

  const dirOnly = pattern.endsWith("/");
  if (dirOnly) pattern = pattern.slice(0, -1);
  if (pattern === "") return null;

  const anchored = pattern.startsWith("/") || /\/.+/.test(pattern.replace(/^\//, ""));
  let core = pattern.startsWith("/") ? pattern.slice(1) : pattern;

  const endsWithGlobstarSuffix = core.endsWith("/**");
  const body = translatePattern(core);
  const prefix = anchored ? "^" : "(?:^|/)";

  let fileRegex: RegExp | null = null;
  if (!dirOnly) {
    fileRegex = new RegExp(prefix + body + "$");
  } else {
    fileRegex = new RegExp(prefix + body + "/.+");
  }

  let dirBaseRegex: RegExp | null;
  if (dirOnly || endsWithGlobstarSuffix) {
    const stripped = dirOnly
      ? core
      : core.slice(0, -3);
    const strippedBody = translatePattern(stripped);
    const strippedAnchored = stripped.includes("/");
    const strippedPrefix = strippedAnchored ? "^" : "(?:^|/)";
    dirBaseRegex = new RegExp(strippedPrefix + strippedBody + "$");
    void body;
  } else {
    dirBaseRegex = new RegExp(prefix + body + "$");
  }

  return { pattern: rawPattern.trim(), fileRegex, dirBaseRegex };
}

export function parseIgnoreLines(lines: string[]): IgnoreRule[] {
  const rules: IgnoreRule[] = [];
  for (const line of lines) {
    const rule = compileRule(line);
    if (rule) rules.push(rule);
  }
  return rules;
}

export function loadIgnoreRules(vaultPath: string): IgnoreRule[] {
  const lines: string[] = [...ALWAYS_IGNORED];
  const brainignorePath = path.join(vaultPath, ".brainignore");
  if (existsSync(brainignorePath)) {
    try {
      const content = readFileSync(brainignorePath, "utf8");
      lines.push(...content.split(/\r?\n/));
    } catch {
      // unreadable .brainignore must not break indexing; defaults still apply
    }
  }
  return parseIgnoreLines(lines);
}

export function isIgnoredPath(
  relPath: string,
  isDir: boolean,
  rules: IgnoreRule[],
): boolean {
  const normalized = relPath.split("\\").join("/");
  for (const rule of rules) {
    if (isDir) {
      if (rule.dirBaseRegex?.test(normalized)) return true;
    } else if (rule.fileRegex?.test(normalized)) {
      return true;
    }
  }
  return false;
}
