# Second Brain OS

Infraestrutura **local-first** de memória, conhecimento e contexto para
agentes de IA. O Obsidian é a memória humana; o Second Brain é a camada
computacional que indexa, relaciona e recupera esse conhecimento; o MCP é a
interface universal para agentes (OpenCode incluso).

```
OBSIDIAN ──→ INDEXER ──→ SQLITE(+FTS5) ──→ SEARCH+GRAPH ──→ ORCHESTRATOR ──→ MCP ──→ AGENTES
```

- **Custo:** R$ 0. Sem APIs pagas. Sem cloud.
- **Banco:** SQLite nativo do Node 24 (`node:sqlite` + FTS5) — reconstruível
  a partir do vault a qualquer momento.
- **IA local (Ollama):** opcional. Sem ela, tudo essencial funciona.

## Status

| Fase | Escopo | Estado |
|---|---|---|
| 0 | Inspeção do ambiente | ✅ concluída (`docs/environment.md`) |
| 1 | Core: TS, schema, config, logger, CLI base | ✅ concluída |
| 2 | Obsidian indexer incremental | ✅ concluída |
| 3 | Busca FTS5 + ranking + snippets | ✅ concluída |
| 4 | Entities + graph temporal | ✅ concluída |
| 5 | Orchestrator + ContextBuilder | ✅ concluída |
| 6 | MCP server (10 ferramentas) | ✅ concluída |
| 7 | Integração OpenCode (`docs/opencode.md`) | ✅ concluída — sessão real validada (agente `brain`, modelo free Zen) |
| 8 | IA local (llama.cpp + Qwen 3) | ✅ concluída — `ai:status`, `ai:extract` c/ confirmação |

> ⚠️ Disco C: com <1 GB livre — libere espaço antes de instalar qualquer coisa nova.

## Requisitos

- Node.js ≥ 24 (usa `node:sqlite`)
- Obsidian com um vault (qualquer pasta Markdown serve)

## Uso (após FASE 1)

```bash
npm install
set SECOND_BRAIN_VAULT=C:\caminho\do\vault   # Windows (ou $env: no PS)
brain init      # cria estrutura no vault + banco
brain index     # indexa o vault
brain search "vendas"
brain context "Vyntra"
brain health
```

## Documentação

- `docs/environment.md` — ambiente inspecionado (FASE 0)
- `docs/architecture.md` — arquitetura e decisões
- `AGENTS.md` — regras para agentes que desenvolvem este repo
- `docs/opencode.md` — integração MCP (FASE 7)
- `docs/rebuild.md` — como reconstruir o cérebro do zero
