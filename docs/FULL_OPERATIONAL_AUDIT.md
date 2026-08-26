# FULL OPERATIONAL AUDIT — Second Brain HQ

**Data:** 2026-08-26 · **Método:** auditoria real de produção (Railway) + teste de reprodução, não apenas unitários.

---

## RESUMO EXECUTIVO

O backend de produção (**hq-backend-production-4977.up.railway.app**, projeto `second-brain-hq` / service `hq-backend`, deploy `073f51d7`) está **online e operacional**. A auditoria real encontrou e corrigiu **1 bug de classificação** e confirmou que a produção estava em **build desatualizado** (faltavam o endpoint de controle de IA e o merge de estado das instâncias WhatsApp) — **resolvido com deploy do build corrigido**.

### Evidências de produção (HTTP 200)
| Endpoint | Resultado |
|---|---|
| `/` | HTML do HQ |
| `/api/hq/state` | 19 agentes, 9 departamentos |
| `/api/hq/debug/status` | determinístico OK |
| `/nutriva/api/health` | `{status:ok, engines:[plans,substitutions,recipes]}` |

---

## CLASSIFICAÇÃO POR CAPACIDADE

### ✅ PASS REAL

| Capacidade | Teste | Evidência |
|---|---|---|
| **Deploy corrigido live** | `railway up` → deploy `073f51d7` SUCCESS | endpoints AI passaram a responder (200) após deploy |
| **Gerente chat (saudação/tópico)** | `POST /api/hq/command` "Oi" | resposta conversacional imediata, intent=CHAT |
| **Gerente LLM** | mensagem de estratégia | Groq `openai/gpt-oss-120b` respondeu com contexto (sessão anterior); fallback determinístico é honesto (`contextCards`) |
| **Pipeline Goal→Initiative→Tasks→Dispatch** | "Criar site..." + confirmar | Goal + 6 tasks + dispatch; **engineering-agent op=WORKING** |
| **Intenção dominante** | reprodução local + produção | "campanha/clínicas sem site" já NÃO vira dev (ver correção) |
| **Evolution connect** | `/instance/fetchInstances` + `/connect/SECOM` | SECOM `connecting`; QR **real** (code 237 chars + base64 PNG) |
| **WhatsApp IA ON/OFF** | `POST /api/whatsapp/ai/SECOM` | aiEnabled true/false persiste; Evolution continua `connecting` (não desconecta) — spec §10 |
| **Painel instâncias** | `GET /api/whatsapp/instances` | mescla estado Evolution + local (aiEnabled/assignedAgent) |
| **MCP** | spawn stdio + `tools/list` | **41 tools brain_*** registradas e respondendo |
| **SSE / event-stream** | `GET /api/hq/events` | evento real `{id,type GOAL_CREATED, data, occurredAt}` em stream |
| **Estado dos agentes** | `GET /api/hq/state` | 19 agentes; **nenhum PAUSED artificial** — derivado de dados reais (runs/tasks/kill) |
| **Segredos** | `git grep` + `git ls-files` | **nenhum** segredo commitado; `.env.local` untracked |

### ⚠️ PARTIAL

| Capacidade | Teste | Evidência / porquê |
|---|---|---|
| **Manager contexto multi-fonte** | LLM real | LLM consulta goals/tasks do banco, mas a consulta a Obsidian/memórias não foi exercitada end-to-end nesta sessão |
| **IA OFF processa+registra** | sem mensagem física | fluxo webhook (ai_skipped) provado em teste automatizado; mensagem física requer celular conectado |
| **NUTRIVA auth/tenant** | `/nutriva/api/health` | health OK; CRUD/auth real não exercitado nesta sessão (testes unitários passam) |

### 🔴 BLOCKED (depende de recurso externo)

| Capacidade | O que falta |
|---|---|
| **Prospector real** | `GOOGLE_MAPS_API_KEY` ausente → fontes registram `BLOCKED_SOURCE` (comportamento correto). **NEEDED:** chave Google Maps |
| **OpenCode worker real** | runtime/workspace externo não exercitado; requires deployment de workers. **NEEDED:** ambiente OpenCode |
| **N8N** | `N8N_BASE_URL` ausente → adapter retorna BLOCKED honesto |
| **WhatsApp inbound físico** | requer celular real enviando mensagem ao número conectado (instance em `connecting`) |

### ❌ FAIL (encontrado nesta auditoria)

| Item | Evidência | Correção | Commit |
|---|---|---|---|
| **Intenção: "campanha para clínicas que não têm site" → dev** | classificado "Projeto: ... Registrar no Drive" (errado) | adicionada **moldura de prospecção** (negation/cliente frame) no `classifyCreativeIntent`; agora → plano genérico/de prospecção | `b3aa204` |
| **Produção em build antigo** (sem `/api/whatsapp/ai/*`, sem merge de estado) | endpoint 404, `aiEnabled` vazio | `railway up` deploy do build corrigido | `073f51d7` |

---

## CORREÇÕES APLICADAS NESTA AUDITORIA

1. **`core/hq/manager.ts`** — bug de intenção: negação/moldura "empresas sem site"/"campanha" não é mais tratada como pedido de build. **Commit `b3aa204`** (testes 335/335 verdes).
2. **`.gitignore`** — protegido contra vazamento de `.env`/segredos/`.db`. **Commit `4224de2`**.
3. **Deploy** — unificado build local → produção (`railway up`, service `hq-backend`).

## MUDANÇAS DE ARQUITETURA NÃO NECESSÁRIAS

Não foi necessário criar sistema paralelo: reutilizei o Model Router (Groq→OpenRouter), o harness de agentes, o execution-engine/policy, o event-stream e o knowledge-layer existentes. Nada duplicado.

## QUAIS CREDENCIAIS O AMBIENTE JÁ TEM
- `GROQ_API_KEY` (LLM real) ✅ · `EVOLUTION_API_URL/KEY` (WhatsApp real) ✅ · `OPENROUTER_API_KEY` (via Railway) ✅ · Drive creds ✅

## O QUE FALTA PARA DESBLOQUEAR
```
BLOCKED: Prospector em fontes reais
NEEDED:  GOOGLE_MAPS_API_KEY (ou fonte pública autorizada plugada em ProspectingSource)

BLOCKED: OpenCode worker ponta-a-ponta
NEEDED:  ambiente OpenCode / worker runtime (workspaces)

BLOCKED: N8N como execution fabric
NEEDED:  N8N_BASE_URL

BLOCKED: mensagem WhatsApp física
NEEDED:  celular conectado na instância SECOM (instance em 'connecting')
```

---

*Relatório gerado com evidência real de produção. Nenhum item marcado PASS sem prova de execução; limitações externas declaradas como BLOCKED com o recurso necessário especificado.*
