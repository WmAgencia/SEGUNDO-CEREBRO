# Deploy — Second Brain OS

## Arquitetura

```
VERCEL (frontend estático)          RAILWAY / VPS (runtime persistente)
apps/hq/public                      apps/hq/server.ts + core/ + storage/
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
| Frontend HQ | ✅ estático | — | ✅ |
| HQ API (`/api/hq/*`) | ❌ | ✅ Dockerfile | ✅ `npm run hq` |
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
HQ_HOST=0.0.0.0
HQ_PORT=3200
SECOND_BRAIN_VAULT=/data/vault
HQ_CORS_ORIGINS=https://segundo-cerebro-git-main-consecom.vercel.app,https://segundo-cerebro-consecom.vercel.app
```

Opcional:

```env
EVOLUTION_API_URL=...
EVOLUTION_API_KEY=...
EVOLUTION_INSTANCE=SECOM
OWNER_WHATSAPP=5515981817336
SECOND_BRAIN_OPERATIONS_GROUP=120363427273069174@g.us
SECOND_BRAIN_EXTERNAL_AI_URL=...
SECOND_BRAIN_EXTERNAL_AI_KEY=...
```

### 3. Adicionar volume persistente para o banco

Dashboard → Service → Volumes:
- Mount path: `/data`
- O SQLite (`brain.db`) e o vault Obsidian devem viver aqui.

### 4. Deploy

```bash
railway up
```

O `Dockerfile` instala Node 24, copia `core/`, `storage/`, `config/` e
`apps/hq/`, instala dependências e inicia o servidor na porta 3200.

### 5. Configurar CORS

Adicionar a URL do frontend Vercel em `HQ_CORS_ORIGINS`.
Por padrão é `*` (aceita tudo) — restringir em produção.

---

## Deploy Frontend (Vercel)

1. Root Directory: `apps/hq`
2. Framework: None (static)
3. Build command: vazio (estático)
4. Output directory: `public`

Após o backend estar no ar, editar `apps/hq/public/config.js`:

```js
window.HQ_API_URL = "https://teu-projeto.up.railway.app";
```

Ou usar uma env var da Vercel que substitua esse arquivo no build.

---

## Segurança antes de expor publicamente

- [ ] Autenticação no HQ server (hoje aberto).
- [ ] TLS obrigatório (Railway fornece automaticamente).
- [ ] Rate limit no `/api/hq/command`.
- [ ] Restringir `HQ_CORS_ORIGINS` aos domínios exatos.
- [ ] Nunca commitar `.env.local`.

---

## Status atual

Backend: `READY TO DEPLOY` (Dockerfile + railway.json criados, não deployado).
Frontend: `DEPLOYED` na Vercel mas mostra OFFLINE até o backend estar acessível.
