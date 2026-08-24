# Deploy — Second Brain OS

## Arquitetura honesta

O Second Brain tem duas naturezas:

1. **Runtime persistente** (SQLite local, OpenCode CLI, workers, webhook server,
   HQ server). Requer máquina/host com Node 24+, filesystem e processos
   de longa duração.
2. **Frontend estático** (`apps/hq/public`). Pode ser servido por qualquer CDN.

## O que a Vercel pode hospedar hoje

- `apps/hq/public` como site estático (após apontar `fetch` para a URL do HQ server).

## O que NÃO roda na Vercel (sem mudança arquitetural)

- `brain.db` (SQLite em arquivo) — Vercel é efêmero/serverless.
- `OpenCodeRuntime` (spawn de processo CLI).
- Webhook Evolution (precisa endpoint sempre-on; usar Railway/Fly/VPS).

## Caminho recomendado

| Componente | Host sugerido |
|---|---|
| HQ frontend | Vercel (estático) |
| HQ API + Runtime | VPS/Railway/Fly.io (`npm run hq`) |
| Webhook Evolution | mesmo host do runtime (`core/webhooks`) |
| Tunnel dev | Cloudflare Tunnel / ngrok |

## Preparar deploy estático do HQ na Vercel

```bash
cd apps/hq/public
vercel --prod
```

Configurar variável de ambiente no frontend (ou hardcode) apontando
`VITE_API_BASE` / `API_BASE` para a URL pública do runtime.

## Segurança antes de expor publicamente

- [ ] Adicionar autenticação ao HQ server (hoje é localhost-only).
- [ ] TLS obrigatório.
- [ ] Rate limit no `/api/hq/command`.
- [ ] Nunca expor `.env.local` (Evolution keys etc.).

## Status atual

`NOT DEPLOYED` — preparação concluída, deploy real pendente de decisão
de infraestrutura externa (requer autorização do owner).
