import { mkdirSync, appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { BrainConfig } from "../config/loader.ts";

/**
 * Persists Manager conversations as navigable human Markdown in Obsidian.
 * One note per session per day under 08 - Context/Conversations/.
 * Append-only: entries are never rewritten (history preservation).
 */
export function persistConversationNote(
  config: BrainConfig,
  sessionKey: string,
  entry: { role: "user" | "manager"; text: string; mode?: string; topic?: string | null },
): string {
  const dir = path.join(config.vaultPath, "08 - Context", "Conversations");
  const day = new Date().toISOString().slice(0, 10);
  const safeSession = sessionKey.replace(/[^a-z0-9._-]/gi, "-").slice(0, 60) || "default";
  const filePath = path.join(dir, `${safeSession}--${day}.md`);
  mkdirSync(dir, { recursive: true });

  const time = new Date().toISOString().slice(11, 19);
  const label = entry.role === "user" ? "**Wesley**" : "**Gerente**";
  const body = `### ${time} — ${label}${entry.mode ? ` _(modo ${entry.mode})_` : ""}\n\n${entry.text.trim()}\n`;

  if (!existsSync(filePath)) {
    writeFileSync(
      filePath,
      [
        "---",
        'type: conversation',
        `id: "conversation.${safeSession}.${day}"`,
        `created_at: "${new Date().toISOString()}"`,
        `updated_at: "${new Date().toISOString()}"`,
        `session_key: "${sessionKey}"`,
        'source: "command-center"',
        'provenance: "manager-chat"',
        ...(entry.topic ? [`topic: "${entry.topic.replace(/"/g, "'")}"`] : []),
        "---",
        "",
        `# Conversa — ${safeSession} — ${day}`,
        "",
        body,
      ].join("\n"),
      "utf8",
    );
  } else {
    appendFileSync(filePath, `\n${body}`, "utf8");
    touchUpdatedAt(filePath);
  }
  return path.relative(config.vaultPath, filePath).replaceAll("\\", "/");
}

/** Append a decision record to the Obsidian decisions context folder. */
export function persistDecisionNote(
  config: BrainConfig,
  decision: {
    question: string;
    selectedOption: string;
    reasons: string[];
    relatedGoal?: string;
    relatedInitiative?: string;
  },
): string {
  const dir = path.join(config.vaultPath, "08 - Context", "Decisions");
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const slug = decision.question.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50) || "decisao";
  const filePath = path.join(dir, `${stamp}--${slug}.md`);
  writeFileSync(
    filePath,
    [
      "---",
      "type: decision",
      `id: "decision.${stamp}.${slug.slice(0, 20)}"`,
      `created_at: "${new Date().toISOString()}"`,
      `updated_at: "${new Date().toISOString()}"`,
      'source: "command-center"',
      'provenance: "manager-conversation"',
      ...(decision.relatedGoal ? [`related_goal: "${decision.relatedGoal}"`] : []),
      ...(decision.relatedInitiative ? [`related_initiative: "${decision.relatedInitiative}"`] : []),
      "---",
      "",
      "# Decisão",
      "",
      `## Pergunta`,
      decision.question,
      "",
      `## Escolha`,
      decision.selectedOption,
      "",
      `## Motivos`,
      ...decision.reasons.map((r) => `- ${r}`),
      "",
    ].join("\n"),
    "utf8",
  );
  return path.relative(config.vaultPath, filePath).replaceAll("\\", "/");
}

function touchUpdatedAt(filePath: string): void {
  try {
    const content = readFileSync(filePath, "utf8");
    const updated = content.replace(
      /^updated_at: ".*"$/m,
      `updated_at: "${new Date().toISOString()}"`,
    );
    if (updated !== content) writeFileSync(filePath, updated, "utf8");
  } catch {}
}
