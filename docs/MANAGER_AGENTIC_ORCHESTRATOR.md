# MANAGER AGENTIC ORCHESTRATOR

## Arquitetura anterior (problema)
O Gerente era um **classificador determinístico de comandos**:
```
USER → CLASSIFIER (palavra-chave) → IF → TEMPLATE → RESPOSTA
```
Sintomas reais:
- `answerOperationalStatus`/`tryAnswerStatus` interceptavam perguntas de estado ANTES do LLM
→ respostas genéricas ("Nada concluído ainda hoje", "registrado sem tarefas, quer que monte um plano?").
- `extractTopic` usava o **texto bruto** como tópico quando não reconhecia palavra-chave
→ "sobre **quero melhorar isso** — quer que eu aprofunde..." (loop exato relatado).
- Bloco `s.topic` genérico repetia a mesma pergunta.

## Arquitetura nova: LLM-FIRST
```
USER → SESSION → CONTEXT COMPILER → LLM (decide) → RESPOSTA/TOOL
                        ▲                          │
                        └──── OBSERVATION (fallback s/ LLM) ◄─┘
```

1. **Chamada LLM ANTES do roteador determinístico** (via Model Router Groq→OpenRouter).
2. **Roteadores determinísticos** só para comandos explícitos (stop/resume/mode) e confirmações
   (executam ações reais) + como **fallback final** quando LLM indisponível.
3. **Prompt de sistema reforçado**: agir com dados reais (não perguntar de volta), anti-repetição,
   responder estado em um parágrafo.
4. **`extractTopic` corrigido**: só retorna tópico conhecido (nutriva/vyntra/clipcom/sueli/prospec/
   vendas/marketing) — nunca texto bruto.
5. **Anti-loop no fallback**: `projectStateLine(db, topic)` responde estado real do projeto em vez
   de "quer que eu aprofunde?"; abertura genérica variada por índice da sessão.

## Arquivos alterados
- `core/hq/manager.ts`: fluxo LLM-first, prompt, extractTopic, projectStateLine, generic anti-loop.

## Testes
- `tests/manager-agentic.test.ts` (determinístico, 4 testes): anti-loop, sem menu genérico.
- `tests/manager-agentic-llm.test.ts` (LLM real Groq, opt-in, 2 testes): conversa §30 sem repetição,
  resposta de estado com dados reais.

## Evidência (LLM real Groq gpt-oss-120b)
```
USER: Como está o Prospector?        → status PLANED + agente PAUSED + sem tarefas (real, sem pergunta)
USER: consulta o estado dele          → mesmo assunto, mais detalhe (não repete)
USER: Quero melhorar isso             → plano estruturado
```
