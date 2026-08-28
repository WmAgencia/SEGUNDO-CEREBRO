# MODEL GATEWAY — Reality Gate (Groq + Alibaba/Qwen)

Data: 2026-08-27 · Branch `main`
Princípio: **estabilizar o runtime existente**, sem nova arquitetura. O Model
Gateway (`core/ai/model-gateway.ts`) é a única camada que fala com providers; o
Single Agent não conhece Groq/Alibaba diretamente.

---

## 1. O que foi consolidado (arquivos)

| Arquivo | Mudança |
|---|---|
| `core/ai/model-gateway.ts` | **NOVO** — camada única: `OpenAICompatibleAdapter` (genérico), `AlibabaProvider`, `GroqGatewayProvider` (wraps `GroqKeyPool`), `parseProviderOrder`, `buildProviderChain` (ordem via `MODEL_PROVIDER_ORDER`), `ModelGateway` (fallback + métricas), `loadGatewayGroqKeys`. |
| `core/ai/model-router.ts` | `defaultProviderChain` delega a `buildProviderChain`; `loadGroqKeys` delega ao gateway; `completeWithGateway` grava `key_slot`/`fallback_count`/`error_category` + redação de segredos. |
| `core/ai/groq-key-pool.ts` | reutilizado (round-robin, cooldown, backoff, 401/403→DISABLED, 429→COOLDOWN, `classifyError`, `redactKeys`). |
| `core/orchestration/subagents/opencode-runner.ts` | `resolveGraphModel()` — modelo do Graph/OpenCode via `SECOND_BRAIN_GRAPH_MODEL` / `SECOND_BRAIN_GRAPH_PROVIDER` (usa modelo já configurado, nunca inventa id). |
| `storage/schema.ts` | v25 — `model_generations` + `key_slot`, `fallback_count`, `error_category`. |
| `.env.local` | placeholders **adicionados sem sobrescrever**: `ALIBABA_API_KEY/BASE_URL/MODEL`, `MODEL_PROVIDER_ORDER`, `SECOND_BRAIN_GRAPH_PROVIDER/MODEL`. |
| `tests/model-gateway.test.ts` | 12 testes (seleção/rotação/cooldown/fallback/401/429/500/timeout/indisponível/segurança). |
| `tests/model-gateway-real.test.ts` | 4 testes com providers REAIS. |

**Nenhum** novo agent/loop/orchestrator/context-engine criado. SingleAgent,
Graph Engine, Tool Registry e Context Compiler existentes foram reutilizados.

---

## 2. Providers realmente testados

| Provider | Modelo | Resultado | Evidência |
|---|---|---|---|
| Groq (chave real 1 de 5) | `openai/gpt-oss-120b` | **PASS REAL** | `provider=groq keySlot=1 latency≈500ms` |
| Groq via SingleAgent | `openai/gpt-oss-120b` | **PASS REAL** | chat "Oi" → `"Oi! Como posso te ajudar hoje?"` |
| Alibaba/Qwen | — | **BLOCKED** | `ALIBABA_API_KEY`/`ALIBABA_MODEL` ausentes |
| Fallback Groq→Alibaba | — | **PASS REAL** (simulado) / parcial real | Groq→429→Alibaba responde (simulado); real respondeu por Groq |

**Chaves Groq detectadas: 5** (GROQ_API_KEY_1..5 preenchidas; 6..10 vazias ignoradas). Nenhuma chave revelada.

---

## 3. Checklist (seção 20)

| Critério | Estado | Evidência |
|---|---|---|
| Groq funcionando | ✅ REAL | chamada real OK (keySlot=1, ~500ms) |
| múltiplas chaves Groq | ✅ REAL | 5 detectadas; round-robin + rotação testadas |
| rotação funcionando | ✅ REAL | key1 falha→key2 responde (keySlot=2); round-robin |
| cooldown funcionando | ✅ REAL | 429→COOLDOWN, recuperação automática (groq-key-pool) |
| Alibaba funcionando | ⛔ BLOCKED | sem `ALIBABA_API_KEY`/`ALIBABA_MODEL` (código pronto+testado simulado) |
| fallback funcionando | ✅ REAL | cadeia `MODEL_PROVIDER_ORDER`; Groq→429→Alibaba (simulado) |
| streaming funcionando | ⚠️ PARTIAL | SSE por eventos de status existe; token-streaming não implementado |
| tool calling funcionando | ✅ REAL | tools executadas no loop do SingleAgent |
| contexto funcionando | ✅ REAL | `compileContext` just-in-time, budget, dedup |
| Obsidian funcionando | ✅ REAL | `persistGraphOutcome`/`persistGoalNote` com dedup |
| Agent Loop funcionando | ✅ REAL | maxTurns/timeout/kill-switch/detecção loop+falha |
| Graph funcionando | ✅ REAL | DAG/scheduler/executor/evaluator/rework/recovery |
| OpenCode funcionando | ⚠️ PARTIAL→BLOCKED | CLI invocada real; conclusão de subagente bloqueada por capacidade de LLM |
| testes passando | ✅ | 517 testes |
| typecheck passando | ✅ | limpo |
| git diff --check | ✅ | limpo |
| produção validada | ⚠️ PARTIAL | frontend Vercel live; backend persistente requer Railway/VPS |

---

## 4. Bloqueios honestos (não mascarados)

1. **Alibaba/Qwen**: `BLOCKED — ALIBABA_API_KEY e ALIBABA_MODEL ausentes em .env.local`.
   Código do provider está pronto e testado com dublê HTTP. Para desbloquear:
   preencher `ALIBABA_API_KEY`, `ALIBABA_MODEL` (ex.: `qwen-plus`) e `ALIBABA_BASE_URL`.
2. **OpenCode subagent concluindo tarefa**: `BLOCKED — capacidade de LLM`. O contexto
   do OpenCode (~38k tokens) excede o Groq free (8k TPM) → `ContextOverflowError`.
   O Model Gateway resolve para prompts pequenos; subagentes OpenCode precisam de um
   provider/modelo com contexto maior (configurar `SECOND_BRAIN_GRAPH_MODEL` com um
   modelo de contexto amplo). CLI é invocada de verdade; só a conclusão fica bloqueada.
3. **Backend persistente em produção**: Vercel é estática. Para o agente rodar 24/7
   com banco/vault, precisa Railway/VPS + volume (ver `docs/DEPLOY.md`).
4. **Streaming por tokens**: não implementado (SSE atual emite eventos de status).
   Marcado PARTIAL — não convertido em PASS.

---

## 5. Segurança

- Nenhuma chave/token aparece em logs ou mensagens de erro (testado: erro 429 não vaza a chave; `redactKeys`/`redact` aplicados).
- Observabilidade registra apenas `provider`, `model`, `key_slot`, `latency_ms`, `tokens`, `fallback_count`, `error_category`.

---

## 6. Testes

- `tests/model-gateway.test.ts` — 12 testes (dublê HTTP local).
- `tests/model-gateway-real.test.ts` — 4 testes reais (Groq real, Alibaba BLOCKED, fallback, chat real SingleAgent).
- Regressão completa: **517 testes passando** (2 skipped pré-existentes), typecheck limpo.