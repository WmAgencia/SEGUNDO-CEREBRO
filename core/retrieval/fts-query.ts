import { ValidationError } from "../errors/errors.ts";

const TOKEN_RE = /[\p{L}\p{N}_]+/gu;

export interface SanitizedQuery {
  andQuery: string;
  orQuery: string;
  tokens: string[];
}

export function sanitizeFtsQuery(input: string): SanitizedQuery {
  if (typeof input !== "string" || input.trim() === "") {
    throw new ValidationError("search query is empty");
  }

  const rawTokens = input.match(TOKEN_RE) ?? [];
  const tokens = [
    ...new Set(
      rawTokens
        .map((t) => t.replace(/["'()*:^{}[\]]/g, "").trim())
        .filter((t) => t.length > 0),
    ),
  ];

  if (tokens.length === 0) {
    throw new ValidationError("search query has no searchable terms", {
      input,
    });
  }

  const phrases = tokens.map((t) => `"${t}"*`);
  return {
    andQuery: phrases.join(" AND "),
    orQuery: phrases.join(" OR "),
    tokens,
  };
}
