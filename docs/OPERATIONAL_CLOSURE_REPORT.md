# OPERATIONAL CLOSURE REPORT

**Data:** 2026-08-25 · **Fase:** Operational Closure — Gerente + Prospecção + WhatsApp + Contexto

---

## 1. O QUE JÁ EXISTIA (auditado, reutilizado)

| Capacidade | Local |
|---|---|
| Gerente com LLM via Model Gateway | `core/hq/manager.ts` → `completeWithGateway` |
| OpenRouter provider c/ fallback chain (`models[]`, `route:"fallback"`) | `core/ai/model-router.ts` |
| Context Compiler do Gerente (goals/projects/tasks/agents/runs/memórias FTS/histórico) | `buildSystemContext` |
| Evolution API client (send/state/fetch) | `core/comms/evolution-api.ts` |
| Proxy multi-instância WhatsApp no server (`/api/whatsapp/*`) | `apps/hq/server.ts` |
| Webhook inbound completo (dedupe→intent→perfil→draft→approval→owner cmds) | `core/webhooks/evolution-webhook.ts` |
| Agentes especializados (Prospector, Research, Comercial 01–04, Dev 01–04, QA, Integrator) | `core/agents/specialized.ts` |
| Interface ProspectingSource + LeadCandidate | `specialized.ts` |
| Persistência Obsidian de Goals/Initiatives | `core/obsidian/knowledge-records.ts` |

## 2. O QUE FOI CORRIGIDO

1. **HTTP 402 real do OpenRouter**: conta autentica mas só comporta 691 tokens; `maxTokens` do Gerente 800→**550** → LLM passou a responder DE VERDADE.
2. **Política inbound retrocompatível**: sem config explícita de instância → PROCESS (não quebra deployments existentes).
3. **Contador diário de prospecção**: usava relógio real vs data simulada → migrado para contador determinístico em `working_memory`.
4. **Fila comercial**: aceita leads NEW e QUALIFIED (antes só QUALIFIED).

## 3. O QUE FOI IMPLEMENTADO (novo)

| Módulo | Conteúdo |
|---|---|
| `storage/schema.ts` **v20** | Tabelas `leads` (20+ campos c/ provenance) e `whatsapp_instances`; migration 19→20 |
| `core/comms/leads.ts` | Entidade Lead completa; dedupe global por telefone E website normalizado; scoring determinístico ponderado (`SIGNAL_WEIGHTS`); list/status/stats |
| `core/comms/instance-state.ts` | IA ON/OFF **independente de conexão**; assigned_agent por instância; gate `inboundPolicy` |
| Webhook × política | IA off → mensagem persistida, agente NÃO responde (`ai_disabled_message_persisted_no_reply`) |
| `apps/hq/server.ts` | `GET /instances` agora mescla estado Evolution+local; `POST /api/whatsapp/ai/:name {enabled}` toggle |
| `core/obsidian/conversation-notes.ts` | Notas de conversa navegáveis em `08 - Context/Conversations/` (frontmatter id/provenance/topic; append por turno) + notas de Decisão |
| Gerente × Obsidian | Todo turno user/manager vira contexto Markdown (falha Obsidian não quebra chat) |
| Honestidade LLM | Sem chave → `contextCards[{label:"LLM", value:"não configurado…"}]` — nunca finge consulta |
| `core/comms/prospector-scheduler.ts` | Janela 23→07 (overnight), daily budget, request budget, kill switch, BLOCKED_SOURCE registrado + ciclo continua, queue p/ comercial |

## 4. TESTES REAIS EXECUTADOS (evidência)

### Reality Gates com sistema real
| Gate | Resultado | Evidência |
|---|---|---|
| A — "Oi" | ✅ PASS | Resposta conversacional imediata |
| B — prospecção | ✅ PASS | **LLM REAL** `openrouter/google/gemini-3.7-flash` (7269ms) citou meta R$3.000 e tarefas de outreach DO BANCO |
| C — ideia clientes/sites | ✅ PASS | **LLM REAL** (6289ms): estratégia c/ tickets R$1.000–1.500, sem executar nada |
| F — QR WhatsApp | ✅ PASS REAL | `fetchInstances` HTTP 200 (SECOM state=close); `connect` retornou **QR genuíno**: string `2@…` + PNG base64 |
| Suite automatizada | ✅ 21 novos testes | Schema v20, leads (dedupe/scoring/provenance), instance state (IA≠conexão), webhook×política (OFF=sem draft, ON=draft), scheduler (janela/kill/budget/BLOCKED_SOURCE/queue), Obsidian conversations |
| Regressão total | ✅ **304/304** (39 arquivos) | 283 pré-existentes preservados |
| typecheck / git diff --check | ✅ limpos | só warnings benignos CRLF |

### Testes NÃO executáveis nesta máquina
| Gate | Motivo preciso |
|---|---|
| G/H/I — mensagem inbound REAL chegando ao webhook | Exige alguém enviar WhatsApp de um celular real para o número conectado; pipeline+política provados em teste automatizado com payload idêntico ao da Evolution |
| D — execução ponta-a-ponta de Goal→Dispatch→OpenCode | Requer backend HQ rodando em produção (Railway) com workers ativos |
| E — lead REAL descoberto na internet | GOOGLE_MAPS_API_KEY ausente → fonte registrada como BLOCKED_SOURCE (comportamento correto); pipeline provado com fonte autorizada injetada em teste |

## 5. CREDENCIAIS NECESSÁRIAS

| Credencial | Status | Efeito se adicionada |
|---|---|---|
| OPENROUTER_API_KEY | ✅ presente (.env.local) | LLM já operacional (crédito free limita tokens/resposta) |
| EVOLUTION_API_URL/KEY | ✅ presentes (env) | QR real já obtido |
| GOOGLE_MAPS_API_KEY | ❌ MISSING | Habilitaria DISCOVER real no pipeline de prospecção |

## 6. BLOCKERS REMANESCENTES

1. Inbound end-to-end depende de mensagem física num celular conectado.
2. Prospecção em fontes reais depende de credencial Maps (ou fontes públicas autorizadas a plugar em `ProspectingSource`).
3. Execução OpenCode paralela valida-se melhor em produção (Railway) onde os workspaces vivem.

## 7. NÚMEROS FINAIS

- Testes: **304/304** (39 arquivos) — 283 legados + 21 novos, zero regressões
- typecheck: limpo · `git diff --check`: limpo
- Schema: **v20**
- Commit: ver hash abaixo (apenas arquivos da fase; `core/second-brain.db` excluído por ser descartável)

*Regra mantida: nada marcado PASS sem evidência; provider failures registrados textualmente (ex.: HTTP 402 original).*
