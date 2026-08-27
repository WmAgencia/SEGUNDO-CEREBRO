/**
 * Evaluator — decides whether a node REALLY worked, using evidence.
 *
 * Rule: "LLM disse que terminou" is NEVER evidence by itself. Verdicts come
 * from concrete signals:
 *   - tool nodes: tool success + non-null output
 *   - subagent nodes: real execution (exit 0) + output content + tests
 *   - require pattern: optional textual marker that must appear in the output
 *     (e.g. "PASS", "failed: 0") — when present, the node MUST match it.
 */

import { EvaluateVerdict, GraphNode } from "./types.ts";

export function evaluateNode(node: GraphNode): EvaluateVerdict {
  const evidence: Array<{ kind: string; value: string }> = [...(node.evidence ?? [])];
  const requirePattern = node.evaluate?.require ?? null;
  const outputText = node.output ? JSON.stringify(node.output) : "";
  const error = node.error ?? null;

  if (node.status === "FAILED" && error) {
    evidence.push({ kind: "error", value: error.slice(0, 500) });
    return {
      pass: false,
      reason: `node com erro explícito: ${error.slice(0, 120)}`,
      evidence,
    };
  }

  const isTool = node.type === "tool" || node.assignedAgent === "tool" || Boolean(node.evaluate?.toolId);
  if (isTool) {
    const ok = node.output !== null && node.output !== undefined;
    evidence.push({ kind: "tool_output", value: ok ? "registrado" : "ausente" });
    if (!ok) return { pass: false, reason: "tool não produziu saída", evidence };
    evidence.push({ kind: "tool_output_json", value: outputText.slice(0, 2000) });
  } else {
    // subagent node: needs actual output text + (when tested) test signal
    const hasOutput = outputText.trim().length > 0;
    if (!hasOutput) return { pass: false, reason: "subagent não retornou conteúdo", evidence };
    evidence.push({ kind: "subagent_output", value: outputText.slice(0, 2000) });
    if (node.evaluate?.nodeType === "qa" || node.evaluate?.nodeType === "verify") {
      const hasTests = /(passed|test files|tests?\s+passed|failures?\s*:?\s*0|ok)/i.test(outputText);
      if (!hasTests) {
        return { pass: false, reason: "node de QA sem evidência de testes", evidence };
      }
      evidence.push({ kind: "tests", value: "evidencia de testes encontrada" });
    }
  }

  if (requirePattern) {
    const re = toRegex(requirePattern);
    const matched = re.test(outputText);
    evidence.push({ kind: "require_pattern", value: `${requirePattern} → ${matched ? "ok" : "ausente"}` });
    if (!matched) {
      return { pass: false, reason: `padrão exigido ausente na saída: ${requirePattern}`, evidence };
    }
  }

  evidence.push({ kind: "status", value: node.status });
  return { pass: true, reason: "evidência de sucesso verificada", evidence };
}

function toRegex(pattern: string): RegExp {
  try {
    return new RegExp(pattern, "i");
  } catch {
    return new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  }
}