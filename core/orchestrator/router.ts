export type Intent = "general" | "relationship" | "history" | "concept" | "procedure";

export interface RoutePlan {
  intent: Intent;
  useSearch: boolean;
  useGraph: boolean;
  useTimeline: boolean;
  typeFilters: string[];
}

interface Rule {
  intent: Intent;
  patterns: RegExp[];
  plan: Omit<RoutePlan, "intent">;
}

const RULES: readonly Rule[] = [
  {
    intent: "history",
    patterns: [
      /\bhistor(i|o)co?\b/i,
      /\bhist(ó|o)ria\b/i,
      /\btimeline\b/i,
      /\bevolu(ç|c)(ã|a)o\b/i,
      /\bquando\b/i,
      /\bdecis(õ|o)es?\b/i,
      /\bdecis(ã|a)o\b/i,
      /\bmudan(ç|c)as?\b/i,
    ],
    plan: { useSearch: true, useGraph: false, useTimeline: true, typeFilters: ["decision"] },
  },
  {
    intent: "procedure",
    patterns: [
      /\bcomo (fazer|faz|implantar|instalar|configurar|deploy)\b/i,
      /\bprocedimento\b/i,
      /\bpassos?\b/i,
      /\bpasso a passo\b/i,
      /\btutorial\b/i,
      /\bdeploy\b/i,
      /\broteiro\b/i,
    ],
    plan: { useSearch: true, useGraph: true, useTimeline: false, typeFilters: ["procedure"] },
  },
  {
    intent: "relationship",
    patterns: [
      /\brelacionad(o|a|os|as)\b/i,
      /\bconectad(o|a|os|as)\b/i,
      /\bligad(o|a|os|as)\b/i,
      /\bgrafo\b/i,
      /\bdepend(e|ê)ncia|\bdepende\b/i,
      /\busa(m)?\b/i,
      /\bquem (trabalha|participa)\b/i,
      /\bvínculo|vinculo\b/i,
    ],
    plan: { useSearch: false, useGraph: true, useTimeline: false, typeFilters: [] },
  },
  {
    intent: "concept",
    patterns: [
      /\bo que (é|e)\s/i,
      /\bsignifica\b/i,
      /\bconceito\b/i,
      /\bdefini(ç|c)(ã|a)o\b/i,
      /\bexplique\b/i,
    ],
    plan: { useSearch: true, useGraph: false, useTimeline: false, typeFilters: ["knowledge", "concept"] },
  },
];

export function routeQuery(query: string): RoutePlan {
  for (const rule of RULES) {
    if (rule.patterns.some((p) => p.test(query))) {
      return { intent: rule.intent, ...rule.plan };
    }
  }
  return {
    intent: "general",
    useSearch: true,
    useGraph: false,
    useTimeline: false,
    typeFilters: [],
  };
}
