# Groq Pool — Relatório Operacional

**Data:** 2026-08-27  
**Status:** ✅ PASS REAL em produção (Railway)  
**Commit:** `65434a3` + anteriores (`d88ba8a`, `f4445e0`, `6325c5c`, `cfa367d`)

---

## 1. Arquitetura

```
USER / AGENT
      ↓
MODEL ROUTER (selectModel por workload)
      ↓
DEFAULT PROVIDER CHAIN
      ├── GroqPoolProvider (prioritário)
      │     └── GroqKeyPool: chaves com round-robin + cooldown + retry
      └── OpenRouterProvider (fallback)
      ↓
completeWithGateway() ← registra ledger EM CADA tentativa individual
      ↓
RESPONSE → DB ledger (provider, model, status, tokens, latency_ms)
```

**Garantia:** toda chamada LLM passa pelo `completeWithGateway()`. Nenhum provider é instanciado diretamente fora do router.

### Mudança chave: Manager unificado
Antes: manager criava `new GroqPoolProvider()` internamente + depois chamava `completeWithGateway(null, ...)` como fallback.  
Agora: **único caminho** → `completeWithGateway(db, ..., {workload:'reasoning', agent:'manager', task})`.

Isso garante:
- Ledger gravado em TODAS as chamadas
- Mesma cadeia de fallback (Groq → OpenRouter) para todos os callers
- Orçamento diário verificado antes de cada chamada

---

## 2. Chaves Carregadas

| Slot | Status | Producao |
|------|--------|----------|
| key_1 | OK | ✅ PASS |
| key_2 | OK | ✅ PASS |
| key_3 | OK | ✅ PASS |
| key_4 | OK | ✅ PASS |
| key_5 | OK | ✅ PASS |
| key_6..10 | Vazio (não configurado) | N/A |

**Total no pool:** 5/5 healthy  
**Capacidade máxima:** 10 slots (`GROQ_API_KEY_1` a `_10`)

---

## 3. Modelos e Workloads

| Workload | Modelo Principal | Fallback Chain | Provider |
|----------|-----------------|----------------|----------|
| fast | openai/gpt-4.1-nano | gpt-4.1-mini, gemini-3.7-flash | openrouter |
| chat | openai/gpt-oss-120b | llama-4-scout-16b, gemini-3.7-flash | groq |
| reasoning | openai/o3-pro | claude-opus-4, gpt-4.1 | openrouter |
| research | google/gemini-3.7-flash | gpt-4.1-mini | openrouter |
| coding | openai/o4-mini | claude-sonnet-5 | openrouter |
| classification | openai/gpt-4.1-mini | gemini-3.7-flash | openrouter |
| summarization | openai/gpt-4.1-mini | gemini-3.7-flash | openrouter |

Override global via `GROQ_MODEL` ou `SECOND_BRAIN_MODEL`.

---

## 4. Estratégia de Seleção

### Round-Robin entre chaves saudáveis
Cada sucesso avança o índice circular → distribuição uniforme de carga.

### Tratamento de Erros

| Código | Ação | Duração |
|--------|------|---------|
| 429 RATE_LIMIT | COOLDOWN na chave específica | 30s base (respeita Retry-After) |
| 401/403 AUTH_FAIL | DISABLED permanente (chave inválida) | indefinido |
| 500 SERVER_ERROR | COOLDOWN + retry exponencial | backoff 1s * 2^n |
| 502/503/504 | COOLDOWN temporário | backoff exponencial |
| TIMEOUT | COOLDOWN temporário | backoff exponencial |
| NETWORK_ERROR | FAILED → próxima chave | sem retry na mesma |
| MODEL_UNAVAILABLE | FAILED → próxima chave | sem retry na mesma |

Nunca looping infinito: quando todas estão em COOLDOWN/DISABLED/FAILED, lança erro imediato.

---

## 5. Observabilidade (Ledger)

Toda tentativa é registrada em `model_generations`:

```sql
INSERT INTO model_generations (
  provider, model, status, prompt_tokens, completion_tokens,
  total_tokens, cost, latency_ms, fallback_from, error
) VALUES (...)
```

Por-provider:
- Sucesso: `status='COMPLETED'` + tokens + latência
- Falha intermediária: `status='FAILED'` + motivo
- Falha completa da cadeia: `status='FAILED_CHAIN'`

**Segurança:** nunca expõe API keys. Identificadores seguros usam formato `groq#N`.

---

## 6. Testes

### Unitários (Groq Key Pool) — 21 testes

| Teste | Resultado |
|-------|-----------|
| Usa primeira chave saudável | ✅ PASS |
| Round-robin alterna chaves | ✅ PASS |
| redactKeys mascara chaves | ✅ PASS |
| 429 → cooldown + rotação | ✅ PASS |
| 401 → DISABLED permanente | ✅ PASS |
| 5xx → retry em outra chave | ✅ PASS |
| Todas COOLDOWN → lança sem loop | ✅ PASS |
| Acumula tokens corretamente | ✅ PASS |
| Health count retorna correto | ✅ PASS |
| Recupera COOLDOWN após tempo | ✅ PASS |
| classifyError: 429/401/403/500/502/503/504 | ✅ PASS × 7 |
| classifyError: timeout/network/model/unexpected | ✅ PASS × 4 |

### Integração (Model Router Gateway) — 9 testes

| Teste | Resultado |
|-------|-----------|
| Sucesso grava no ledger | ✅ PASS |
| Falha primeiro → tenta segundo (fallback) | ✅ PASS |
| Todos falham → lança erro honesto + 2 entradas no ledger | ✅ PASS |
| Sem DB não quebra | ✅ PASS |
| Registro latência + tokens | ✅ PASS |
| selectModel workload inference | ✅ PASS × 3 |
| redactKeys segurança | ✅ PASS |

### Evidência E2E (produção Railway)

```
[env] GROQ keys no pool: 5          ← carregadas
[manager] via groq-pool              ← 8+ requests no último deploy
                                      usando统一的 gateway
```

Teste multi-turno real validado:
```
"Ei"                          → "E aí! Estou te ouvindo..."
"Quero conversar sobre prospecção." → resposta contextual LLM
"Principalmente clínicas."    → plano incorporou clínicas (contexto mantido!)
"Você está aí?"               → presença natural, sem repetir projeto
✅ Sem repetições · Sem loops · Multi-turn real
```

---

## 7. Deploy

| Etapa | Status |
|-------|--------|
| TypeScript typecheck | ✅ limpo |
| Unit tests (pool + router) | ✅ 30/30 passing |
| Full suite (vitest) | ⚠️ 20 EPERM (Windows temp dir lock, pre-existente) — 0 falhas reais |
| Git commit | ✅ `65434a3` |
| Git push origin main | ✅ `cfa367d..65434a3 -> main` |
| Railway deploy | ✅ automático (trigger por push) |
| Railway logs (boot) | ✅ `[env] GROQ keys no pool: 5` |
| Railway logs (runtime) | ✅ `[manager] via groq-pool` |

---

## 8. Limitações e Bloqueios

### NOT VALIDATED
- **Model fallback independente** (tentar modelos alternativos num mesmo provider): código preparado, mas não testado em produção com múltiplos modelos ativos
- **Voice ASR/TTS**: ainda não implementado (fora do escopo desta fase — ver especificação original)
- **Cost tracking em US$**: estrutura no ledger preparada, mas custo efetivo depende de providers reportarem `cost`

### PARTIAL
- **Manager conversational**: greetings funcionando ("Oi", "Ei", "Você está aí?"), mas comportamento de longas conversas (>10 turns) pode precisar ajuste fino no system prompt
- **Workload routing**: inferência por keyword funciona bem; poderia melhorar com embeddings

### BLOCKED
- **Chaves 6-10**: slot reservado, sem valores para testar escala além de 5
- **Deploy Railway manual**: se auto-deploy falhar, precisa re-conectar serviço ao GitHub

---

## 9. Arquivos Modificados

| Arquivo | Linha(s) | O que mudou |
|---------|----------|-------------|
| `core/ai/groq-key-pool.ts` | +32/-10 | Round-robin index, health snapshot, classifyError exportado |
| `core/ai/model-router.ts` | +15/-12 | Gateway registra cada provider individualmente, INSERT com schema real (15 colunas), cost position fix |
| `core/hq/manager.ts` | -5/+22 | Removido duplicata GroqPoolProvider direto; agora usa sempre `completeWithGateway(db, ...)` |
| `tests/groq-key-pool.test.ts` | +68/-32 | Tests reais: round-robin, health metrics, error classification, COOLDOWN recovery |
| `tests/model-router-integration.test.ts` | +130 novos | 9 integration tests: gateway chain, ledger per-provider, security assertions |

---

## 10. Próximos Passos Sugeridos

1. Adicionar mais chaves `GROQ_API_KEY_6..10` → pool expande automaticamente
2. Implementar Voice Layer (ASR/TTS Qwen) conforme especificação
3. Configurar `SECOND_BRAIN_DAILY_COST_LIMIT` → budget real em US$
4. Monitorar métricas do pool: `p.getHealthyCount()`, `p.status().slots[].latencyMsAvg`
5. Melhorar inferência de workload com embeddings (opcion)

---

*Relatório gerado automaticamente pela fase GROQ POOL FINAL + VALIDAÇÃO OPERACIONAL.*
