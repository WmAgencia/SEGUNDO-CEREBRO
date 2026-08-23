const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/gsk_[A-Za-z0-9]{20,}/g, "[REDACTED_GROQ_KEY]"],
  [/sk-[A-Za-z0-9]{20,}/g, "[REDACTED_OPENAI_KEY]"],
  [/ghp_[A-Za-z0-9]{36,}/g, "[REDACTED_GITHUB_TOKEN]"],
  [/Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi, "Bearer [REDACTED]"],
  [/(api[_-]?key\s*[=:]\s*)["']?[^\s"',}]+/gi, "$1[REDACTED]"],
  [/(password|passwd|secret|token)\s*[=:]\s*["']?[^\s"',}]+/gi, "$1=[REDACTED]"],
];

export function redactSecrets(text: string): string {
  let out = text;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

export function redactDeep(value: unknown): unknown {
  if (typeof value === "string") return redactSecrets(value);
  if (Array.isArray(value)) return value.map(redactDeep);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = redactDeep(v);
    }
    return out;
  }
  return value;
}
