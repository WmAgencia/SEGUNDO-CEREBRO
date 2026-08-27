# Deploy — Second Brain OS

> FASE 3.7: a aplicação principal é o **chat ChatGPT-like** (`apps/agent`).
> O HQ antigo (`apps/hq`) permanece no repositório apenas como ferramenta
> local (`npm run hq`); NÃO é mais servido em produção.

## Arquitetura

```
VERCEL (frontend estático)          RAILWAY / VPS (runtime persistente)
apps/agent/public                   apps/agent/server.ts + core/ + storage/
         │                                  │
         │  HTTPS (CORS habilitado)        │
         └────────── API calls ────────────┘
                                            │
                                    ┌───────┼───────┐
                                    │       │       │
                                SQLite   OpenCode  Workers
                               (volume)    CLI     (future)
```

## O que roda onde

| Componente | Vercel | Railway/VPS | Local dev |
|---|---|---|---|
| Frontend ChatGPT-like | ✅ estático | — | ✅ |
| Agent API (`/api/*`) | ❌ | ✅ Dockerfile | ✅ `npm run agent` |
| SQLite (`brain.db`) | ❌ efêmero | ✅ volume | ✅ ficheiro local |
| OpenCode Runtime | ❌ serverless | ✅ no container | ✅ global install |
| SSE events | ❌ conexão longa | ✅ | ✅ |
| Webhook Evolution | ❌ precisa sempre-on | ✅ | ✅ |
| Obsidian Vault | ❌ filesystem | ⚠️ sync externo | ✅ path local |

---

## Deploy Backend (Railway)

### 1. Criar projeto

```bash
railway init
railway link
```

### 2. Configurar variáveis de ambiente

No dashboard Railway → Variables:

```env
AGENT_PORT=3300
SECOND_BRAIN_VAULT=/data/vault
SECOND_BRAIN_DATA_DIR=/data
```

Opcional:

```env
EVOLUTION_API_URL=...
EVOLUTION_API_KEY=...
EVOLUTION_INSTANCE=SECOM
GROQ_API_KEY_1=...
OPENROUTER_API_KEY=...
```

### 3. Adicionar volume persistente para o banco

Dashboard → Service → Volumes:
- Mount path: `/data`
- O SQLite (`brain.db`) e o vault Obsidian devem viver aqui.

### 4. Deploy

O backend inicia com `node --experimental-strip-types apps/agent/server.ts`
(Node 24). O servidor exporta `createAgentServer()` e recupera runs stale no
boot (`recoverAtStartup`).

### 5. Configurar CORS

O server já envia `Access-Control-Allow-Origin: *`; restringir em produção.

---

## Deploy Frontend (Vercel)

O `vercel.json` da raiz define:

```json
{
  "framework": null,
  "buildCommand": null,
  "outputDirectory": "apps/agent/public",
  "cleanUrls": true
}
```

Deploy: `vercel --prod` (ou push em `main` com git integration).

Após o backend estar no ar, editar `apps/agent/public/config.js`:

```js
window.SECOND_BRAIN_API = "https://teu-projeto.up.railway.app";
```

Sem backend configurado, o frontend tenta a mesma origem (dev local com
`npm run agent`).

---

## Segurança antes de expor publicamente

- [ ] Autenticação no agent server (hoje aberto).
- [ ] TLS obrigatório (Railway fornece automaticamente).
- [ ] Rate limit nos endpoints de chat.
- [ ] Restringir CORS aos domínios exatos.
- [ ] Nunca commitar `.env.local`.
- [x] Routing nunca expõe chaves completas (máscara ••••1234).

---

## Status atual

Backend: `READY TO DEPLOY` (não deployado; local-first hoje).
Frontend: `DEPLOYED` na Vercel (interface ChatGPT-like; APIs em modo
degradado até backend acessível).
