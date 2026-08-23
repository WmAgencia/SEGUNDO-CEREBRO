import { ValidationError } from "../errors/errors.ts";
import type { LLMProvider } from "./llm-provider.ts";

export const MEMORY_CATEGORIES = [
  "FACT",
  "DECISION",
  "IDEA",
  "PROCEDURE",
  "EVENT",
  "PREFERENCE",
  "HYPOTHESIS",
  "LESSON",
] as const;

export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];

export interface MemoryProposal {
  category: MemoryCategory;
  summary: string;
  confidence: number;
}

const SYSTEM_PROMPT = `Voce classifica trechos de texto para um sistema de memoria pessoal.
Responda SOMENTE com um objeto JSON valido, sem texto extra, no formato:
{"categoria":"FACT|DECISION|IDEA|PROCEDURE|EVENT|PREFERENCE|HYPOTHESIS|LESSON","resumo":"<frase curta em portugues>","confianca":0.0-1.0}
Definicoes:
FACT: fato objetivo sobre algo/alguem
DECISION: decisao tomada e sua justificativa
IDEA: ideia ou possibilidade futura
PROCEDURE: passo a passo / como fazer algo
EVENT: acontecimento com data/contexto
PREFERENCE: preferencia pessoal do usuario
HYPOTHESIS: hipotese ainda nao confirmada
LESSON: licao aprendida de erro ou experiencia`;

interface ExtractResult {
  proposals: MemoryProposal[];
  raw: string;
}

function parseProposals(content: string): MemoryProposal[] {
  const cleaned = content
    .replace(/<think>[\s\S]*?<\/think>/g, "")
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();

  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return [];
  }

  const list = Array.isArray(parsed) ? parsed : [parsed];
  const out: MemoryProposal[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const cat = String(rec.categoria ?? rec.category ?? "").toUpperCase();
    if (!MEMORY_CATEGORIES.includes(cat as MemoryCategory)) continue;
    const summary = String(rec.resumo ?? rec.summary ?? "").trim();
    if (summary === "") continue;
    const confRaw = Number(rec.confianca ?? rec.confidence ?? 0.7);
    out.push({
      category: cat as MemoryCategory,
      summary,
      confidence: Number.isFinite(confRaw) ? Math.min(1, Math.max(0, confRaw)) : 0.7,
    });
  }
  return out;
}

export async function extractMemoryProposals(
  provider: LLMProvider,
  text: string,
): Promise<ExtractResult> {
  if (!text || text.trim() === "") {
    throw new ValidationError("texto para extracao esta vazio");
  }
  const result = await provider.complete({
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: text.trim() },
    ],
    maxTokens: 400,
    temperature: 0.1,
    jsonMode: true,
  });
  return { proposals: parseProposals(result.content), raw: result.content };
}
