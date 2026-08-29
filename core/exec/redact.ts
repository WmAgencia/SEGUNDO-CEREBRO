/**
 * Secret redaction - removes sensitive patterns (API keys, tokens) from text
 * Used to prevent leaking credentials in messages, logs, or responses.
 */

const REDACTION_PATTERNS: Array<{ pattern: RegExp; replacement: string; label: string }> = [
  // Groq keys
  { pattern: /gsk_[A-Za-z0-9]{20,}/g, replacement: '[REDACTED:gsk]', label: 'groq_key' },
  // Anthropic keys (sk-ant-, sk-nx-, etc.)
  { pattern: /sk-ant-[A-Za-z0-9_-]{16,}/g, replacement: '[REDACTED:sk-ant]', label: 'anthropic_key' },
  { pattern: /sk-nx-[A-Za-z0-9]{20,}/g, replacement: '[REDACTED:sk-nx]', label: 'nexxus_key' },
  // OpenAI keys
  { pattern: /sk-[A-Za-z0-9_-]{20,}T3BlbkFJ[A-Za-z0-9_-]{20,}/g, replacement: '[REDACTED:openai]', label: 'openai_key' },
  // OpenRouter
  { pattern: /sk-or-v1-[A-Za-z0-9]{20,}/g, replacement: '[REDACTED:openrouter]', label: 'openrouter_key' },
  // HuggingFace
  { pattern: /hf_[A-Za-z0-9]{20,}/g, replacement: '[REDACTED:huggingface]', label: 'huggingface_key' },
  // GitHub tokens
  { pattern: /ghp_[A-Za-z0-9]{20,}/g, replacement: '[REDACTED:github]', label: 'github_token' },
  { pattern: /gho_[A-Za-z0-9]{20,}/g, replacement: '[REDACTED:github]', label: 'github_oauth' },
  { pattern: /ghu_[A-Za-z0-9]{20,}/g, replacement: '[REDACTED:github]', label: 'github_user' },
  { pattern: /ghs_[A-Za-z0-9]{20,}/g, replacement: '[REDACTED:github]', label: 'github_server' },
  { pattern: /ghr_[A-Za-z0-9]{20,}/g, replacement: '[REDACTED:github]', label: 'github_refresh' },
  // Bearer tokens (generic)
  { pattern: /Bearer\s+[A-Za-z0-9_.\-]{20,}/gi, replacement: 'Bearer [REDACTED]', label: 'bearer_token' },
  // Email-like patterns with credentials (user:pass@)
  { pattern: /([a-zA-Z0-9._%+-]+):([a-zA-Z0-9._%+-]+)@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, replacement: '[REDACTED:credentials]', label: 'email_credentials' },
  // AWS keys
  { pattern: /AKIA[0-9A-Z]{16}/g, replacement: '[REDACTED:aws]', label: 'aws_access_key' },
  // Google API keys
  { pattern: /AIza[0-9A-Za-z_-]{35}/g, replacement: '[REDACTED:google]', label: 'google_api_key' },
  // Stripe
  { pattern: /sk_live_[A-Za-z0-9]{24,}/g, replacement: '[REDACTED:stripe]', label: 'stripe_secret' },
  { pattern: /pk_live_[A-Za-z0-9]{24,}/g, replacement: '[REDACTED:stripe]', label: 'stripe_public' },
  // JWT (basic detection)
  { pattern: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, replacement: '[REDACTED:jwt]', label: 'jwt_token' },
];

export interface RedactionResult {
  text: string;
  redactions: Array<{ pattern: string; count: number; position: number }>;
  redactionCount: number;
  wasModified: boolean;
}

export function redactSecrets(text: string): string {
  if (!text || typeof text !== 'string') return text;

  let result = text;
  for (const { pattern, replacement } of REDACTION_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

export function redactWithDetails(text: string): RedactionResult {
  if (!text || typeof text !== 'string') {
    return { text, redactions: [], redactionCount: 0, wasModified: false };
  }

  let result = text;
  const redactions: Array<{ pattern: string; count: number; position: number }> = [];
  let totalCount = 0;

  for (const { pattern, replacement, label } of REDACTION_PATTERNS) {
    const matches = [...text.matchAll(pattern)];
    if (matches.length > 0) {
      redactions.push({
        pattern: label,
        count: matches.length,
        position: matches[0]?.index ?? 0,
      });
      totalCount += matches.length;
      result = result.replace(pattern, replacement);
    }
  }

  return {
    text: result,
    redactions,
    redactionCount: totalCount,
    wasModified: totalCount > 0,
  };
}

/**
 * Check if text contains any secrets (without modifying it).
 * Useful for warning users before they share sensitive info.
 */
export function containsSecrets(text: string): boolean {
  if (!text) return false;
  return REDACTION_PATTERNS.some(({ pattern }) => pattern.test(text));
}

/**
 * List all secret types that would be detected.
 */
export function listSecretPatterns(): string[] {
  return REDACTION_PATTERNS.map(({ label }) => label);
}