# Graph Orchestration — Arquitetura

**FASE 3.5** — O Single Agent evolui para um verdadeiro ORCHESTRATOR capaz de identificar solicitações complexas, criar planos em forma de DAG, executar tarefas em paralelo com subagents reais do OpenCode, avaliar resultados com evidência e aplicar rework limitado.

---

## Princípios inegociáveis

1. **Uma IA na superfície.** O usuário fala apenas com o Single Agent. Ele decide quando usar ferramentas simples ou um Graph. Não há "gerente", "coordenador" ou outros agentes permanentes visíveis.

2. **Simples = direto.** Saudações, consultas únicas (status do WhatsApp, brain_search) vão direto ao ponto via ferramenta. Sem Graph desnecessário.

3. **Complexo = Graph.** Trabalhos multi-etapas ("colocar X funcionando", "criar sistema") geram um plano → Graph → execução autônoma avaliada por evidência.

4. **Nunca simular sucesso.** "LLM disse que terminou" NUNCA é evidência. O evaluator só aprova com sinais concretos: tool output presente, testes passando, logs verificáveis.

5. **Segurança antes de autonomia.** Toda ação de risco passa pelo Approval Gate. O Graph Execute exige aprovação explícita. O executor nunca executa silenciosamente.

6. **Banco ≠ Obsidian.** Banco SQLite = estado operacional (runs, graph_nodes, sessions, tool_calls, events). Obsidian Vault = memória de longo prazo. Nunca usar Obsidian como banco operacional.

---

## Arquitetura interna

```
USER
 ↓
Single Agent / Orchestrator (conversa natural, português)
 ↓
Context Compiler (contexto sob demanda: entity + memory + agenda + goals)
 ↓
DECISÃO
 ├── SIMPLE RESPONSE     → LLM responde direto (greetings, consulta única)
 ├── TOOL                → ToolExecutor roda a ferramenta real
 └── GRAPH               → Planner gera DAG → Graph Store persiste → Executor roda
      ↓
   EXECUTION (em waves de até MAX_PARALLEL_NODES)
      ↓
   EVALUATOR (verdict PASS/FAIL baseado em evidência)
      ↓
   COMPLETE / REWORK (até max_retries, depois BLOCKED)
```

## Fluxo de conversa típico

### Simples

```
Usuário: "Oi"
→ Agent: "Oi! Estou aqui. O que você quer fazer?"

Usuário: "Qual o status do whatsapp?"
→ graph_plan retorna {graph: false}
→ agent chama whatsapp_status → responde
```

### Multi-etapas (Graph)

```
Usuário: "Quero colocar o ClipCom completamente funcional."
→ Agent classifica como GRAPH
→ Agent roda graph_plan → cria run + nodes no banco (PLANNED)
→ Agent devolve plano ao usuário:
  "Plano criado com 6 nós: Audit → Identify → Architecture → Implementation → QA → Verify. Quer que eu execute?"

Usuário: "Sim" / "Pode mandar"
→ Agent roda graph_execute (HIGH risk → approval gate)
→ Executor: roda em waves, avalia cada nó, reaplica rework se necessário
→ Agent devolve resultado final com evidência
```

## Modelos de plano (determinísticos)

O planner é regido por heurísticas determinísticas. Nenhum LLM inventa a estrutura do DAG.

| Solicitação detectada              | Nós gerados                                        | Notas                                   |
|------------------------------------|-----------------------------------------------------|-----------------------------------------|
| "funciona(ndo)/l)", "arrumar"...   | Audit → Identify → Arch → Implement → QA → Verify  | Rebuild genérico                        |
| "sistema de prospecção"            | Research → Design || Arch → Impl → Integ → QA → Deploy | Paralelo: design e arch independentes |
| "geração de vídeo"                 | Research → Arch → Impl → Integ → QA → Deploy        |                                         |

Cada nó carrega: `id`, `type`, `title`, `description`, `dependencies`, `assignedAgent`, `input`. Os deps são resolvidos por título/id pelo GraphStore.

## Subagents reais

Não criamos dezenas de agentes permanentes. Usamos as primitivas nativas do OpenCode:

| Agente    | Papel                         | ReadOnly? | Permissões                    |
|-----------|-------------------------------|-----------|-------------------------------|
| researcher| Pesquisa e investigação       | ✅         | read, webfetch, websearch     |
| developer | Implementação real            | ❌         | edit, bash, read, grep, glob  |
| qa        | Testes e validação            | ❌         | edit, bash, read              |
| explorer  | Exploração read-only          | ✅         | read, grep, glob, list        |
| reviewer  | Revisão de código/resultados  | ✅         | read, grep, glob, bash(git)   |

São declarados como `.opencode/agents/*.md` (markdown), invocados via `opencode run --agent <id> "task"`. Se o CLI não estiver disponível no ambiente, o nó fica BLOCKED.

## Ferramentas de Graph

As ferramentas são expostas ao Single Agent via ToolRegistry:

- **`graph_plan`** — Cria DAG para trabalho complexo. READ. Sem approval. Retorna `{runId, totalNodes, readable}`.
- **`graph_execute`** — Executa o run. HIGH risk → approval gate. Usa GraphExecutor com OpenCodeSubagentRunner. Avalia cada nó com evidência. Aplica rework até `maxRetries`.
- **`graph_status`** — Progresso legível: status, nós, bloqueios. READ.
- **`graph_list`** — Lista runs da sessão. READ.
- **`graph_recover`** — Detecta e bloqueia runs stale. Safe-by-default, nunca resume sozinho.

## Evaluator

Decisão por evidência concreta. Regras:

| Tipo     | Critério de PASS                                          | Critério de FAIL                      |
|----------|-----------------------------------------------------------|---------------------------------------|
| tool     | success=true && output != null                            | output=null, error!=null              |
| subagent | saída presente + sinal de teste (pass/fail count)         | sem saída, sem testes, erro           |
| require  | padrão textual obrigatório encontrado na saída             | padrão ausente                        |

Se falhar e `retry_count < maxRetries` → estado REWORK (nó repete). Se ultrapassar → estado FAILED.

## Rework loop

```
EXECUTE → EVALUATE → (FAIL?) → retry_count++ → EXECUTE → EVALUATE → ...
                                                ↓ >= maxRetries
                                            FAILED (BLOCKED)
```

Limites configuráveis via variáveis de ambiente:
- `MAX_PARALLEL_NODES` (default: 2)
- `GRAPH_MAX_RETRIES` (default: 2)
- `GRAPH_MAX_ITERATIONS` (default: 3)
- `GRAPH_STALE_AFTER_MS` (default: 30 min)
- `OPENCODE_TIMEOUT_MS` (default: 300 s)

## Observabilidade

Toda transição de nó é registrada na tabela `events` (event_type=`graph_node`). Para responder:

> "O que está sendo feito agora?" → `graph_status --status <runId>` ou ferramenta `graph_status` do agent.

> "Por que está fazendo isso?" → contexto compilado (summary, docs, eventos) é injetado no prompt do LLM. O planner declara *por que* aquele nó existe.

> "Qual foi o resultado?" → evaluatorEvidence (`evidence_json`) + tool output/output_text.

## Recovery

Se um processo morre enquanto executando, a próxima inicialização detecta runs stale:

1. `detectStaleRuns()` busca runs PLANNED/RUNNING sem atualização há > STALE_THRESHOLD.
2. `recoverStaleRuns()` marca todos os nós RUNNING/PENDING/REWORK como BLOCKED e o run como BLOCKED.
3. Run concluído automaticamente no startup — SEM auto-resume de trabalho arriscado.

Chamado via: `brain graph --recover` ou `graph_recover` tool.

## Deduplicação de entidades

Regra fundamental:

```
SEARCH EXISTING (resolverEntity: id → alias → name → prefix → FTS)
      ↓
FOUND? (confidence ≥ 0.7)
 YES
  ├─ Atualiza canonical_name/aliases/metadata
  └─ Retém entity_id original
 NO
  └─ CRIA nova entidade (stable id: type.slug)
```

Impossível ter "Derek", "Derek 2", "Derek novo" para a mesma pessoa. A função `resolveOrCreateEntity(db, input)` garante essa propriedade estruturalmente.

---

## Estado atual

- Schema v23 com `graph_runs` + `graph_nodes`
- Planner determinístico (SIMPLE/TOOL/PLAN/GRAPH classification)
- DAG validator (cycles, unknown deps, self-dep, duplicates)
- Scheduler (readiness + parallelism respecta MAX_PARALLEL_NODES)
- Evaluator (evidence-based per node)
- Rework (retry_count, maxIterations cap)
- Recovery (stale runs blocked on start)
- OpenCode integration (real CLI invocation via `opencode run --agent`)
- 5 subagents definidos em `.opencode/agents/*.md`
- 5 ferramentas de Graph registradas
- Auditoria vault (read-only): duplicatas, vazios, órfãos, links quebrados
- Entity dedup resolver (SEARCH→UPDATE vs CREATE)
- 444+ testes passando
- Typecheck limpo