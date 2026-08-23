# SECOND BRAIN OS — CHANGELOG

## V2.2.0 — Phase 19: Agent OS (2026-08-23)
- Agent Model estendido (role/skills/tools/projects/goals/workload/capacity/metadata).
- Agent Manager + Selector determinístico com score e reasons (capabilities, skills, tools, projeto, workload).
- Dispatcher + Task Queue operacional (PENDING→READY→ASSIGNED→RUNNING→WAITING/BLOCKED→COMPLETED) respeitando dependências.
- Work Sessions, Handoffs (CREATED/ACCEPTED/COMPLETED), Messages (REQUEST..REVIEW), Blockers com required_input/approval.
- Results com validação determinística, Review (approve/reject), Rework com histórico preservado e MAX_RETRIES=3 → escalonamento humano.
- Approvals humanas (PENDING/RESOLVED) integradas a review.
- Orchestrator Cycle persistido: libera, atribui, mede progresso, completa iniciativa; Teams c/ dispatch round-robin.
- Goal Feedback (reportOutcome atualiza current_value e gera METRIC_CHANGE), Agent Performance, Activity Log.
- MCP: +9 tools (total 36): brain_agents, brain_agent, brain_teams, brain_task_queue, brain_assignments, brain_handoffs, brain_agent_activity, brain_approvals, brain_orchestrate.
- Schema v5: teams, task_assignments, work_sessions, handoffs, agent_messages, approvals, agent_results + colunas novas em agents/initiative_tasks.

# SECOND BRAIN OS — CHANGELOG

## V2.1.0 — Phase 18: Goal & Initiative Engine (2026-08-23)
- **Goal Engine**: CRUD de objetivos (8 tipos, 7 status, hierarquia
  GOAL→SUBGOAL via parent_goal_id, métricas com progresso determinístico),
  priorização explicável (`goalPriority` → score + reasons).
- **Observation Engine**: 8 tipos de sinais (METRIC_CHANGE…USER_SIGNAL) com
  provenance; nunca viram ações automaticamente.
- **Opportunity Engine**: oportunidades derivadas de observações
  (NEW→ANALYZING→PROPOSED→ACCEPTED/CONVERTED).
- **Hypothesis Engine**: hipóteses com evidências/confiança/métrica/método;
  statement "FATO:" é rejeitado (hipótese ≠ fato).
- **Initiative Engine + Planner + Scoring**: criação vinculada a goal,
  score determinístico (impact×3 + prob×2 − cost×1.5 − effort − risk×2 +30,
  +8 alinhamento), planner com pipeline padrão de vendas e dependências,
  aprovação humana explícita (approve/reject com autor e motivo),
  proposta formatada (`brain_proposals`, CLI `brain propose`).
- **Proactive Brain**: `brainNextActions` / `brain next` — objetivos
  priorizados + observações + iniciativas aguardando aprovação + recomendações
  com motivos. OBSERVA/ANALISA/PROPOE — não executa.
- **Alinhamentos**: owner/support agents por overlap com Agent Runtime;
  skills via Skill Intelligence (budget respeitado); tools via Tool Registry.
- **Integrações**: `unifiedQuery` expõe goals + detecta queries proativas
  (regex) retornando nextActions; ContextPackage inclui activeGoals.
- Schema **v4**: goals, goal_observations, opportunities, hypotheses,
  initiatives, initiative_tasks. Eventos: goal_created/goal_updated/
  observation_created/opportunity_detected/initiative_created/
  initiative_updated/proposal_approved/proposal_rejected.

## V2.0.0 — Fases 9–17 (2026-08-23)

### Phase 9 — Memory Engine
- `core/memory/memory-engine.ts`: CRUD de memórias com FTS dedicado,
  filtros (texto/entidade/projeto/kind/categoria/importância/período),
  `computeImportance` determinístico, Working Memory com TTL e expiração.
- Schema v3: colunas `importance/project/access_count/last_accessed_at`
  em `memories`, tabelas `memories_fts` e `working_memory`.

### Phase 10 — Context Engine
- `core/context/context-package.ts`: `buildContextPackage(task,…)` —
  pipeline intent→entidade→contexto→memórias rankeadas; campos tools/skills
  preparados.

### Phase 11 — Agent Runtime
- `core/agents/agent-runtime.ts`: registro de agentes (kebab-case, domínios,
  capacidades, permissões, status) + `agentContext()` com checagem de
  permissão `context` e status ativo.

### Phase 12 — Tool Registry
- `core/tools/tool-registry.ts`: catálogo de ferramentas com categoria/
  permissões/origem/disponibilidade; `seedBrainTools` registra as 10 tools
  MCP reais; `resolveTools(task)` determinístico com score+razão.

### Phase 13 — Skills Intelligence
- `core/skills/skill-engine.ts`: indexa SKILL.md de qualquer repo com
  provenance (source/repo/path/sha256/versão), inferência de kind
  (skill/workflow/reference/command), `searchSkills` com budget 3 primary /
  3 supporting. Fontes clonadas em `skills-sources/` (gitignored):
  marketing-skills, farmage-opencode-skills, task-observer.

### Phase 14 — Learning Loop
- `core/learning/learning-loop.ts`: `observe()` agrega por patternKey;
  threshold (3) promove observation→candidate; governança accept/reject;
  aceitação permite promover a memória semântica.

### Phase 15 — Research Engine
- `core/research/research-engine.ts`: perguntas + claims com provenance
  (fonte/autoridade/data/confiança); detecção determinística NEW / DUPLICATE
  / CONFLICTING via Jaccard ≥0.85 (bug de assimetria de tokenização corrigido).

### Phase 16 — Project Intelligence
- `core/projects/project-intelligence.ts`: agregação por projeto —
  relacionados por tipo, decisões, procedimentos, memórias, documento origem,
  skills, tools, timeline, relações entre projetos.

### Phase 17 — Personal Operating System
- `core/unified.ts`: `unifiedQuery(query)` — intenção → contexto → memórias →
  skills → tools → agentes recomendados → fontes; log estruturado
  (`unified.query`) em events.
- MCP: +9 tools (total **19**): brain_search_memory, brain_get_memory,
  brain_related_memories, brain_search_tools, brain_search_skills,
  brain_agent_context, brain_project, brain_observe, brain_query.
- CLI: `brain project <id>`, `brain learn list|accept|reject`,
  `brain ai:status`, `brain ai:extract [--save]`.
- `brain_health` agora reporta skills/tools/agents/learning_candidates.

## V1.0.0 — Fases 0–8 (2026-08-23)
Indexer incremental, busca FTS5, grafo temporal, orchestrator, MCP stdio,
integração OpenCode, IA local (llama.cpp + Qwen3).
