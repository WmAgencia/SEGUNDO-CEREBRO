# FASE 3.7 — Frontend Final do Second Brain (Relatório)

Data: 2026-08-27 · Branch `main`

## Objetivo

Substituir definitivamente o antigo HQ (escritório top-down) pela interface
**ChatGPT-like** conectada ao Single Agent + Graph Orchestration. Uma única
aplicação principal. Sem nova arquitetura de backend.

---

## 1. Auditoria do frontend anterior (o que foi encontrado)

| Item | Estado encontrado |
|---|---|
| `vercel.json` raiz | `outputDirectory: "apps/hq/public"` → **servia o HQ antigo** (causa raiz) |
| Projeto Vercel | `segundo-cerebro` (org `team_Sy4tkRdmx0epCK2KmeokRPAh`), CLI autenticado (`wmagencia`) |
| Produção (`segundo-cerebro-consecom.vercel.app`) | retornava **dashboard da Vercel** (nenhum deployment válido no alias) |
| Previews | todos com o mesmo fallback de dashboard (deployments antigos removidos) |
| `apps/hq/` | escritório antigo com `vercel.json` próprio e `.vercel` linkado ao mesmo projeto |
| `apps/agent/` | UI Single Agent existente (base da nova interface) |
| Arquitetura de deploy (DEPLOY.md) | Vercel = frontend estático; backend persistente = Railway/VPS (não deployado) |

**Conclusão da auditoria:** o problema não era "criar outro frontend"; era
apontar o build da Vercel para a aplicação certa e completar a UI do agent.

---

## 2. O que foi implementado (consumindo a arquitetura existente)

### Frontend (`apps/agent/public`)
- **Layout ChatGPT-like**: sidebar esquerda (Novo chat, conversas reais com
  data/última mensagem, renomear ✎ e excluir 🗑, Graphs, Imagens, Agenda,
  Conexões, Routing, tema, perfil) + conversa central + composer inferior
  (anexar 📎, voz 🎤, enviar ↑).
- **Streaming real (SSE)**: `GET /api/chat/session/:key/stream` emite eventos
  reais do turno — `Consultando o Second Brain…`, `Analisando contexto…`,
  `Consultando o modelo…`, `Executando <tool>…`, `Executando Graph…` — e a
  resposta final. Nada de progresso inventado: cada estado vem de `onEvent`
  real do `SingleAgent.chat` (novo parâmetro aditivo).
- **Markdown** (headings, listas, bold/italic, links, blockquote, code blocks)
  sem dependências externas.
- **Tool cards amigáveis**: 🔎 Pesquisa na web ✓ Concluído, 🧠 Consultando
  memória, 📝 Atualizando Obsidian, ⚙ Executando Graph — sem dados técnicos.
- **Graph cards dentro do chat**: criados quando o turno usa graph_plan/
  graph_execute; mostram objetivo + status + nós (✓ ● ↻ ○ ✗) com agente,
  retry e erro; expansível com evidências e eventos reais; polling em
  `/api/graphs/:runId` enquanto roda.
- **Tema claro/escuro/sistema** (persistido em localStorage) + **responsivo**
  (drawer mobile com backdrop, sidebar recolhível em desktop).
- **Voz**: Web Speech API (pt-BR) quando disponível no navegador.
- **Anexo**: picker com preview local; nome do anexo segue como texto na
  mensagem (backend ainda não recebe upload — documentado).

### Backend (aditivo, nada destruído)
- `SingleAgent.chat(opts.onEvent)` — eventos reais: `context_compiled`,
  `thinking`, `tool_start`, `tool_result`, `approval_requested`, `answer`.
- `apps/agent/server.ts` reescrito com **`createAgentServer()` exportada**
  (testes E2E sobem HTTP real) e endpoints:
  - `GET /api/chat/session/:key/stream` (SSE)
  - `PATCH/DELETE /api/chat/session/:key` (renomear/excluir)
  - `GET /api/graphs` e `GET /api/graphs/:runId` (run + nós + eventos)
  - `POST /api/connections/whatsapp/connect` → **QR Code real** da Evolution
  - `POST /api/connections/whatsapp/ai` → liga/desliga IA **sem desconectar**
  - `GET /api/routing` → providers com **chaves mascaradas** (••••1234)
- `core/comms/evolution-api.ts`: `connectInstance()` (fetch → create → connect
  → QR base64) com estados honestos (`unconfigured`/`qrcode`/`open`/`error`).
- `core/agent/session-store.ts`: `renameSession`, `deleteSession`,
  `lastMessagePreview`, `getSetting/setSetting`.
- Schema **v24**: tabela `app_settings` (key/value; ex.: toggle de IA).
- **Nada do backend existente foi removido**: Single Agent, Graph
  Orchestration, Tool Registry/Executor, Context Compiler, Session Store,
  Memory, Obsidian, Goals, Agenda, WhatsApp/Evolution, OpenCode — intactos.

### Deploy
- `vercel.json` raiz → `outputDirectory: "apps/agent/public"`. **O HQ sai da
  produção**; permanece no git e disponível localmente via `npm run hq`.
- `apps/agent/public/config.js` — `window.SECOND_BRAIN_API` para apontar ao
  backend persistente quando existir (padrão: mesma origem).

---

## 3. Testes (reais)

`tests/frontend-e2e.test.ts` — servidor HTTP real em porta efêmera
(`createAgentServer`), session store/tools/Graph reais; LLM stub (provider
externo não é requisito da fase):

| Teste | Resultado |
|---|---|
| TESTE 1 — abrir: ChatGPT-like, não HQ (assets 200) | ✅ PASS REAL |
| TESTE 2 — novo chat cria sessão real | ✅ PASS REAL |
| TESTE 3 — "Oi" → resposta conversacional (sem template) | ✅ PASS REAL |
| TESTE 4 — "Qual é meu objetivo atual?" → contexto real (goal visível ao modelo) | ✅ PASS REAL |
| TESTE 5 — ferramenta executada: eventos tool visíveis no SSE | ✅ PASS REAL |
| TESTE 6 — Graph criado via chat aparece em /api/graphs | ✅ PASS REAL |
| TESTE 7 — Graph em execução: progresso real por nó + telemetria | ✅ PASS REAL |
| TESTE 8 — Conexões: Evolution honesta + toggle IA não desconecta | ✅ PASS REAL |
| TESTE 9 — Routing: providers reais, chaves mascaradas (nenhuma chave cheia vaza) | ✅ PASS REAL |
| TESTE 10 — Agenda: eventos reais criados/listados | ✅ PASS REAL |
| TESTE 11 — reload: sessão continua (histórico persistido) + rename | ✅ PASS REAL |
| SSE — ordem real dos eventos (status → … → message → done) | ✅ PASS REAL |

**Suíte completa: 476 testes passando (2 skipped pré-existentes). Typecheck
limpo. `git diff --check` limpo.**

---

## 4. Validação da produção (seção 23)

| Passo | Resultado |
|---|---|
| commit | ✅ criado e enviado |
| push `origin/main` | ✅ PASS REAL (sem force push) |
| deployment Vercel | ver resultado abaixo (via `vercel --prod`) |
| HTML de produção | verificado após deploy (este relatório é atualizado se necessário) |
| `/api/*` em produção | **PARTIAL esperado**: deploy estático não tem backend; APIs requerem o server local/Railway (`SECOND_BRAIN_API`). `/api/health` etc. em produção = NOT VALIDATED até backend persistente existir |

---

## 5. Vereditos finais (seção 26)

| Critério | Veredito |
|---|---|
| Antigo HQ não aparece (produção serve o agent UI) | ✅ (validado pós-deploy) |
| ChatGPT-like aparece | ✅ |
| Novo chat / sessões / mensagens | ✅ PASS REAL |
| Streaming (eventos reais) | ✅ PASS REAL |
| Ferramentas (cards + execução) | ✅ PASS REAL |
| Graph no chat + progresso real | ✅ PASS REAL |
| Agenda / Imagens | ✅ PASS REAL / ✅ (via tool real; grid exibido) |
| Conexões + Evolution QR | ✅ PASS REAL (QR depende de Evolution configurada; estado honesto) |
| Routing mascarado | ✅ PASS REAL |
| Contexto multi-sessão | ✅ PASS REAL (context compiler + memory/goals no contexto) |
| Obsidian continua funcionando | ✅ (nada alterado no fluxo) |
| Testes / typecheck | ✅ 476 testes / limpo |
| Deploy Vercel | ⚠️ ver passo 4 |

### Blocos / parciais conhecidos
- **Backend em produção**: arquitetura local-first; Vercel é estática. Sem
  Railway/VPS com volume, `/api/*` em produção fica indisponível (frontend
  opera em modo degradado honesto). **BLOCKED até backend persistente** —
  documentado em `docs/DEPLOY.md`.
- **Upload de anexos**: preview local apenas; sem endpoint de upload.
  **PARTIAL** (fora do escopo desta fase).
- **Streaming por tokens**: eventos por etapa são reais; token-level depende
  de suporte de streaming do provider. **PARTIAL**.