# LANGCHAIN/LANGGRAPH EVALUATION

## Decisão
**NÃO integrado.** A arquitetura atual já implementa o que LangGraph ofereceria, sem o custo
de dependência e complexidade de runtime. Adicionar LangChain/LangGraph seria **paralelizar**
o que já funciona.

## Comparação objetiva

| Critério | Implementação atual | LangChain/LangGraph |
|---|---|---|
| Supervisor + subagentes | Gerente (`manager.ts`) + delegacao via `agent-os.ts`, `runInitiativeParallel` | `createSupervisor`, subagents |
| Tool orchestration | `tools/tool-registry` + `exec/execution-engine` + policy | ToolNode |
| Tool routing dinâmico | `classifyCreativeIntent` (determinístico, testado) | LLM tool-calling |
| Checkpointing | `agent_runs` + `agent_checkpoints` + heartbeat + orphan recovery | checkpointer |
| Persistência | SQLite + Obsidian (provenance) | BaseCheckpointSaver |
| Stream/SSE | `event-bus.ts` + `/api/hq/events` (eventos reais) | LangGraph streaming |
| Ciclo rework/avaliação | `submitResult` + `MAX_RETRIES` + reviewer independente | Graph retries |
| Observabilidade | `model_generations`, logs, eventos | callbacks |

## Onde LangGraph PODERIA agregar (sem vantagem comprovada aqui)
- **Estrutura de grafo explícito** p/ fluxos muito condicionais — nosso caso é linear o suficiente.
- **Human-in-the-loop nativo** — já temos Approval Gate + approvals em SQLite.

## Custo de integrar
- Nova dependência Python/JS pesada (LangGraph + deps) — **conflito com disco limitado** e stack
  atual TypeScript/SQLite/zero-cloud.
- Modelo mental novo p/ devs; reimplementação de supervisor/checkpoint que já existem.
- Sem retorno garantido: os testes reais de supervisor subagent já passam sem isso.

## Recomendação
Manter a arquitetura atual. **Revisitar LangGraph apenas se** surgir um fluxo com >5 ramos
condicionais concorrentes ou se precisarmos de checkpoint distribuído multi-runtime — nem um nem
outro existe hoje. Dependência só quando houver ganho comprovado, não por moda.
