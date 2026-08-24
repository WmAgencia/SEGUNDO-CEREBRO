import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import path from "node:path";
import type { BrainConfig } from "../config/loader.ts";
import type { GoalRecord } from "../goals/goal-engine.ts";
import type { InitiativeRecord } from "../goals/initiatives.ts";

export function persistGoalKnowledge(config: BrainConfig, goal: GoalRecord): string {
  const slug = goal.id.replace(/^goal\./, "").replace(/[^a-z0-9.-]/gi, "-").slice(0, 80);
  const directory = path.join(config.vaultPath, "08 - Goals", slug);
  const filePath = path.join(directory, "Goal.md");
  mkdirSync(directory, { recursive: true });
  if (!existsSync(filePath)) {
    writeFileSync(filePath, [
      "---", `type: goal`, `id: "${goal.id}"`, `status: "${goal.status}"`,
      "source: \"command-center\"", "privacy_scope: \"BUSINESS\"", `created_at: "${goal.createdAt}"`, "---", "",
      `# ${goal.name}`, "", goal.description || "Objetivo criado pelo Command Center.", "",
      "## Estado", `- **Status:** ${goal.status}`, `- **Prioridade:** ${goal.priority}`,
      `- **Prazo:** ${goal.deadline ?? "não definido"}`, `- **Progresso:** ${goal.progressPct ?? 0}%`, "",
      "## Provenance", "- **Origem:** Command Center do Second Brain HQ", `- **ID:** ${goal.id}`, `- **Atualizado:** ${goal.updatedAt}`,
      "",
    ].join("\n"), "utf8");
  }
  return path.relative(config.vaultPath, filePath).replaceAll("\\", "/");
}

export function persistInitiativeKnowledge(config: BrainConfig, goal: GoalRecord, initiative: InitiativeRecord, tasks: string[]): string {
  const slug = goal.id.replace(/^goal\./, "").replace(/[^a-z0-9.-]/gi, "-").slice(0, 80);
  const filePath = path.join(config.vaultPath, "08 - Goals", slug, "Initiatives.md");
  mkdirSync(path.dirname(filePath), { recursive: true });
  const section = [
    `## ${initiative.title}`, "", `- **Initiative ID:** ${initiative.id}`, `- **Goal ID:** ${goal.id}`,
    "- **Source:** Command Center", "- **Privacy:** BUSINESS", "", "### Tasks",
    ...tasks.map((task, index) => `${index + 1}. ${task}`), "",
  ].join("\n");
  if (!existsSync(filePath)) writeFileSync(filePath, ["---", "type: initiatives", `goal_id: "${goal.id}"`, "source: \"command-center\"", "privacy_scope: \"BUSINESS\"", "---", "", `# Initiatives — ${goal.name}`, "", section].join("\n"), "utf8");
  else {
    const current = requireRead(filePath);
    if (!current.includes(`- **Initiative ID:** ${initiative.id}`)) writeFileSync(filePath, `${current.trimEnd()}\n\n${section}\n`, "utf8");
  }
  return path.relative(config.vaultPath, filePath).replaceAll("\\", "/");
}

function requireRead(filePath: string): string {
  // Kept local to preserve the existing safe, explicit write boundary.
  return readFileSync(filePath, "utf8");
}
