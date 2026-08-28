# AGENT RUNTIME — Reality Gate Final (Fase de Consolidação)

Data: 2026-08-27 · Branch `main`
Princípio seguido: **consolidar, não multiplicar**. Nenhuma arquitetura paralela
criada. O runtime real (`single-agent.ts` + Graph Engine + OpenCode runner) foi
auditado, corrigido e endurecido.

---

## 1. Resultado da auditoria (o que foi encontrado)

| Componente | Estado encontrado | Ação |
|---|---|---|
| `core/agent/single-agent.ts` | **Runtime real** (LLM + tools + sessão + contexto) | endurecido com salvaguardas do loop |
| `core/agent/agent-loop.ts` | **MOCK** ("Mock implementations") — código morto | identificado como morto; o loop real é o `single-agent.ts` |
| `core/agent/chat-engine.ts` | **MOCK** com respostas determinísticas fake | identificado como morto (nada o importa) |
| `core/agent/context-compiler.ts` | real, just-in-time, com budget | reutilizado |
| `core/agent/tools/*` | 19 tools reais (schema/permission/risk/approval) | reutilizadas |
| Graph Engine | real (DAG/scheduler/executor/evaluator/rework/recovery) | reutilizado |
| OpenCode runner | real porém com bug de resolução de comando | **corrigido** (FASE 4) |
| Evaluator | real (`require`/`requireCount`/`requireField`) | reutilizado |
| Obsidian | `persistGraphOutcome`/`persistGoalNote` com dedup | reutilizado |

**Decisão de consolidação:** os mocks `agent-loop.ts`/`chat-engine.ts` não são
usados pelo runtime (nada os importa além do SPEC.md). O loop autônomo real vive
em `single-agent.ts`. As salvaguardas da seção 2 foram implementadas **dentro do
loop existente**, sem novo módulo de orquestração.

---

## 2. O que foi consolidado/corrigido nesta fase

1. **Loop autônomo real** (`single-agent.ts`), adicionando o que faltava da seção 2:
   - `maxTurns` (já existia);
   - **timeout do loop** (`loopTimeoutMs`, padrão 180s) — para por tempo;
   - **kill switch** (`opts.signal` AbortSignal) — "Pare" interrompe imediatamente;
   - **detecção de loop infinito / ferramenta repetida** — mesma tool+input chamada
     `maxRepeatedToolCalls` (3) vezes sem progresso → para com mensagem honesta;
   - **detecção de falha persistente** — mesma tool falhando `maxPersistentFailures`
     (3) vezes seguidas → para e oferece outra abordagem;
   - observabilidade via `onEvent` (context_compiled/thinking/tool_start/tool_result/
     approval_requested/answer) e provenance no `session-store`.

2. **Decisão SIMPLE/TOOL/PLAN/GRAPH natural**: `classifyIntent` (planner) injetado no
   contexto como **dica** (`INTENÇÃO SUGERIDA`), não ordem — o LLM mantém a decisão.
   "Oi" não vira Graph; multi-etapas com dependências vira Graph.

3. **Refino do planner**: "prospecção" genérica não força GRAPH. Apenas build concreto
   ("sistema de prospecção", "funil de vendas", "captação de clientes") vira GRAPH;
   "melhorar minha estratégia de prospecção" agora é PLAN (análise antes de executar).

4. **Suíte conversacional + salvaguardas** (`tests/agent-runtime-consolidation.test.ts`,
   16 testes reais): decisão de intenção, conversa natural sem template de roteador,
   busca de contexto, execução de tool, kill switch, retomada de sessão, loop infinito,
   falha persistente, timeout, dica de intenção, autonomia A/C.

---

## 3. Tabela Reality Gate (seção 20)

| Capacidade | Estado | Evidência |
|---|---|---|
| Chat real | **PARTIAL** | loop/sessão/contexto reais validados; conclusão via LLM real depende de capacidade (Groq 8k TPM / OpenRouter sem créditos) — testado com LLM stub, documentado |
| Contexto | **PASS REAL** | `compileContext` just-in-time, budget, dedup, provenance; nada do Obsidian inteiro no prompt |
| Obsidian | **PASS REAL** | `persistGraphOutcome`/`persistGoalNote` com dedup (procura antes de criar), sem dump de log |
| Memory | **PASS REAL** | `persistTurnMemory` conservador (decision/idea/preference/goal) + sessão persistida; nada importante some ao fim da sessão |
| Tools | **PASS REAL** | 19 tools reais com schema/permission/risk/approval/timeout/provenance; executadas nos testes |
| Tool loop | **PASS REAL** | maxTurns + timeout + kill switch + detecção de repetição e de falha persistente (testes dedicados) |
| Planning | **PASS REAL** | `classifyIntent` SIMPLE/TOOL/PLAN/GRAPH + planner DAG; intenção sugerida no contexto |
| Graph | **PASS REAL** | DAG validado, scheduler, executor, evaluator, rework, recovery — execução real |
| Subagents | **BLOCKED** | definidos `mode: all` e invocáveis; sem capacidade de LLM para concluir de verdade |
| Parallelism | **PASS REAL** | maxActive=3 provado por sobreposição real de timestamps (3 web_search concorrentes) |
| Evaluator | **PASS REAL** | evidência real (`require`/`requireCount`/`requireField`); FAIL honesto, nunca sucesso falso |
| Rework | **PASS REAL** | FAILED→evidência→REWORK→RETRY→SUCCESS com retryCount (2 falhas + 1 sucesso reais) |
| Recovery | **PASS REAL** | interrupção→`recoverStaleRuns`→`prepareResume`; COMPLETED não re-executado (mesmo completedAt) |
| OpenCode | **PARTIAL** | CLI instalada e realmente invocada (sessão criada, parsing honesto, `resolveOpenCodeCommand` corrigido); conclusão bloqueada por capacidade de LLM |
| Production | **PARTIAL** | frontend Vercel live (ChatGPT-like, sem HQ); backend é estático (sem runtime persistente) — requer Railway/VPS; LLM real em produção requer chaves |

**Resumo:** 9 PASS REAL · 4 PARTIAL · 1 BLOCKED · 0 FAIL.
Nenhum fallback convertido em PASS; bloqueios de provider documentados.

---

## 4. Bloqueios honestos (não mascarados)

- **LLM para conclusão de agente/subagente**: Groq free 8k TPM vs contexto do agente;
  OpenRouter sem créditos. Precisa de créditos OpenRouter ou Groq tier superior.
- **Backend persistente em produção**: Vercel é estática. Para o agente rodar 24/7 com
  banco/vault, precisa Railway/VPS + volume (ver `docs/DEPLOY.md`).
- **Subagentes OpenCode concluindo tarefas**: depende do item LLM acima.

---

## 5. Testes

- `tests/agent-runtime-consolidation.test.ts` — 16 testes (conversacional + salvaguardas).
- Regressão completa: **501 testes passando** (2 skipped pré-existentes), typecheck limpo,
  `git diff --check` limpo.
- Testes reais de Graph/OpenCode/paralelismo/rework/recovery em
  `tests/graph-runtime-real.test.ts` (FASE 4).