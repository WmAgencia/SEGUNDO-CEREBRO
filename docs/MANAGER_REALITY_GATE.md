# MANAGER REALITY GATE

Data: 2026-08-26

## Resultado

| Critério | Status | Evidência |
|---|---|---|
| Gerente conversa naturalmente | **PASS REAL** | LLM Groq gpt-oss-120b responde com contexto real |
| Contexto multi-turno | **PASS REAL** | teste manager-agentic-llm (sessão única, 6 turnos) |
| Anti-loop (não repete pergunta) | **PASS REAL** | `extractTopic` não usa texto bruto; fallback varia; testes 4/4 determinísticos |
| Anti-menu-genérico | **PASS REAL** | asserções not.toContain("quer que eu aprofunde") / not.toMatch("posso criar um objetivo") |
| "consulta o estado dele" responde dados | **PASS REAL** | projeto + agente + tarefas do banco |
| LLM real funciona | **PASS REAL** | Groq gpt-oss-120b (log `LLM responded via groq/...`) |
| Fallback determinístico honesto | **PASS REAL** | `contextCards: LLM não configurado` quando sem chave |
| Modo CHAT/BRAIN/PLANE/BUILD | PASS | preservado; modo persiste na sessão |
| Queue plan: criação de goal/initiative/task | PASS (pré-existente) | doExecute/executeRealPlan |
| Tool calling / delegação real | **PARTIAL** | fluxo de delegação existe; tool-calling LLM explícito ainda não completo |
| OpenCode worker real | NOT VALIDATED | depende do runtime externo |
| Execução paralela real | PARTIAL | runInitiativeParallel existe; não re-exercitado nesta rodada |

## Testes
- **npm test: 345/345** (45 arquivos) — inclui 4 novos determinísticos + 2 LLM-real opt-in.
- **typecheck: limpo**
- Testes LLM-real rodam só com `GROQ_API_KEY` (opt-in) — determinísticos garantem CI verde.

## Limitação honesta
- Alguns turnos do LLM caem para OpenRouter (402 = sem crédito) quando Groq falha/rate-limited;
  o fallback determinístico assume honestamente (`contextCards`). Não é sucesso artificial.
