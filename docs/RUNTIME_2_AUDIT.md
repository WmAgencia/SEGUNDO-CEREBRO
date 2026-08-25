# RUNTIME 2.0 — AUDITORIA PRÉ-IMPLEMENTAÇÃO

**Data:** 2026-08-25 · **Método:** grep/read do código real, não de docs

---

## 1. ARQUITETURA ATUAL (mapa real)

```
CONTROL PLANE   apps/hq/server.ts (HTTP+SSE) · core/hq/hq-api.ts · manager.ts · orchestrator.ts
PLANNER         manager.extractPlan/classifyCreativeIntent · goals/initiatives.planInitiative
DISPATCH        agents/agent-os.ts (selectAgent score determinístico, refreshQueue, assignTask)
RUNTIME         agents/professional-harness.ts (15 estados + transições validadas)
EXECUTION       exec/execution-engine.ts (requestExecution→approval→runAuthorizedExecution)
                exec/policy.ts (classifyRisk/evaluatePolicy)
EVALUATION      agent-os.submitResult (VALID/INCOMPLETE, rework MAX_RETRIES=3→approval)
                agent-os.requestReview/resolveReview (reviewer independente opcional)
RECOVERY        autonomous/cycle.ts (kill switch), agent_runs/agent_checkpoints tables
TOOLS           exec/* + tools/tool-registry + skills + drive-tools
MODELS          ai/model-router.ts (7 workloads, Groq→OpenRouter chain, model_generations log)
MEMORY          memories + FTS · obsidian/knowledge-records · conversation-notes
COMMS           comms/evolution-api · pipeline · instance-state (AI on/off) · webhooks/evolution-webhook
PROSPECCTION    comms/leads · prospector-scheduler (janela/budget/kill/BLOCKED_SOURCE)
OBSERVABILITY   hq/event-stream.ts (SSE) · notifications · events table
SCHEMA          storage/schema.ts v20 (45+ tabelas)
```

## 2. REUTILIZÁVEIS (não reimplementar)
agent-os completo · harness state machine · execution-engine/policy · model-router gateway ·
instance-state · leads/scheduler · conversation-notes · SSE · approvals/handoffs.

## 3. GAPS CONFIRMADOS (grep vazio = não existe)
| # | Gap | Impacto |
|---|---|---|
| G1 | **Heartbeat/orphan detection** | Run morto fica RUNNING para sempre; task presa |
| G2 | **n8n Adapter** | Integration fabric inexistente |
| G3 | **Enforcement de evidência** | `submitResult` aceita VALID sem artifacts/sources — "disse que fez" vira SUCCESS |
| G4 | **Event bus unificado** | events gravados ad-hoc; catálogo da spec 37 inconsistente |
| G5 | **Budget de custo LLM** | custo salvo mas nunca somado/enforcado |
| G6 | Scheduler recorrente por agente (cron-like) | parcial: só prospection window + manual |

## 4. MOCKS/FALLBACKS ENCONTRADOS
- Nenhum fake success nos caminhos principais (validado Reality Gates anteriores).
- Fallback determinístico do Gerente é LEGÍTIMO e sinalizado (`contextCards: LLM não configurado`).
- `isKillSwitchActive(_db)` ignora DB — kill switch só in-memory/env: **fragilidade** (F1).

## 5. PONTOS FRÁGEIS
F1 kill switch não persistido · F2 pending_plans table referenciada mas inexistente (try/catch engole) ·
F3 disco C: historicamente <2GB (risco operacional real, já causou corrupção).

## 6. PLANO DE MIGRAÇÃO DESTA SESSÃO (incremental, 1 commit por fase)
- **P-B** Schema v21 (heartbeat) + `runtime-ops.ts`: touchHeartbeat/detectOrphans/recover + evidence gate puro
- **P-C** `event-bus.ts`: emitter único + catálogo tipado (usado por P-B/D/E)
- **P-D** `integrations/n8n-adapter.ts` (env-gated, BLOCKED honesto, testes c/ http local)
- **P-E** Cost budget: getDailyLlmCost/assertWithinBudget + wire no Gerente
- **P-F** Reality Gate RUNTIME_2 + relatório

## 7. RISCOS
R1 alterar submitResult default pode quebrar E2E legados → evidência obrigatória entra como
wrapper novo + flag, sem mudar assinatura legada. R2 disco cheio durante deploy → sem npm install.

## 8. EXTERNOS (estado real)
✅ Groq (gpt-oss-120b) · ✅ OpenRouter (crédito limitado) · ✅ Evolution URL/KEY (instância close) ·
❌ GOOGLE_MAPS_API_KEY · ❌ N8N_BASE_URL (adapter nasce BLOCKED-ready)
