import { DatabaseSync } from "node:sqlite";
import { ValidationError } from "../errors/errors.ts";

export type RiskLevel = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export interface PolicyCheck {
  decision: "ALLOWED" | "BLOCKED" | "REQUIRES_APPROVAL";
  risk: RiskLevel;
  reasons: string[];
}

export function classifyRisk(category: string, permissions: string[]): RiskLevel {
  const perms = permissions.map((p) => p.toUpperCase());
  if (perms.includes("ADMIN") || perms.includes("DELETE")) return "CRITICAL";
  if (category === "external" || category === "whatsapp" || category === "ads") return "HIGH";
  if (perms.includes("WRITE") || perms.includes("EXECUTE") || category === "automation") return "MEDIUM";
  return "LOW";
}

export interface PolicyInput {
  agentId: string;
  toolId: string;
  taskId?: number;
  initiativeId?: string;
  projectId?: string;
}

export function evaluatePolicy(
  db: DatabaseSync,
  input: PolicyInput,
): PolicyCheck {
  const reasons: string[] = [];

  const agent = db
    .prepare("SELECT status, permissions FROM agents WHERE id = ?")
    .get(input.agentId) as { status: string; permissions: string } | undefined;
  if (!agent) {
    return { decision: "BLOCKED", risk: "LOW", reasons: [`agente não encontrado: ${input.agentId}`] };
  }
  const agentPerms = parseList(agent.permissions);

  if (input.initiativeId) {
    const init = db
      .prepare("SELECT status FROM initiatives WHERE id = ?")
      .get(input.initiativeId) as { status: string } | undefined;
    if (!init) {
      return { decision: "BLOCKED", risk: "LOW", reasons: ["iniciativa não encontrada"] };
    }
    if (!["APPROVED", "RUNNING"].includes(init.status)) {
      return { decision: "BLOCKED", risk: "LOW", reasons: [`iniciativa ${init.status} — apenas APPROVED/RUNNING executam`] };
    }
    reasons.push("iniciativa aprovada");
  }

  const tool = db
    .prepare("SELECT * FROM tools_registry WHERE id = ?")
    .get(input.toolId) as
    | { category: string; permissions: string; available: number; risk: string | null }
    | undefined;
  if (!tool) {
    return { decision: "BLOCKED", risk: "LOW", reasons: [`tool não registrada: ${input.toolId}`] };
  }
  if (!tool.available) {
    return { decision: "BLOCKED", risk: "LOW", reasons: [`tool indisponível`] };
  }

  const risk = classifyRisk(tool.category, parseList(tool.permissions));
  const requiredPerm = riskToPermission(risk);
  const hasPerm = agentPerms.includes("*") || agentPerms.includes(requiredPerm);
  if (!hasPerm) {
    return {
      decision: "BLOCKED",
      risk,
      reasons: [`agente sem permissão "${requiredPerm}" para risco ${risk}`],
    };
  }
  reasons.push(`permissão ${requiredPerm} ok`);

  if (risk === "HIGH" || risk === "CRITICAL") {
    reasons.push(`risco ${risk} requer aprovação humana`);
    return { decision: "REQUIRES_APPROVAL", risk, reasons };
  }

  reasons.push("política de execução satisfeita");
  return { decision: "ALLOWED", risk, reasons };
}

function riskToPermission(risk: RiskLevel): string {
  switch (risk) {
    case "LOW": return "READ";
    case "MEDIUM": return "WRITE";
    case "HIGH": return "EXECUTE";
    case "CRITICAL": return "ADMIN";
  }
}

function parseList(raw: string): string[] {
  try {
    const p = JSON.parse(raw);
    return Array.isArray(p) ? p.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}
