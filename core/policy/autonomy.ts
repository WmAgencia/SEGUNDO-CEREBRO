export type AutonomyLevel = "MANUAL" | "ASSISTED" | "SUPERVISED" | "AUTONOMOUS";
export type RiskCategory = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

const RISK_ORDER: Record<RiskCategory, number> = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 };
const AUTONOMY_ORDER: Record<AutonomyLevel, number> = { MANUAL: 0, ASSISTED: 1, SUPERVISED: 2, AUTONOMOUS: 3 };

export interface ActionPolicy {
  actionType: string;
  riskLevel: RiskCategory;
  autonomyLevel: AutonomyLevel;
  requiresApproval: boolean;
  allowedAgents: string[];
  allowedProjects: string[];
  allowedTools: string[];
  maxCost: number;
  maxDurationMs: number;
  maxRetries: number;
  allowedHours?: [number, number];
  constraints: string[];
}

export interface AgentBoundaries {
  agentId: string;
  allowedTools: string[];
  allowedActions: string[];
  maxCost: number;
  maxDurationMs: number;
  maxTasks: number;
  maxRetries: number;
  allowedProjects: string[];
}

export interface PolicyEvaluation {
  decision: "ALLOWED" | "REQUIRES_APPROVAL" | "DENIED";
  level: AutonomyLevel;
  reasons: string[];
}

export function evaluateAutonomy(
  policy: ActionPolicy,
  agentBoundaries: Partial<AgentBoundaries>,
): PolicyEvaluation {
  const reasons: string[] = [];

  const effectiveLevel = resolveEffectiveLevel(policy.autonomyLevel, agentBoundaries);

  if (RISK_ORDER[policy.riskLevel] >= RISK_ORDER.HIGH && effectiveLevel !== "AUTONOMOUS") {
    reasons.push(`risco ${policy.riskLevel} requer aprovação humana`);
    return { decision: "REQUIRES_APPROVAL", level: effectiveLevel, reasons };
  }

  if (effectiveLevel === "MANUAL") {
    reasons.push("autonomia MANUAL — humano necessário");
    return { decision: "REQUIRES_APPROVAL", level: effectiveLevel, reasons };
  }

  if (agentBoundaries.allowedTools?.length && !agentBoundaries.allowedTools.includes("*")) {
    const toolAllowed = policy.allowedTools.length === 0 ||
      policy.allowedTools.some((t) => agentBoundaries.allowedTools!.includes(t));
    if (!toolAllowed) {
      reasons.push("tool fora dos limites do agente");
      return { decision: "DENIED", level: effectiveLevel, reasons };
    }
  }

  if (agentBoundaries.allowedProjects?.length) {
    if (!agentBoundaries.allowedProjects.includes("*")) {
      reasons.push("projeto dentro dos autorizados");
    }
  }

  if (policy.maxCost > 0) {
    reasons.push(`custo máximo $${policy.maxCost}`);
  }

  reasons.push(`autonomia ${effectiveLevel}`);
  return { decision: "ALLOWED", level: effectiveLevel, reasons };
}

function resolveEffectiveLevel(
  policyLevel: AutonomyLevel,
  boundaries: Partial<AgentBoundaries>,
): AutonomyLevel {
  return policyLevel;
}

export function canExecuteAtRisk(
  autonomy: AutonomyLevel,
  risk: RiskCategory,
): boolean {
  const auto = AUTONOMY_ORDER[autonomy];
  const needed = RISK_ORDER[risk] <= 0 ? 3 : RISK_ORDER[risk] <= 1 ? 2 : 0;
  return auto >= needed;
}
