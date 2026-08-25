# RUNTIME 2.0 — REALITY GATE REPORT

**Data:** 2026-08-25 · Base: auditoria `RUNTIME_2_AUDIT.md` + implementação incremental

---

## RESULTADO POR CAPACIDADE

| Gate | Status | Evidência |
|---|---|---|
| MANAGER_CHAT_REAL | **PASS REAL** | Groq `openai/gpt-oss-120b` responde com contexto do banco; fallback determinístico sinalizado honestamente |
| MANAGER_LLM_FALLBACK_HONEST | **PASS REAL** | Sem chaves → contextCard "não configurado"; budget estourado → "bloqueado — budget diário excedido (US$x ≥ US$y)" |
| MANAGER_INTENT | **PASS REAL** | Briefing dev ≠ imagem (classifyCreativeIntent); correção do usuário vence; 8 testes dedicados |
| HEARTBEAT_ORPHAN_REAL | **PASS REAL** | `detectOrphanedRuns` marca ORPHANED, reenfileira task READY, emite run.orphaned — 3 testes com timestamps reais; scanner roda no server a cada 5min |
| EVENT_BUS_REAL | **PASS REAL** | Catálogo §37 tipado, provenance ts/runId/taskId/agentId no payload; consumido pelo SSE existente |
| N8N_ADAPTER | **PARTIAL** | Código real testado contra servidor HTTP local (POST/dispatch/status/poll/BLOCKED). Contra instância n8n real: **BLOCKED — NEEDED: N8N_BASE_URL** |
| COST_BUDGET_REAL | **PASS REAL** | Soma diária de model_generations.testada com custos reais e dia anterior excluído |
| EVIDENCE_GATE | **PASS REAL** (wrapper) | `requireEvidence` recusa output<40 chars sem artifact/source. submitResult legado intacto (documentado) — integração nos workers novos |
| TASK_LIFECYCLE_VALIDATED | PASS (pré-existente) | harness 15 estados c/ transições; MAX_RETRIES→approval humano |
| EVALUATOR_INDEPENDENT | **PASS REAL** | Iniciativas `kind=dev` → `required_review=1` força revisão: task WAITING, agent_results PENDING, approval CONTENT criado; fluxo legado intacto. Testes runtime2b |
| KILL_SWITCH_PERSISTENCE | **PASS REAL** | F1 corrigido: `setKillSwitch(active, db)` grava `index_metadata`; ciclo novo lê do DB e respeita após "restart" simulado; Gerente e webhook persistem |
| PARALLEL_RUNS_HEARTBEAT | **PASS REAL** | Cada task executada pelo orquestrador cria run REAL em agent_runs (RUNNING→COMPLETED/FAILED), heartbeat a cada 30s + no finish, eventos task.started/completed/failed no bus |

## COMMITS DESTA FASE
- `07a8a69` + `8d51554` — runtime-ops, event-bus, n8n-adapter, cost-control, schema v21
- `d4137c1` — kill switch persistido, runs+heartbeat no orquestrador, QA obrigatório dev (schema v22)
- Auditoria: `docs/RUNTIME_2_AUDIT.md`

## NÚMEROS FINAIS
- Testes: **335/335** (42 arquivos) — zero regressões
- Typecheck: limpo · Schema: **v22**

## PRÓXIMOS
1. Prospector ciclos → triggerWorkflow n8n quando configurado (**N8N pendente**)
2. Wire evidence gate nos workers OpenCode (artifacts = arquivos modificados/diff)
3. Scheduler recorrente por agente (cron-like) usando event-bus
