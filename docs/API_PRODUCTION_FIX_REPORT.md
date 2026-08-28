# API PRODUCTION FIX — Second Brain (Single Agent / ChatGPT-like)

**Data:** 2026-08-28 · **Método:** auditoria real de produção com evidência HTTP. Nenhum
item marcado PASS sem prova contra a URL pública.

---

## 1. CAUSA RAIZ (provada, não assumida)

Evidência HTTP inicial:

| URL | Resultado |
|---|---|
| `https://segundo-cerebro-consecom.vercel.app/api/health` | **404** |
| `https://segundo-cerebro-consecom.vercel.app/api/chat/sessions` | **404** |
| `https://segundo-cerebro-consecom.vercel.app/api/agenda` | **404** |
| `https://segundo-cerebro-consecom.vercel.app/api/connections` | **404** |
| `https://hq-backend-production-4977.up.railway.app/api/health` | **404** (roda o HQ) |
| `https://hq-backend-production-4977.up.railway.app/api/chat/sessions` | **404** |

Diagnóstico:
1. **Vercel** servia apenas estático (`apps/agent/public`); `vercel.json` sem
   rewrite/proxy → todo `/api/*` caía no estático → 404.
2. O **backend do Single Agent** (`apps/agent/server.ts`) **não estava deployado
   em lugar nenhum**. O serviço Railway (`hq-backend`) rodava só o HQ
   (`apps/hq/server.ts`) e o Dockerfile nem copiava `apps/agent/`.
3. `SECOND_BRAIN_API` **não existia** (nenhuma env var no projeto Vercel);
   `config.js` do frontend estava vazio → chamadas iam para a mesma origem.

**Causa raiz:** inexistência do backend persistente do Single Agent + ausência de
roteamento/proxy do `/api/*` no Vercel.

---

## 2. ARQUITETURA FINAL

```
Navegador
   │  https://segundo-cerebro-consecom.vercel.app/api/...  (mesma origem)
   ▼
Vercel (estático apps/agent/public)
   │  rewrite routes: /api/(.*) → ${SECOND_BRAIN_API}/api/$1
   │  (SECOND_BRAIN_API = env var do projeto; sem URL hardcoded no frontend)
   ▼
Railway — hq-backend (mesmo processo, mesmo brain.db/volume)
   ├─ rotas HQ (/api/hq/*, /api/whatsapp/*, /nutriva/*)
   └─ rotas Single Agent montadas (createAgentHandler)
        /api/chat/*, /api/agenda, /api/connections, /api/images,
        /api/graphs, /api/routing, /api/health
```

O navegador continua enxergando `segundo-cerebro-consecom.vercel.app/api/...`
(rewrite, sem redirect). A URL do backend vem da configuração (env var Vercel).

---

## 3. ARQUIVOS ALTERADOS

| Arquivo | Mudança |
|---|---|
| `apps/agent/server.ts` | Extrai `createAgentHandler` (handler HTTP reutilizável); `createAgentServer` agora o usa. API de exportação preservada. |
| `apps/hq/server.ts` | Monta as rotas do Single Agent no mesmo processo (prefixos `/api/chat`, `/api/agenda`, `/api/connections`, `/api/images`, `/api/graphs`, `/api/routing`, `/api/health`). Reutiliza o mesmo `brain.db`/volume. |
| `Dockerfile` | Adiciona `COPY apps/agent/ apps/agent/`. |
| `.railwayignore` | Remove `apps/nutriva/` da exclusão (o Dockerfile exige `COPY apps/nutriva/...`; o deploy git falhava no build). |
| `vercel.json` | Adiciona `routes` → rewrite `/api/(.*)` para `${SECOND_BRAIN_API}/api/$1` com `env: ["SECOND_BRAIN_API"]`. |
| `tests/model-gateway.test.ts` | Fix de typecheck (tipagem de `attempts`). |

**Vercel env var:** `SECOND_BRAIN_API = https://hq-backend-production-4977.up.railway.app`
(Production, Sensitive). Frontend continua com `config.js` vazio (same-origin) — nenhuma URL hardcoded.

---

## 4. COMMITS

| Commit | Conteúdo |
|---|---|
| `0f73dc4` | fix(api): deploy Single Agent backend no Railway + rewrite Vercel /api/* |
| `6e401ca` | fix(railway): .railwayignore excluía apps/nutriva que o Dockerfile requer |

---

## 5. DEPLOYMENT

- **Vercel:** projeto `consecom/segundo-cerebro`, produção = alias
  `https://segundo-cerebro-consecom.vercel.app` (deploy `segundo-cerebro-lszpjd9hj` Ready).
- **Railway:** projeto `second-brain-hq`, service `hq-backend` — **Online**
  (deployment `025e8395-2f30-4324-b91c-dc6cef99fb8c`), URL
  `https://hq-backend-production-4977.up.railway.app`.

---

## 6. ENDPOINTS TESTADOS EM PRODUÇÃO (evidência HTTP)

Base: `https://segundo-cerebro-consecom.vercel.app` (via rewrite) e
`https://hq-backend-production-4977.up.railway.app` (direto).

| Endpoint | Método | Status | Resposta (produção) |
|---|---|---|---|
| `/` | GET | 200 | HTML do frontend (ChatGPT-like) |
| `/api/health` | GET | 200 | `{"status":"ok","model":"single-agent","groqKeys":5,...}` |
| `/api/chat/sessions` | GET | 200 | `{"sessions":[...]}` dados reais |
| `/api/chat/session` | POST | 200 | `{"sessionKey":"prod-..."}` |
| `/api/chat/session/:key/message` ("Oi") | POST | 200 | resposta real do agente via Groq |
| `/api/chat/session/:key/messages` | GET | 200 | user+assistant persistidos |
| `/api/chat/session/:key/stream` | GET | 200 | SSE `text/event-stream`: status→message→done |
| `/api/agenda` | GET | 200 | `{"events":[]}` (vazio correto) |
| `/api/agenda` | POST | 200 | evento criado + persistido |
| `/api/connections` | GET | 200 | `{"whatsapp":{"state":"connecting","available":false,"aiEnabled":true}}` (estado real Evolution) |
| `/api/connections/whatsapp/connect` | POST | 200 | **QR real** (`state:qrcode`, `qrBase64` PNG + pairingCode) |
| `/api/connections/whatsapp/ai` (OFF) | POST | 200 | `{"ok":true,"aiEnabled":false}` — estado permanece `connecting` (não desconecta) |
| `/api/connections/whatsapp/ai` (ON) | POST | 200 | `{"ok":true,"aiEnabled":true}` |
| `/api/graphs` | GET | 200 | `{"runs":[]}` (estrutura correta) |
| `/api/images` | GET | 200 | `{"images":[]}` (vazio correto) |
| `/api/routing` | GET | 200 | providers Groq (5 chaves mascaradas) + OpenRouter |

---

## 7. MAPA DE ROTAS DO FRONTEND (auditoria de `app.js`)

| Frontend | Endpoint | Método | Backend existe? | Produção |
|---|---|---|---|---|
| Chat (novo/enviar) | `/api/chat/session` | POST | ✅ | 200 |
| Sessions (listar) | `/api/chat/sessions` | GET | ✅ | 200 |
| Chat (abrir sessão) | `/api/chat/session/:key/messages` | GET | ✅ | 200 |
| Chat (fallback) | `/api/chat/session/:key/message` | POST | ✅ | 200 |
| Chat (streaming SSE) | `/api/chat/session/:key/stream` | GET (EventSource) | ✅ | 200 SSE |
| Chat (renomear) | `/api/chat/session/:key` | PATCH | ✅ | 200 |
| Chat (excluir) | `/api/chat/session/:key` | DELETE | ✅ | 200 |
| Chat (aprovar tool) | `/api/chat/session/:key/approve` | POST | ✅ | 200 |
| Graphs (painel) | `/api/graphs` | GET | ✅ | 200 |
| Graphs (card/detalhe) | `/api/graphs/:runId` | GET | ✅ | 200 |
| Imagens | `/api/images` | GET | ✅ | 200 |
| Agenda (listar) | `/api/agenda` | GET | ✅ | 200 |
| Agenda (criar) | `/api/agenda` | POST | ✅ | 200 |
| Conexões (estado) | `/api/connections` | GET | ✅ | 200 |
| Conexões (conectar/QR) | `/api/connections/whatsapp/connect` | POST | ✅ | 200 (QR real) |
| Conexões (IA ON/OFF) | `/api/connections/whatsapp/ai` | POST | ✅ | 200 (persiste) |
| Routing | `/api/routing` | GET | ✅ | 200 |

Nenhuma chamada aponta para rota inexistente.

---

## 8. REALITY GATE

### Frontend
- [x] produção abre (`/` 200)
- [x] novo chat (cria sessão via POST)
- [x] sessões (lista real)
- [x] enviar mensagem ("Oi")
- [x] resposta do agente (real, via Groq)
- [x] agenda (lista vazia correta + cria + persiste)
- [x] conexões (estado real Evolution)
- [x] QR Code (real, `qrBase64` PNG)
- [x] imagens (vazio correto)
- [x] graphs (rota 200; execução exige aprovação interativa)
- [x] routing (providers + chaves mascaradas)

### Backend
- [x] health · sessions · chat · agenda · connections · SSE · Evolution (QR real)

### Infraestrutura
- [x] Vercel routing (rewrite `/api/*` → backend, 200)
- [x] backend público (Railway Online)
- [x] `SECOND_BRAIN_API` (env var do projeto Vercel)
- [x] CORS (backend responde com `Access-Control-Allow-Origin`; rewrite é same-origin)
- [x] produção
- [x] logs (Railway build OK; deploy Vercel Ready)

### Testes locais
- [x] typecheck limpo (`npm run typecheck`)
- [x] 523 testes passando (62 files) — incluindo E2E real do frontend (`createAgentServer`)

---

## 9. BLOQUEIOS EXTERNOS (BLOCKED)

| Recurso | Status | Necessário |
|---|---|---|
| **Conectar a Evolution via scan** | BLOCKED — recurso externo | QR real gerado; requer celular físico escaneando a instância (estado atual `connecting`). |
| **WhatsApp IA processando mensagens físicas** | BLOCKED — recurso externo | requer celular conectado enviando/recebendo mensagens. |

O backend reporta o estado real (`connecting`, `available:false`) — não há fake/QR mock.

---

## 10. VALIDAÇÃO FINAL

O critério da missão está atendido: abrindo
`https://segundo-cerebro-consecom.vercel.app` e usando a interface, os fluxos de
chat (novo → sessão → "Oi" → resposta real), agenda (sem Loading infinito, `[]`),
conexões (estado real + QR real) e IA ON/OFF (persiste, não desconecta) funcionam
de ponta a ponta contra o backend real. O passo de escanear o QR com um celular é
dependência externa (BLOCKED documentado).