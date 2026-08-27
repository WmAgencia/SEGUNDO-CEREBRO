/**
 * Subagent definitions — the few REAL specialists the orchestrator uses.
 *
 * These map 1:1 to native OpenCode subagents declared in `.opencode/agents/`
 * (markdown frontmatter), invoked via `opencode run --agent <id>`. No fake
 * agents: if the subagent is unavailable, the node goes BLOCKED.
 *
 * Rule of the phase: no permanent army of agents. Only these five, and only
 * create more when there is proven need.
 */

export interface SubagentDef {
  id: string;
  role: string;
  description: string;
  prompt: string;
  readOnly: boolean;
}

export const SUBAGENTS: readonly SubagentDef[] = [
  {
    id: "researcher",
    role: "Pesquisa e investigação",
    description: "Investiga e reúne evidência (vault, web, docs, código).",
    readOnly: true,
    prompt: "Explore e investigue a fundo, reúna evidência e fontes. Não modifique arquivos. Responda com um relatório objetivo citando fontes.",
  },
  {
    id: "developer",
    role: "Implementação",
    description: "Implementa código, corrige bugs, integra serviços e valida com testes.",
    readOnly: false,
    prompt: "Implemente de forma real: edite arquivos, rode testes e valide. Ao final, relate arquivos alterados, comandos/testes executados e resultado com evidência.",
  },
  {
    id: "qa",
    role: "Testes e validação",
    description: "Roda testes e valida o resultado com evidência.",
    readOnly: false,
    prompt: "Valide com testes reais e evidência concreta (saídas de comando, arquivos, logs). Se algo falhar, descreva o que exatamente falhou e por quê. Não declare sucesso sem evidência.",
  },
  {
    id: "explorer",
    role: "Exploração read-only",
    description: "Explora um código/projeto sem alterar nada.",
    readOnly: true,
    prompt: "Explore e mapeie o código/projeto. Não faça alterações. Responda com um mapa objetivo de arquivos, funções e fluxos relevantes.",
  },
  {
    id: "reviewer",
    role: "Revisão",
    description: "Revisa código/resultados e aponta problemas.",
    readOnly: true,
    prompt: "Revise com foco em correção, segurança e clareza. Aponte problemas concretos com referência a arquivos/linhas. Não altere arquivos.",
  },
];

export function getSubagent(id: string): SubagentDef | undefined {
  return SUBAGENTS.find((s) => s.id === id);
}

export function isReadOnlySubagent(id: string): boolean {
  return getSubagent(id)?.readOnly ?? false;
}