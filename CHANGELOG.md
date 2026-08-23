# SECOND BRAIN OS — CHANGELOG

## V2.0.0 — Fases 9–17 (2026-08-23)

### Phase 9 — Memory Engine
- `core/memory/memory-engine.ts`: CRUD de memórias com FTS dedicado,
  filtros (texto/entidade/projeto/kind/categoria/importância/período),
  `computeImportance` determinístico, Working Memory com TTL e expiração.
- Schema v3: colunas `importance/project/access_count/last_accessed_at`
  em `memories`, tabelas `memories_fts` e `working_memory`.

### Phase 10 — Context Engine
- `core/context/context-package.ts`: `buildContextPackage(task,…)` —
  pipeline intent→entidade→contexto→memórias rankeadas; campos tools/skills
  preparados.

### Phase 11 — Agent Runtime
- `core/agents/agent-runtime.ts`: registro de agentes (kebab-case, domínios,
  capacidades, permissões, status) + `agentContext()` com checagem de
  permissão `context` e status ativo.

### Phase 12 — Tool Registry
- `core/tools/tool-registry.ts`: catálogo de ferramentas com categoria/
  permissões/origem/disponibilidade; `seedBrainTools` registra as 10 tools
  MCP reais; `resolveTools(task)` determinístico com score+razão.

### Phase 13 — Skills Intelligence
- `core/skills/skill-engine.ts`: indexa SKILL.md de qualquer repo com
  provenance (source/repo/path/sha256/versão), inferência de kind
  (skill/workflow/reference/command), `searchSkills` com budget 3 primary /
  3 supporting. Fontes clonadas em `skills-sources/` (gitignored):
  marketing-skills, farmage-opencode-skills, task-observer.

### Phase 14 — Learning Loop
- `core/learning/learning-loop.ts`: `observe()` agrega por patternKey;
  threshold (3) promove observation→candidate; governança accept/reject;
  aceitação permite promover a memória semântica.

### Phase 15 — Research Engine
- `core/research/research-engine.ts`: perguntas + claims com provenance
  (fonte/autoridade/data/confiança); detecção determinística NEW / DUPLICATE
  / CONFLICTING via Jaccard ≥0.85 (bug de assimetria de tokenização corrigido).

### Phase 16 — Project Intelligence
- `core/projects/project-intelligence.ts`: agregação por projeto —
  relacionados por tipo, decisões, procedimentos, memórias, documento origem,
  skills, tools, timeline, relações entre projetos.

### Phase 17 — Personal Operating System
- `core/unified.ts`: `unifiedQuery(query)` — intenção → contexto → memórias →
  skills → tools → agentes recomendados → fontes; log estruturado
  (`unified.query`) em events.
- MCP: +9 tools (total **19**): brain_search_memory, brain_get_memory,
  brain_related_memories, brain_search_tools, brain_search_skills,
  brain_agent_context, brain_project, brain_observe, brain_query.
- CLI: `brain project <id>`, `brain learn list|accept|reject`,
  `brain ai:status`, `brain ai:extract [--save]`.
- `brain_health` agora reporta skills/tools/agents/learning_candidates.

## V1.0.0 — Fases 0–8 (2026-08-23)
Indexer incremental, busca FTS5, grafo temporal, orchestrator, MCP stdio,
integração OpenCode, IA local (llama.cpp + Qwen3).
