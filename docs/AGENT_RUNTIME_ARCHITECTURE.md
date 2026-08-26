# AGENT RUNTIME ARCHITECTURE

## Camadas (já operacionais — auditadas em produção)
```
CONTROL PLANE     apps/hq/server.ts · core/hq/hq-api.ts · manager.ts · orchestrator.ts
PLANNER           manager.extractPlan/classifyCreativeIntent · goals/initiatives
DISPATCH          agents/agent-os.ts (selectAgent determinístico, refreshQueue, assignTask)
RUNTIME           agents/professional-harness.ts (15 estados + transições validadas)
EXECUTION         exec/execution-engine.ts · exec/policy.ts (risk/approval)
EVALUATION        agent-os.submitResult (VALID/INCOMPLETE, MAX_RETRIES=3→approval)
EVIDENCE          agents/runtime-ops.ts (requireEvidence — "não dizer que fez" sem prova)
RECOVERY          runtime-ops (heartbeat/orphan) · cycle.ts (kill switch persistido)
TOOLS/MCP         41 tools brain_* (auditadas) · tools/tool-registry
MODELS            ai/model-router.ts (workloads + Groq→OpenRouter chain + cost-control)
MEMORY+OBSIDIAN   memories/FTS · knowledge-records · conversation-notes
COMMS             comms/evolution-api · instance-state (IA on/off) · webhook pipeline
```

## Supervisor (Gerente) — delegação real
O Gerente é o supervisor: conversa, monta contexto (`buildSystemContext`), classifica intenção
(`classifyCreativeIntent`, com frame de prospecção), cria Goal→Initiative→Tasks, escolhe agente
e despacha. Aprovação obrigatória para iniciativas `kind=dev` (required_review → QA independente).

## Runs reais com heartbeat
`startOrchestratorRun` cria `agent_runs` reais (RUNNING→COMPLETED/FAILED) com heartbeat a cada
30s + eventos `task.started/completed/failed` no bus. Orphan scanner recupera runs mortos.

## Tool routing
- Conteúdo/estratégia → LLM (Groq→OpenRouter) ou fallback determinístico honesto (`contextCards`).
- Prospecção → `prospector-engine` (fonte real).
- WhatsApp → `instance-state` + Evolution.
- Dev → engineering/qa/integrator via orquestrador paralelo.

## Segurança
Sem segredos em código (verificado `git grep`); `.env*` gitignored; policy/approval/kill switch.
`OPENROUTER_API_KEY` exposta no `railway variables` é echo do próprio Railway — recomendamos
**rotacionar** a chave se ela apareceu em qualquer log/print (não apareceu no nosso output).

## Observabilidade
`correlation_id` (run/task/agent), log do modelo (`model_generations`), eventos do bus, SSE real.
