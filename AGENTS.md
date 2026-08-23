# AGENTS.md — Second Brain OS

Você está trabalhando no **Second Brain OS**: infraestrutura local-first de
memória, conhecimento e contexto para agentes de IA.

## Objetivo

Qualquer agente (OpenCode ou outro) deve conseguir consultar um cérebro
compartilhado e descobrir o que existe, onde existe, como se relaciona,
quando mudou, de onde veio e quanto confiar.

## Princípios inegociáveis

1. **local-first** — tudo roda na máquina; nada de cloud obrigatória.
2. **custo zero** — nenhuma API paga, nenhum serviço pago.
3. **fonte de verdade preservada** — o Obsidian Vault é sagrado; NUNCA
   modificar/apagar notas automaticamente (escrita futura só com confirmação).
4. **índices reconstruíveis** — `brain.db` é descartável; apagar + reindexar
   deve reproduzir tudo. Nunca guardar informação só no banco.
5. **provenance** — toda informação tem fonte (`obsidian`, `conversation`,
   `manual`, `system`, `external`). Nunca apresentar inferência como fato.
6. **determinístico por padrão** — heurística/SQLite/FTS5 primeiro; LLM é
   opcional (Ollama) e nunca requisito.
7. **segurança** — respeitar `.brainignore`; jamais indexar `.env*`, chaves,
   tokens, credenciais.
8. **modularidade** — camadas independentes: indexing → storage → retrieval →
   orchestrator → mcp.
9. **simplicidade** — a solução mais simples que funciona vence.
10. **testes** — cada fase sai com testes passando; não avançar com testes
    quebrados.

## Regras de implementação

- TypeScript estrito, Node 24, ESM.
- Banco: `node:sqlite` nativo (DatabaseSync). Não instalar better-sqlite3 sem
  necessidade real documentada.
- Dependências novas exigem justificativa: se dá pra fazer com stdlib, faça
  com stdlib.
- IDs estáveis no formato `type.slug` (ex.: `project.vyntra`). Nome de arquivo
  nunca é identidade.
- Relações temporais: fechar com `valid_until` + criar nova linha; nunca
  sobrescrever histórico silenciosamente.
- Contexto retornado ao agente deve ser LIMITADO e deduplicado, nunca "tudo".
- Não inventar APIs: conferir assinaturas reais (`node:sqlite`, MCP SDK).
- Documentar decisões arquiteturais em `docs/architecture.md`.
- Antes de cada fase: inspecionar estado → explicar plano → implementar →
  testar → corrigir → documentar → checar regressão.

## Comandos úteis (a partir da FASE 1)

```bash
npm run build        # compila TypeScript
npm test             # vitest
npm run cli -- index # brain index
```

## Estado atual do projeto

**V2 COMPLETA (FASES 0–17).** V1 (0–8) + V2 (9–17): memory engine, context
package, agent runtime, tool registry, skills intelligence, learning loop,
research engine, project intelligence, unified API (`brain_query`).
19 ferramentas MCP. Schema v3. 153 testes. Docs: `docs/v2.md`, `CHANGELOG.md`.
Git: 2 commits locais (v1.0.0, v2.0.0); remote `WmAgencia/SEGUNDO-CEREBRO`
configurado mas PUSH BLOQUEADO por credencial (máquina autentica como
`consecomclipcon-design`) — resolver com `git credential-manager github login`
na conta WmAgencia ou adicionar colaborador, depois `git push origin main`.

- FASE 0 concluída (ver `docs/environment.md`).
- FASE 1 concluída: schema SQLite, config, logger, erros, CLI base.
- FASE 2 concluída: VaultIndexer incremental (`core/indexing/vault-indexer.ts`)
  com detecção de renome por hash, parser Markdown/frontmatter
  (`connectors/obsidian/markdown.ts`), scanner c/ `.brainignore`
  (`core/permissions/ignore.ts`), chunker por headings, extração de entidades
  (só notas com `id:` no frontmatter) e relações (frontmatter `relations:` +
  wiki-links → LINKS_TO). Migrações de schema em `storage/schema.ts` (v2:
  `origin_document_id`). CLI: `brain index [--json]`, `brain watch`.
- FASE 3 concluída: busca lexical (`core/retrieval/searcher.ts`) com bm25,
  snippets `[...]`, filtros type/tag/pathPrefix/entityId, paginação,
  sanitização segura de query FTS5 (`core/retrieval/fts-query.ts`,
  tokens→frases citadas c/ prefixo `*`; estratégia AND com fallback OR).
  CLI: `brain search <q> [-t tipos] [--tag] [-l n] [--json]`.
  Lição FTS5: em JOIN com alias, usar SEMPRE o nome real da tabela em
  MATCH/bm25/snippet; nunca colocar MATCH externo no escopo do COUNT.
  76 testes vitest; typecheck limpo; busca validada no vault real.
- FASE 4 concluída: camada de consulta de entidades e grafo.
  `core/entities/entity.ts` (EntityRecord, getEntity, stats),
  `core/entities/resolver.ts` (resolveEntity: id conf=1 → alias 0.9 → nome
  0.85 → prefixo único 0.7 → FTS 0.5, com lista de candidatos),
  `core/relations/graph.ts` (relatedEdges com direção out/in/both,
  traverseGraph BFS até depth 5, filtro por tipo e validez temporal
  valid_from/valid_until; supersedeRelation/closeRelation preservando
  histórico — nunca sobrescrever), `core/retrieval/timeline.ts`
  (eventos+relações+documento+memórias ordenados desc).
  CLI: `brain get`, `brain related [-d --dir --rel --as-of]`, `brain resolve`.
  Self-healing validado: reindexar remove entidades órfãs de fontes sumidas.
  93 testes vitest; typecheck limpo.
- FASE 5 concluída: orquestração.
  `core/orchestrator/router.ts` (routeQuery: intenções general/relationship/
  history/concept/procedure por regras determinísticas, sem LLM),
  `core/context/context-builder.ts` (buildContext com resolução de assunto,
  resumo do primeiro chunk, relacionados, decisões, procedimentos, eventos,
  documentos, fontes e avisos; orçamento de caracteres GARANTIDO por
  construção — resumo é campo elástico, encolhe até caber; dedup por id/path).
  `core/orchestrator/brain-orchestrator.ts` (ask(): roteia → resolve → busca
  → contexto → resposta única com warnings consolidados).
  CLI: `brain context <subject> [--task --depth --max-chars]`,
  `brain ask "<query>"`.
  ⚠️ Operacional: um brain.db por vault. Ao trocar SECOND_BRAIN_VAULT,
  usar outro SECOND_BRAIN_DATA_DIR (ou reindexar) para não misturar índices.
  Lições: `\b` do JS falha após caractere acentuado; orçamento deve medir o
  envelope completo, senão invariantes mentem.
  107 testes vitest; typecheck limpo; ask/context validados em fixture e vault real.
- FASE 6 concluída: MCP server (`mcp/`).
  `mcp/src/tools.ts` (handlers puros das 10 ferramentas brain_*),
  `mcp/src/server.ts` (createBrainMcpServer: registerTool c/ zod schemas +
  wrapJson que converte BrainError em {code,message} JSON com isError),
  `mcp/src/main.ts` + `mcp/bin/second-brain-mcp.js` (stdio).
  Erros de protocolo (zod) voltam como texto do SDK; erros nossos como JSON
  estruturado. Escritas (remember/link) usam source 'src.conversation' e
  NUNCA tocam o vault; relações manuais sobrevivem à reindexação.
  Testado de verdade: Client + InMemoryTransport (13 asserts) E smoke stdio
  real (`npm run mcp:smoke`). SDK 1.30: registerTool(name, config, cb);
  zod ^3.25||^4 ok. 120 testes vitest; typecheck limpo.
- FASE 7 concluída (com ressalva honesta): OpenCode.
  Config registrada em `%USERPROFILE%\.config\opencode\opencode.jsonc`
  (bloco `mcp.second-brain`, type local, stdio, env SECOND_BRAIN_VAULT;
  backup em opencode.jsonc.bak-second-brain). Sintaxe validada contra
  opencode.ai/docs/mcp-servers. `opencode mcp list` → ✓ second-brain
  connected. Vault demo da seção 33 populado no vault real (8 entidades +
  decisão + procedimento + evento; BOM do PowerShell corrigido no parser,
  regressão testada, rebuild completo do índice: 15 docs, 0 links soltos).
  ⚠️ Sessão LLM ponta-a-ponta aguarda provider com chave válida
  (groq sem GROQ_API_KEY no ambiente; agentrouter bloqueia conteúdo).
  Comando pronto: `opencode run "Use o second-brain: o que você sabe sobre o Vyntra?"`.
  Docs: docs/opencode.md completo (setup, tools, troubleshooting, rebuild).
- FASE 7 concluída: OpenCode INTEGRADO E VALIDADO EM SESSÃO REAL.
  MCP registrado (`✓ second-brain connected`) + agente primário `brain`
  (modelo free `opencode/nemotron-3-ultra-free` via Zen, permission
  edit/bash deny, prompt curto que obriga uso exclusivo de second-brain_*).
  Os 4 critérios da seção 35 passaram em sessão real com 10+ chamadas MCP:
  resumo/status/relacionados/decisões/fontes; grafo; decisão de campanhas;
  contexto completo (o agente chamou brain_context c/ task e depth=3).
  Lições: TPM do Groq free (8K) < baseline do OpenCode (~32k) — resolvido
  com agente minimalista + modelo Zen; compound não faz tool-calling
  externo; modelo tentou ler arquivo do vault → regra explícita no prompt.
- FASE 8 concluída (variante leve, SEM Ollama): runtime = llama.cpp
  portátil em `tools/llamacpp` (~90MB) + modelo `Qwen3-1.7B-Q4_K_M.gguf`
  (1.19GB) em `tools/models/` (ambos gitignored). Servidor OpenAI-compatible:
  `npm run llama:serve` (:11434, --jinja p/ desligar thinking).
  `core/ai/`: interface LLMProvider, LocalLlamaCppProvider (enable_thinking
  false), extractMemoryProposals (8 categorias FACT..LESSON, JSON parse com
  fallback) e saveConfirmedMemory (só grava com --save; source=conversation).
  CLI: `ai:status`, `ai:extract "<texto>" [-e entidade] [--save]`.
  Validado ponta-a-ponta: DECISAO conf=0.9 e LESSON conf=0.8 extraídas e
  salvas vinculadas a project.vyntra.
  Lições duras: instalador Ollama silencioso falha sem UAC e comeu o disco;
  huggingface.co serviu HTML (1.2GB!) para curl → usar hf-mirror.com;
  Set-Content -Encoding Ascii destrói acentos — sempre UTF8 sem BOM via .NET.
- Stack: Node 24 + node:sqlite + FTS5 + TypeScript + commander + yaml +
  @modelcontextprotocol/sdk + zod + vitest + llama.cpp/Qwen3 local.
- Vault real inicializado e indexado:
  `C:\Users\junin\OneDrive\Documentos\Obsidian Vault`
- ⚠️ Disco C: ~1,9 GB livres: manter deps mínimas; IA local adiada (FASE 8).

## Próxima fase

FASE 8 encerrada = V1 COMPLETA (fases 0–8). Roadmap futuro (pós-V1, quando
houver necessidade real): sync do vault via git, MCP over HTTP p/ acesso
remoto, dashboard do grafo. Manter disco monitorado (<1 GB livre hoje).
