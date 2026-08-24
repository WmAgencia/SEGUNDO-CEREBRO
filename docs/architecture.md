# Second Brain OS — Arquitetura V1

## 1. Visão geral

```text
OBSIDIAN VAULT (fonte de verdade humana, Markdown)
        ↓  (leitura somente)
VaultIndexer ──→ brain.db (SQLite: índice reconstruível)
        ↓
SEARCH (FTS5) + GRAPH (relations) + ENTITIES
        ↓
BrainOrchestrator (resolve → roteia → busca → dedup → ranqueia → monta contexto)
        ↓
MCP Server (stdio) ──→ OpenCode / qualquer agente
```

Princípios: **local-first, custo zero, índice reconstruível, provenance,
determinístico por padrão, IA opcional**.

## 2. Camadas

### 2.1 Fonte de verdade — Obsidian Vault
- Markdown + YAML frontmatter + links `[[wiki]]` + tags.
- O sistema NUNCA modifica o vault automaticamente na V1.
- Apagar o banco e reindexar reproduz todo o estado derivado.

### 2.2 Índice — `data/brain.db` (SQLite via `node:sqlite`)
Tabelas iniciais:

| Tabela | Conteúdo |
|---|---|
| `documents` | id, path, title, type, hash, created_at, modified_at, content_length, metadata(JSON) |
| `entities` | id (estável, ex `project.vyntra`), canonical_name, type, aliases(JSON), status, metadata(JSON), source_id |
| `relations` | source_entity, relation_type, target_entity, confidence, valid_from, valid_until, source_id |
| `sources` | id, source_type(obsidian/conversation/manual/system/external), location, external_id, metadata |
| `events` | acontecimentos (indexação, mudanças, memórias) |
| `memories` | tipo(episodic/semantic/procedural/decision/relational), conteúdo, confiança, source_id |
| `chunks` | fragmentos p/ recuperação (doc_id, heading, ordinal, texto) |
| `documents_fts` | FTS5 virtual table: título+conteúdo+tags+aliases+headings |
| `index_metadata` | versão de schema, última indexação, estatísticas |

Regras:
- `hash` (sha256) evita reprocessar arquivos iguais.
- Remoções no vault marcam documento como ausente na próxima indexação.
- Relações temporais: nunca sobrescrever silenciosamente; fechar com
  `valid_until` e criar nova linha.

### 2.3 Identidade
- ID estável `type.slug` (ex.: `decision.vyntra.campaign-sequence`).
- Nome de arquivo NÃO é identidade; renomear não quebra nada.
- Aliases resolvem para a mesma entidade.

### 2.4 Recuperação (V1: lexical apenas)
- FTS5 com `bm25()` para ranking e `snippet()` para trechos.
- Filtros: type, tag, path, período.
- Busca vetorial fica para depois; a interface `Searcher` já abstrai isso.

### 2.5 Orquestração
- **BrainResolver**: "Vyntra" → `project.vyntra` (id exato > alias > nome canônico > FTS).
- **BrainRouter**: regras determinísticas escolhem fontes
  (histórico → events+decisions; relacionamento → graph; código → docs+graph...).
- **ContextBuilder**: monta bloco limitado (ENTITY, SUMMARY, STATUS, RELATED,
  DECISIONS, PROCEDURES, EVENTS, DOCUMENTS, SOURCES, WARNINGS) com teto de tokens/caracteres e dedup.
- **BrainOrchestrator**: coordena tudo e devolve resposta estruturada JSON.

### 2.6 Interface — MCP local (stdio)
Ferramentas expostas (poucas e estáveis):
`brain_search`, `brain_resolve`, `brain_get`, `brain_related`, `brain_context`,
`brain_timeline`, `brain_sources`, `brain_remember`, `brain_link`, `brain_health`.

Escritas (`brain_remember`, `brain_link`) gravam em `memories/relations`
e registram `source_type=conversation` — nunca tocam o vault na V1.

### 2.7 IA opcional
Interface `LLMProvider`; única implementação prevista: `LocalOllamaProvider`
(FASE 8). Sem Ollama, TUDO essencial funciona igual.

## 3. Layout do repositório

```text
second-brain/
├── apps/cli/            # CLI `brain` (commander)
├── core/
│   ├── orchestrator/    # BrainOrchestrator, BrainRouter
│   ├── retrieval/       # Searcher (FTS5), ranking, snippets
│   ├── indexing/        # VaultIndexer, VaultWatcher, markdown parser
│   ├── memory/          # memories (episodic/semantic/…)
│   ├── entities/        # resolver, extração heurística
│   ├── relations/       # graph queries, relações temporais
│   ├── context/         # ContextBuilder
│   ├── sources/         # registro de provenance
│   └── permissions/     # .brainignore, proteção do vault
├── mcp/                 # second-brain-mcp (stdio server)
├── storage/             # conexão node:sqlite, schema, migrações
├── connectors/obsidian/ # leitura do vault, frontmatter, links
├── schemas/             # tipos de entidade/relation aceitos (extensível)
├── tests/               # vitest (unit + integração)
├── docs/                # environment, architecture, opencode, rebuild
├── scripts/             # demo vault, utilitários
└── config/              # defaults (paths, limites)
```

## 4. Fluxo de indexação

1. Escanear vault respeitando `.brainignore` (+ ignora sempre `.env*`, chaves).
2. Para cada `.md`: calcular sha256 → comparar com `documents.hash`.
3. Mudou? parsear frontmatter, headings, tags, links, aliases, datas.
4. Extrair entidades heurísticas (links wiki, ids, aliases, nomes explícitos).
5. Upsert em documents/chunks/entities/relations + refresh FTS.
6. Registrar evento; atualizar `index_metadata`.
7. Arquivos sumidos → marcar removidos (não apagar histórico de eventos).

## 5. Decisões e trade-offs

| Decisão | Alternativa descartada | Motivo |
|---|---|---|
| `node:sqlite` nativo | better-sqlite3 | zero deps nativas; testado OK c/ FTS5 no Node 24 |
| Grafo em SQLite | Neo4j | custo zero, backup trivial, escala bem p/ uso pessoal |
| FTS5 lexical primeiro | embeddings | determinístico, auditável, rápido; vetorial depois |
| Routing por regras | LLM router | previsível, grátis, debugável; LLM opcional depois |
| MCP stdio | HTTP/SSE | padrão suportado pelo OpenCode localmente, sem portas |
| IDs `type.slug` | UUID | legíveis, estáveis, citáveis por humanos e agentes |

## 6. Segurança

- `.brainignore` obrigatório respeitado pelo indexer (default: `.env*`,
  `*.pem`, `*.key`, `**/secrets/**`, `**/credentials/**`, `.obsidian/`).
- Escrita no vault: bloqueada na V1 (futura e só c/ confirmação explícita).
- `data/brain.db` é derivável → pode ser excluído de backups sensíveis.

## 7. Fase 37 — Professional Agent Harness

`core/agents/professional-harness.ts` é a camada de orquestração sobre o
Agent OS existente. Runs persistem em `agent_runs`, checkpoints em
`agent_checkpoints`, traces estruturados em `agent_traces` e critérios
independentes em `agent_evals` (schema v9). O fluxo determinístico é
OBSERVE → CONTEXT → PLAN → WORKER → OPENCODE → TEST → EVALUATOR →
REWORK/ DOCUMENT → LEARN → SECOM → NEXT TASK.

O contexto é compilado por prioridade e limite de caracteres, ferramentas
recebem contratos e guardrails, e o sandbox do Nutriva restringe caminhos e
comandos. O vault continua somente leitura automática. Comandos administrativos
são aceitos exclusivamente quando `sender_id` e `group_id` autorizam o SECOM;
o número pessoal do owner nunca é destino administrativo.

## 8. Fase 38 — Worker e comunicação pessoal

`core/agents/world-state.ts` produz uma visão resumida dos subsistemas;
`core/agents/continuous-worker.ts` executa tarefas sequenciais, criando um
run persistido por tarefa e parando em budget, falha ou blocker.
`core/personal/personal-agent.ts` é separado do fluxo comercial: só aceita
`15981142057`, recupera contexto `PERSONAL`, aplica confiança/privacy e só
pode enviar quando `PERSONAL_AGENT_ENABLED=true`. `CUSTOMER_AUTO_SEND`
permanece desligado.

O benchmark OpenCode real fica bloqueado quando
`node_modules/.bin/opencode` não existe; não há fallback fake. A conversa com
Ana só é ativada após mensagem inbound real e contexto suficiente. A API
Evolution foi verificada como `SECOM=open`, mas nenhuma mensagem foi enviada.
