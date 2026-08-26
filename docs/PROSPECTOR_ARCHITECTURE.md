# PROSPECTOR ARCHITECTURE

## Pipeline real
```
DISCOVER → SEARCH → COLLECT → ENRICH → SCORE → DEDUP → SAVE → QUALIFY → HANDOFF
```

O Prospector é implementado como **engine determinístico** em `core/comms/prospector-engine.ts`,
reutilizando a fundação já existente de `core/comms/leads.ts` (saveLead/dedupe/score/stats) e
`core/comms/prospector-scheduler.ts` (janela/budget/BLOCKED_SOURCE). **Nada duplicado.**

## Fontes (Source Registry)
O Prospector escolhe a fonte dinamicamente via `buildSourceRegistry()` (`core/comms/sources/`).

- `openstreetmap_overpass` — **REAL, sem API key, sem browser.** Dados abertos ODbL.
  Coleta nome, categoria, endereço, telefone, website, Instagram, email.
  Ratelimit: ~10 req/min (respeitado); endpoint configurável via `OVERPASS_ENDPOINT`.

Cada fonte declara: id, capabilities, enabled, costPerSearch, rateLimit, reliability,
needsCredential, instance. Ordem = prioridade; uma fonte que falha vira `BLOCKED_SOURCE`
e o ciclo continua com as demais.

## Scoring (determinístico + explicado)
`scoreCandidate` soma pesos objetivos (`no_website +30`, `instagram ativo sem site +5`,
`telefone público +10`) e produz explicação legível. Nem inventa métricas nem usa LLM
para o score — é objetivo e auditável.

## Persistência com provenance
Cada lead guarda: `source` (`openstreetmap_overpass`), `source_url`, `signals[]`, `evidence[]`
(inclui a explicação de score), `qualification_score`, `status`, `city/state/country`.

## Handoff comercial
`updateLeadStatus(db, id, "APPROACH_QUEUED", "sales-agent-01")` — prova de repositório de que
o lead vem do Prospector. (Envelope completo p/ handoff no `core/agents/agent-os.ts`.)

## Arquivos
- `core/comms/sources/overpass-source.ts` — fonte real
- `core/comms/prospector-engine.ts` — registry + scoring + pipeline
- `tests/prospector-real.test.ts` — testes com servidor HTTP local (parsing + dedupe + score)
- `scripts/reality-gate-prospector.ts` — gate real contra o Overpass público

## Limitações honestas
- Overpass público pode rate-limit/falhar sob carga → `OVERPASS_ENDPOINT` próprio é recomendado em produção.
- Não inclui email por padrão (depende do OSM ter `contact:email`).
- Cobre nichos mapeados (barber, beauty, dentist, clinic, restaurant, fitness, generic shop).
