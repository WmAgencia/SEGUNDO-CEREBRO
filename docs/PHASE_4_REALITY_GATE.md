# FASE 4 — OpenCode Graph Runtime REAL + Operação E2E (Reality Gate)

Data: 2026-08-27 · Branch `main`
Princípio: reutilizar a arquitetura existente (Single Agent → Graph → OpenCode →
Evaluator → Obsidian). Nenhuma arquitetura paralela criada.

---

## 1. Auditoria (o que já existia e foi reutilizado)

| Etapa do fluxo | Componente existente | Ação na FASE 4 |
|---|---|---|
| SingleAgent | `core/agent/single-agent.ts` | reutilizado (ganhou `onEvent` na FASE 3.7) |
| ContextCompiler | `core/agent/context-compiler.ts` | reutilizado |
| ToolRegistry/Executor | `core/agent/tools/*` | reutilizado |
| GraphPlanner | `core/orchestration/planner.ts` | reutilizado |
| Graph/DAG | `graph-store.ts`, `graph-validator.ts` | reutilizado |
| Scheduler | `scheduler.ts` | reutilizado |
| OpenCode Runner | `subagents/opencode-runner.ts` | **corrigido** (resolve cmd + parsing honesto) |
| Subagents | `.opencode/agents/*.md`, `agents.ts` | **corrigidos** (`mode: all`) + `verifier` |
| Evaluator | `evaluator.ts` | reutilizado (`requireCount`) |
| Rework/Retry | `executor.ts` | reutilizado |
| Recovery | `recovery.ts` | reutilizado (`prepareResume`) |
| Evidence | `graph_nodes.evidence_json` | reutilizado |
| Obsidian | `organization/graph-obsidian.ts` | reutilizado |

Nenhum componente duplicado. As únicas mudanças foram correções reais no runner
OpenCode e nos agentes (que estavam com bug/encoding), e enriquecimento de
contexto por nó.

---

## 2. Correções reais aplicadas

1. **`resolveOpenCodeCommand`** (`opencode-runner.ts`): retornava
   `node_modules/.bin/opencode.cmd` sem checar existência — mas o OpenCode está
   instalado **global** (`opencode` no PATH). `isAvailable()` voltava `false` e o
   runner nunca invocava o OpenCode de verdade. Corrigido para preferir binário
   local existente e senão resolver via PATH. **Agora o OpenCode é realmente invocado.**

2. **Parsing honesto** (`parseOpenCodeOutput`): o OpenCode pode **sair com código 0
   mesmo quando o LLM estoura capacidade** (evento `type:"error"`). Antes isso
   viraria "sucesso". Agora: só é `COMPLETED` se houver texto real de resposta;
   erro de LLM/capacidade/timeout vira `FAILED` com evidência. **Nunca sucesso falso.**

3. **Agentes do graph** (`.opencode/agents/*.md`): eram `mode: subagent` (por isso o
   OpenCode fazia fallback para o agente default) e tinham encoding corrompido.
   Passaram a `mode: all` (invocáveis pelo graph via `opencode run --agent <id>` e
   ainda usáveis como subagent), encoding UTF-8 limpa. Adicionado `verifier`
   (verificação final ponta a ponta). Papéis: researcher, developer, reviewer,
   verifier, qa, explorer. **O ORCHESTRADOR é o próprio Graph Engine (determinístico) —
   não é um agente LLM** (evita agente artificial).

4. **Contexto por nó sob demanda** (`collectDependencyResults`): cada nó recebe o
   resultado dos nós de dependência já concluídos (não o vault inteiro), com
   provenance do próprio grafo.

5. **Modelo configurável**: runner lê `opts.model` → `SECOND_BRAIN_GRAPH_MODEL` →
   default. Nunca hardcoded.

6. **Observabilidade**: `GET /api/graphs/:runId`, `/:runId/nodes`, `/:runId/events`
   agora expõem `agentId`, `sessionId`, `attempt`, `durationMs`, `startedAt`,
   `completedAt`, `evidence`, `output`.

---

## 3. Descoberta crítica do ambiente (bloqueio externo, não de código)

Execução real de subagentes OpenCode exige um LLM com capacidade para o contexto
do agente. Medido de verdade neste ambiente:

| Provider | Situação real medida |
|---|---|
| Groq (5 chaves preenchidas) | Free tier **8k TPM**; o contexto mínimo do OpenCode (sem tools, sem MCP) pede **~38k tokens** → `ContextOverflowError`. Bloqueado por capacidade. |
| OpenRouter | Chave presente porém **sem créditos** (`can only afford 221` tokens). Bloqueado. |
| Anthropic / OpenAI / agentrouter | Sem chave configurada. |

**Conclusão honesta:** o runtime OpenCode está correto e é realmente invocado
(cria sessão, emite eventos JSON), mas a **conclusão** de tarefas por subagente
depende de créditos/capacidade de LLM que este ambiente não tem. Isso é BLOCKED
por fator externo — não há código que contorne. O runner reporta FAILED/BLOCKED
com evidência (nunca sucesso falso).

Para desbloquear: adicionar créditos OpenRouter **ou** chave Groq com tier
superior, e definir `SECOND_BRAIN_GRAPH_MODEL`.

---

## 4. Tabela Reality Gate (status final)

| Capacidade | Status | Evidência |
|---|---|---|
| Chat real | **PASS REAL** | SingleAgent conversa natural; 16 testes frontend E2E; sem templates repetitivos |
| LLM real | **PARTIAL** | Pool Groq funciona p/ prompts enxutos do SingleAgent (485 testes); insuficiente p/ contexto completo de agente OpenCode (8k TPM) |
| Contexto | **PASS REAL** | compilação sob demanda + `collectDependencyResults` por nó |
| Obsidian | **PASS REAL** | `persistGraphOutcome` deduplicado, conhecimento útil (sem dump) |
| Tool execution | **PASS REAL** | tools reais executadas no graph: `web_search` (rede live), `goal_create/list`, `brain_search`, `memory_search` |
| Graph creation | **PASS REAL** | planner→validator→`graph_runs`/`graph_nodes` (DAG válido) |
| Graph execution | **PASS REAL** | `GraphExecutor` executa nós tool reais até `COMPLETED` |
| OpenCode | **PARTIAL** | CLI instalado e **realmente invocado** (sessão criada, JSON parseado); conclusão bloqueada por capacidade de LLM |
| Subagents | **BLOCKED** | agentes definidos `mode: all` e invocáveis; sem capacidade de LLM para concluir de verdade |
| Parallelism | **PASS REAL** | 3 nós `web_search` concorrentes; **maxActive=3 provado por sobreposição real de timestamps** (não "async no código") |
| Evaluator | **PASS REAL** | `requireCount`→FAILED honesto com evidência `count`; não converte FAIL em SUCCESS |
| Rework | **PASS REAL** | FAILED→evidência→REWORK→RETRY→SUCCESS (`retryCount`, 3 tentativas reais) |
| Recovery | **PASS REAL** | interrupção→`recoverStaleRuns`→`prepareResume`→retoma só pendentes; **COMPLETED não re-executado** (mesmo `completedAt`) |
| Long-running task | **PASS REAL** | DAG research→context→implement(goal)→verify com tools reais → `COMPLETED` + Obsidian |
| Production frontend | **PASS REAL** | Vercel serve UI ChatGPT-like (FASE 3.7); HQ removido da produção |
| Production backend | **BLOCKED** | Vercel estática não tem backend persistente; requer Railway/VPS + volume (ver `docs/DEPLOY.md`) |

**Resumo:** 11 PASS REAL · 2 PARTIAL · 3 BLOCKED · 0 FAIL.
Nenhum "não testado→PASS", nenhum "mock→REAL", nenhum "unit→E2E".

---

## 5. Testes (reais)

Novo `tests/graph-runtime-real.test.ts` (9 testes) + regressão completa:

| Teste | O que prova (real) |
|---|---|
| parseOpenCodeOutput erro de capacidade | JSON real do Groq→FAILED (não sucesso) |
| parseOpenCodeOutput sucesso | extrai texto quando houver |
| runner disponibilidade | `opencode --version` real |
| runner execução real | OpenCode invocado de verdade; resultado honesto (sucesso real ou FAILED com evidência) |
| Paralelismo | 3 `web_search` concorrentes, maxActive≥2 por timestamps |
| Recovery | COMPLETED preservado; só pendentes retomados |
| Rework FAILED | quantidade insuficiente→FAILED com evidência |
| Rework→SUCCESS | 2 falhas + 1 sucesso, retryCount≥2 |
| Long-horizon | DAG multi-nó real→COMPLETE + Obsidian |

**Suíte completa: 485 testes passando (2 skipped pré-existentes). Typecheck limpo.
`git diff --check` limpo.**

---

## 6. Limites honestos (o que NÃO foi convertido em PASS)

- **Conclusão de subagente OpenCode**: BLOCKED por capacidade de LLM (Groq 8k TPM
  vs ~38k de contexto; OpenRouter sem créditos). O runtime está correto; falta
  recurso externo. Não foi mockado nem marcado como sucesso.
- **Backend em produção**: BLOCKED (Vercel é estática; backend persistente requer
  Railway/VPS). Frontend opera em modo degradado honesto até o backend existir.
- **LLM para o SingleAgent em produção**: PARTIAL — depende das chaves Groq
  (pool) no ambiente de runtime.