# SECOND BRAIN OS — PHASE 37 HANDOFF

> Este documento permite que uma NOVA SESSÃO continue o desenvolvimento
> sem depender do contexto desta conversa.
>
> Última atualização: 2026-08-24
> Último commit: ver `git log --oneline -1`

---

## Current State

```
Versão: v4.1.0
Branch: main
Testes: 232/232 PASS
Typecheck: PASS
Schema: v8 (Second Brain) + v1 (Nutriva)
MCP tools: 41
Memórias: 45.395+
Notas Obsidian: 43
Evolution API: REAL (instância SECOM, status pode variar)
WhatsApp outbound: REAL
WhatsApp inbound webhook: REAL (requer tunnel público ativo)
Customer Agent: REAL
Owner Command Channel: REAL (SECOM only)
OpenCode Runtime: REAL (spawn de opencode run)
ChatGPT consultation: PREPARED (aguarda SECOND_BRAIN_EXTERNAL_AI_KEY)
Autonomy Engine: REAL
```

---

## Architecture

### Camadas

```
OBSIDIAN VAULT = SOURCE OF TRUTH HUMANO (43+ notas .md)
DATABASE brain.db = MEMORY/QUERY/INDEX ENGINE (45K+ memórias)
MCP SERVER = ACCESS LAYER (41 tools stdio)
AGENTS = CONSUMERS/PRODUCERS
```

### Módulos implementados

| Módulo | Arquivo | Fase |
|---|---|---|
| Memory Engine | core/memory/memory-engine.ts | F9 |
| Context Package | core/context/context-package.ts | F10/F17 |
| Agent Runtime | core/agents/agent-runtime.ts | F11 |
| Agent Manager + Selector + Queue | core/agents/agent-os.ts | F19 |
| Goal Engine | core/goals/goal-engine.ts | F18 |
| Initiative/Scoring/Planner | core/goals/initiatives.ts | F18 |
| Observation/Opportunity/Hypothesis | core/goals/funnel.ts | F18 |
| Proactive Brain | core/goals/proactive.ts | F22 |
| Policy/Autonomy | core/policy/autonomy.ts | F21 |
| Tool Registry | core/tools/tool-registry.ts | F12 |
| Nutrition Engine (Nutriva) | apps/nutriva/src/services/nutrition-engine.ts | Nutriva |
| Patient Service (Nutriva) | apps/nutriva/src/services/patient-service.ts | Nutriva |
| Execution Engine | core/exec/execution-engine.ts | F20 |
| Collaboration | core/collab/collaboration.ts | F20 |
| External AI Provider | core/collab/external-ai.ts | F20 |
| OpenCode Runtime | core/factory/opencode-runtime.ts | F30 |
| WhatsApp Ingest | core/ingest/whatsapp-ingest.ts | F29 |
| Obsidian Sync | core/obsidian/obsidian-sync.ts | F30 |
| Knowledge Layer | core/obsidian/knowledge-layer.ts | F36 |
| Webhook Handler | core/webhooks/evolution-webhook.ts | F27 |
| Webhook Server | core/webhooks/webhook-server.ts | F27 |
| Evolution API Provider | core/comms/evolution-api.ts | F26 |
| Unified Query API | core/unified.ts | F17 |
| Search (FTS5) | core/retrieval/searcher.ts | F3 |

---

## Existing F37 Foundations

Estes componentes já existem e devem ser EVOLUÍDOS, não reescritos:

### Task Queue
- **Arquivo:** core/agents/task-queue.ts (F19)
- **Funções:** refreshQueue, assignTask, startTaskWork, blockTask, unblockTask
- **Limitação:** não possui state machine formal nem checkpoints

### Handoffs
- **Arquivo:** core/agents/handoffs.ts → dentro de agent-os.ts
- **Funções:** createHandoff, acceptHandoff, completeHandoff
- **Limitação:** sem Context Compiler para o agente receptor

### Results / Review / Rework
- **Arquivo:** core/exec/execution-engine.ts + agent-os.ts
- **Fluxo:** submitResult → validation → review → approve/reject → rework
- **Limitação:** evaluator não é independente do worker

### Policy Engine
- **Arquivo:** core/policy/autonomy.ts
- **Níveis:** MANUAL/ASSISTED/SUPERVISED/AUTONOMOUS
- **Limitação:** sem budgets por run

### Collaboration Sessions
- **Arquivo:** core/collab/collaboration.ts
- **Suporta:** sessions, messages com tipos, decisions, human override
- **Limitação:** sem rounds enforcement formal

### External AI
- **Arquivo:** core/collab/external-ai.ts
- **Provider:** OpenAICompatProvider (usa env vars)
- **Limitação:** sem SECOND_BRAIN_EXTERNAL_AI_KEY configurada

### OpenCode Runtime
- **Arquivo:** core/factory/opencode-runtime.ts
- **Executa:** spawn de `opencode run` real
- **Limitação:** sem session persistence ou recovery

### Proactive Cycle
- **Arquivo:** core/autonomous/cycle.ts
- **Faz:** observe→analyze→propose→SECOM report
- **Limitação:** single-shot, sem loop contínuo

---

## F37 Gaps — O que falta implementar

1. **Formal Agent State Machine** — 15 estados com transições validadas
2. **Run/Session/Task hierarchy** — modelo hierárquico com correlation/causation IDs
3. **Context Compiler** — ranking determinístico, budget, provenance
4. **Tool Contracts** — input_schema/output_schema/risk/side_effects por tool
5. **Tool Guardrails** — authorization→risk→scope→input→secret→policy chain
6. **Workspace Sandbox** — allowed/blocked paths e commands por projeto
7. **Planner/Worker/Evaluator separation** — evaluator independente do worker
8. **Checkpoints** — persistência de estado em runs longos
9. **Recovery/Resume** — continuar após crash/restart
10. **Agent Tracing** — structured tracing com correlation_id
11. **Correlation/Causation IDs** — rastrear causa raiz
12. **Agent Evals** — 15 avaliações específicas de comportamento
13. **Budgets** — time/tool/retry/external_ai limits por run
14. **Handoff Manager** — contexto compilado para o agente receptor
15. **Human Checkpoints** — approval gates integrados ao state machine
16. **SECOM Control Plane** — command bus com linguagem natural
17. **Long-running autonomous runtime** — múltiplos ciclos sequenciais

---

## Important Architectural Rule

A Fase 37 deve ser uma CAMADA DE ORQUESTRAÇÃO PROFISSIONAL sobre a infraestrutura existente.

```
EXISTING ENGINES (não duplicar)
         ↓
PROFESSIONAL AGENT HARNESS (nova camada)
         ↓
AUTONOMOUS RUNS (persistidos, recuperáveis)
```

NÃO duplicar: task queue, memory engine, policy engine, tool registry, collaboration, results.

EVOLUIR o que já existe adicionando: state machine, budgets, checkpoints, tracing, evals, context compiler.

---

## Agent Harness Target Architecture

```
OWNER
 ↓
SECOM (command bus)
 ↓
MASTER ORCHESTRATOR
 ↓
CONTEXT COMPILER (ranking determinístico)
 ↓
PLANNER (decompõe em steps)
 ↓
WORKER (executa via OpenCode/tools)
 ↓
RESULT
 ↓
EVALUATOR (independente do worker)
 ↓
PASS → NEXT RUN
FAIL → REWORK → WORKER → EVALUATE
 ↓
LEARNING
 ↓
OBSIDIAN + MEMORY ENGINE
```

---

## State Machine

### Estados

```
IDLE
READY
PLANNING
RUNNING
WAITING_TOOL
WAITING_AGENT
WAITING_EXTERNAL_AI
EVALUATING
REWORKING
BLOCKED
WAITING_HUMAN
PAUSED
CANCELLED
COMPLETED
FAILED
```

### Transições válidas

```
IDLE → READY (task assigned)
READY → PLANNING (agent starts)
PLANNING → RUNNING (plan created)
RUNNING → WAITING_TOOL (tool call)
WAITING_TOOL → RUNNING (tool returned)
RUNNING → WAITING_AGENT (handoff)
WAITING_AGENT → RUNNING (handoff accepted)
RUNNING → WAITING_EXTERNAL_AI (ChatGPT consult)
WAITING_EXTERNAL_AI → RUNNING (response received)
RUNNING → EVALUATING (result submitted)
EVALUATING → COMPLETED (pass)
EVALUATING → REWORKING (fail)
REWORKING → RUNNING (retry within limit)
REWORKING → BLOCKED (max retries exceeded)
ANY → BLOCKED (blocker detected)
BLOCKED → READY (blocker resolved)
ANY → WAITING_HUMAN (approval required)
WAITING_HUMAN → RUNNING (approved)
WAITING_HUMAN → CANCELLED (rejected)
ANY → PAUSED (owner command)
PAUSED → previous_state (resumed)
ANY → FAILED (unrecoverable error)
ANY → CANCELLED (owner cancelled)
```

### Transições INVÁLIDAS

- IDLE → COMPLETED (precisa passar pelos estados intermediários)
- BLOCKED → COMPLETED (precisa resolver blocker primeiro)
- PAUSED → RUNNING direto (deve passar por READY)

---

## Context Compiler

O agente NÃO recebe as 45K memórias.

Entrada: task, goal, project, agent, state.
Saída: COMPACT CONTEXT PACKAGE (máximo configurável).

Ranking determinístico prioriza:
1. task description
2. current state
3. project context
4. relevant decisions
5. relevant memories (por importance/recência/proximidade)
6. relevant Obsidian notes
7. relevant skills
8. relevant tools
9. historical context

Cada item registra relevance_score e source.

Budget de tokens/chars configurável por run.

---

## Evaluator

Worker ≠ Evaluator.

O worker executa.
O evaluator valida independentemente.

Critérios de avaliação:
- requirements atendidos
- testes passando
- typecheck limpo
- diff revisado
- regressões verificadas
- segurança validada
- critérios de aceite
- documentação atualizada
- contexto preservado

Retorna: PASS / FAIL / NEEDS_REWORK com feedback estruturado.

---

## Agent Evals (15 avaliações previstas)

1. Correct project selection
2. Correct task selection  
3. No repeated completed task
4. Context retention across steps
5. Correct tool selection
6. Correct agent selection
7. Failure detection
8. Failure recovery
9. Appropriate ChatGPT consultation (only when needed)
10. Policy compliance
11. Decision documentation
12. Obsidian update after knowledge change
13. Checkpoint resume after interruption
14. Budget stopping (time/retries/cost limits respected)
15. Kill switch compliance

---

## Sandbox

```json
{
  "project_id": "nutriva",
  "workspace_path": "apps/nutriva",
  "allowed_paths": ["src/**", "tests/**", "*.json", "*.md"],
  "blocked_paths": [".env*", ".ssh/**", "../second-brain/**", "C:/Windows/**"],
  "allowed_commands": ["npm test", "npm run typecheck", "node"],
  "blocked_commands": ["rm -rf", "del /s", "format", "shutdown"],
  "network_policy": "localhost_only",
  "environment_policy": "no_secrets_in_code"
}
```

---

## Long Running

```
run.start()
→ checkpoint (persist state)
→ step 1 → checkpoint
→ step 2 → checkpoint
→ ... 
→ crash/restart
→ resume(run_id) → "o que já foi feito?" → "o que falta?"
→ continue from last checkpoint
→ complete
```

Checkpoint contém:
- run_id
- state (state machine current state)
- current_step
- completed_steps[]
- pending_steps[]
- files_changed[]
- decisions[]
- context_reference
- agent_state
- tool_results[]
- last_successful_action

---

## SECOM

GROUP: SECOM
GROUP ID: 120363427273069174@g.us
OWNER ID: 15981817336

REGRA ABSOLUTA:
- Número pessoal NÃO recebe mensagens administrativas
- SECOM é o único command bus
- OWNER_ID ≠ DESTINATION
- sender_id + group_id juntos autorizam comandos admin
- Qualquer outro participante do grupo: DENIED

Comandos aceitos no SECOM (linguagem natural):
- @brain status
- @brain continue
- @brain pare tudo
- @brain aprovar <id>
- @brain rejeitar <id>
- @brain relatório
- linguagem natural interpretada pelo Context Engine

---

## WhatsApp

Evolution provider: REAL
SECOM instance: desconectada no momento (reconectar via Manager)
Customer auto-send: OFF
Não reativar automaticamente.

---

## External AI

Provider abstraction: existe (`core/collab/external-ai.ts`)
Real ChatGPT consultation: PREPARED mas NOT VERIFIED
Requer: SECOND_BRAIN_EXTERNAL_AI_URL + SECOND_BRAIN_EXTERNAL_AI_KEY
FakeExternalAIProvider disponível apenas para testes unitários.

---

## Obsidian

Vault: C:\Users\junin\OneDrive\Documentos\Obsidian Vault
Sync module: core/obsidian/obsidian-sync.ts
Knowledge Layer: core/obsidian/knowledge-layer.ts
Backup: core/obsidian/vault-preservation.ts
Conflict detection: implementado
Privacy scopes: PERSONAL/FRIEND/COMMERCIAL isolados
Frontmatter padronizado: type/id/status/privacy/source/tags

---

## Nutriva Benchmark

Foundation: DONE
Nutrition Engine: DONE (7 tests)
Patient CRUD: DONE (4 tests, tenant isolation)
Schema: v1 (tenants, users, patients, foods, meal_plans, meal_plan_meals, meal_plan_items)
Server: scaffold com rotas básicas

Remaining MVP:
- Auth middleware (JWT/token)
- Meal plan CRUD completo com cálculos
- Substitution engine algorítmico
- Recipe engine
- PDF generation
- Frontend UI
- Tenant isolation enforcement middleware
- Food search autocomplete
- WhatsApp delivery integration

---

## Relevant Files

```
core/
├── agents/
│   ├── agent-runtime.ts      # upsertAgent, getAgent, listAgents
│   ├── agent-os.ts           # task queue, sessions, handoffs, results, review, rework
│   └── orchestrator.ts       # orchestrateCycle, teams, dispatchToTeam
├── ai/
│   ├── llm-provider.ts       # interface LLMProvider
│   ├── llamacpp-provider.ts  # LocalLlamaCppProvider
│   ├── memory-extractor.ts   # extractMemoryProposals
│   └── save-memory.ts        # saveConfirmedMemory
├── autonomous/
│   └── cycle.ts              # runAutonomousCycle, setKillSwitch
├── collab/
│   ├── collaboration.ts      # sessions, messages, decisions, override
│   └── external-ai.ts        # buildConsultationContext, providers
├── config/
│   └── loader.ts             # loadConfig, findProjectRoot
├── context/
│   ├── context-builder.ts    # buildContext
│   └── context-package.ts    # buildContextPackage
├── entities/
│   ├── entity.ts             # EntityRecord, getEntity
│   └── resolver.ts           # resolveEntity
├── errors/
│   └── errors.ts             # BrainError hierarchy
├── exec/
│   ├── execution-engine.ts   # requestExecution, runAuthorizedExecution
│   ├── policy.ts             # evaluatePolicy, classifyRisk
│   ├── executor.ts           # LocalExecutor
│   ├── redact.ts             # redactSecrets, redactDeep
│   └── system-health.ts      # getSystemHealth
├── factory/
│   ├── opencode-runtime.ts   # OpenCodeRuntime (spawn opencode run)
│   └── engineering-loop.ts   # createEngineeringSession
├── goals/
│   ├── goal-engine.ts        # createGoal, updateGoal, goalPriority
│   ├── initiatives.ts        # createInitiative, scoreInitiative, planInitiative
│   ├── funnel.ts             # addObservation, createOpportunity, createHypothesis
│   └── proactive.ts          # brainNextActions, isProactiveQuery
├── ingest/
│   └── whatsapp-ingest.ts    # parseWhatsAppExport, ingestSource
├── indexing/
│   └── chunker.ts            # chunkBody
├── logger/
│   └── logger.ts             # createLogger
├── memory/
│   └── memory-engine.ts      # createMemory, searchMemories, computeImportance
├── obsidian/
│   ├── obsidian-sync.ts      # syncToObsidian
│   ├── knowledge-layer.ts    # buildKnowledgeLayer
│   └── vault-preservation.ts # backupVault, detectConflicts
├── orchestrator/
│   ├── router.ts             # routeQuery
│   └── brain-orchestrator.ts # ask
├── permissions/
│   └── ignore.ts             # parseIgnoreLines, isIgnoredPath
├── policy/
│   └── autonomy.ts           # evaluateAutonomy, ActionPolicy
├── proactive/
│   ├── proactive-engine.ts   # generateProactiveProposals, generateDailyDigest
│   └── notify.ts             # notify (WhatsApp)
├── projects/
│   └── project-intelligence.ts # getProjectIntelligence
├── relations/
│   └── graph.ts              # relatedEdges, traverseGraph, supersedeRelation
├── retrieval/
│   ├── fts-query.ts          # sanitizeFtsQuery
│   ├── searcher.ts           # searchDocuments
│   └── timeline.ts           # buildTimeline
├── skills/
│   └── skill-engine.ts       # indexSkillSource, searchSkills
└── tools/
    └── tool-registry.ts      # registerTool, resolveTools, seedBrainTools

core/webhooks/
├── evolution-webhook.ts      # handleEvolutionWebhook
└── webhook-server.ts         # startServer (HTTP server)

core/comms/
├── pipeline.ts               # ensureCommTables, resolveContact, classifyIntent
└── evolution-api.ts          # sendMessage, getConnectionState

apps/nutriva/src/
├── server.ts                 # Nutriva HTTP server
├── services/
│   └── nutrition-engine.ts   # calculateFoodNutrition, calculateMealTotals
└── db/
    ├── nutriva-schema.ts     # initNutrivaSchema
    ├── tenant.ts             # tenant CRUD
    └── foods.ts              # seedFoods, searchFoods

storage/
├── schema.ts                 # SCHEMA_STATEMENTS, MIGRATIONS
└── connection.ts             # openDatabase, applySchema

mcp/src/
├── server.ts                 # MCP server with 41 tools
└── tools.ts                  # tool handlers

config/
└── default.json              # default configuration
```

---

## Database

Schema version: 8

Tables (57 total):
- Base: index_metadata, sources, documents, entities, relations, events, memories, memories_fts, working_memory, chunks, documents_fts
- Agents: agents, tools_registry, skills, skill_sources, skill_relations, observations, research_questions, research_claims
- Goals: goals, goal_observations, opportunities, hypotheses, initiatives, initiative_tasks
- Agent OS: teams, task_assignments, work_sessions, handoffs, agent_messages, approvals, agent_results
- Executions: executions, execution_results, decisions, collab_sessions, collab_messages, external_ai_requests
- Comm: wa_contacts, wa_conversations, wa_messages, comm_profiles
- Policies: policies

Key relationships:
- entities ← documents (origin_document_id)
- relations → entities (source_entity, target_entity)
- memories → entities (entity_id), sources (source_id)
- initiatives → goals (goal_id), hypotheses (hypothesis_id)
- initiative_tasks → initiatives (initiative_id)
- executions → tasks/initiatives
- approvals → tasks (execution_id in payload)

Migration path: v1→v2→v3→v4→v5→v6→v7→v8 (all idempotent, guarded ALTERs)

---

## Tests

Total: 232 tests passing
Location: tests/

Files:
- tests/storage/schema.test.ts (9 tests) — schema, migrations, FK, FTS5
- tests/core/config.test.ts (6 tests) — config loading, env overrides
- tests/core/ignore.test.ts (28 tests) — .brainignore patterns
- tests/connectors/markdown.test.ts (10 tests) — parser, BOM, frontmatter
- tests/core/chunker.test.ts (5 tests) — heading-based splitting
- tests/core/vault-indexer.test.ts (8 tests) — incremental indexing, rename detection
- tests/core/search.test.ts (14 tests) — FTS5, ranking, filters, sanitization
- tests/core/graph.test.ts (17 tests) — resolver, graph traversal, temporal, timeline
- tests/core/orchestrator.test.ts (14 tests) — routing, context builder, unified query
- tests/mcp/server.test.ts (13 tests) — InMemoryTransport, all tools
- tests/v2/phase09-memory.test.ts (6 tests) — memory engine
- tests/v2/phase10-context.test.ts (3 tests) — context package
- tests/v2/phase11-agents.test.ts (3 tests) — agent runtime
- tests/v2/phase12-tools.test.ts (4 tests) — tool registry
- tests/v2/phase13-skills.test.ts (3 tests) — skills engine
- tests/v2/phase14-learning.test.ts (3 tests) — learning loop
- tests/v2/phase15-research.test.ts (4 tests) — research engine
- tests/v2/phase16-projects.test.ts (2 tests) — project intelligence
- tests/v2/phase17-e2e.test.ts (3 tests) — unified E2E
- tests/v2/phase18-goals.test.ts (11 tests) — goal/initiative engine
- tests/v2/phase19-agentos.test.ts (10 tests) — agent OS E2E
- tests/v2/phase20-exec-collab.test.ts (14 tests) — execution + collaboration
- tests/v2/phase22-proactive.test.ts (3 tests) — proactive brain
- tests/v2/phase26-reality.test.ts (6 tests) — operational reality
- tests/v2/phase28-gate.test.ts (9 tests) — gate final sales flow
- tests/v2/phase282-owner-channel.test.ts (8 tests) — owner channel security
- tests/v2/phase29-ingest.test.ts (5 tests) — whatsapp ingest
- tests/nutriva/nutrition.test.ts (7 tests) — nutrition calculations

Commands:
- npm test → vitest run
- npm run typecheck → tsc --noEmit
