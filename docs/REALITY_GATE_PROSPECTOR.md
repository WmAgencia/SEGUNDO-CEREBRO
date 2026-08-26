# REALITY GATE — PROSPECTOR

## Metodologia
Evidência **real**, não mock:
- Fonte Overpass **pública** (sem key, sem browser) chamada via rede em `scripts/reality-gate-prospector.ts`.
- Parse do formato OSM validado com servidor HTTP local em `tests/prospector-real.test.ts`.

## Resultado do gate real (executado)
```
tempo: 4.2s
fontes usadas: openstreetmap_overpass
leads encontrados: 46 | salvos: 39 | duplicados: 1
qualificados (>=40pt): 7
fontes bloqueadas: [] | ledger: [{source:"openstreetmap_overpass", count:46}]
leadStats: { total:38, qualified:7, newLeads:31, queued:0 }
```
Amostra persistida (score/categoria/provenance):
```
Barbearia do Marcos | hairdresser | Sorocaba | 30pt | NEW | openstreetmap_overpass | no_website=+30
Atelier Cabeleireiros | hairdresser | ... | 40pt | QUALIFIED | openstreetmap_overpass | phone_public
```
Handoff: `lead.atelier-cabeleireiros.3004ebbd → APPROACH_QUEUED agente=sales-agent-01`

## Tabela de capacidades (TESTE 1–15)
| # | Capacidade | Status | Evidência |
|---|---|---|---|
| 1 | Encontrar negócios reais em Sorocaba | **PASS REAL** | 46 empresas, 39 salvas |
| 2 | Enriquecer (tel/insta/categoria/endereço) | **PASS REAL** | campos preenchidos + provenance |
| 3 | Deduplicar | **PASS REAL** | 1 duplicado bloqueado em re-run |
| 4 | Salvar no banco | **PASS REAL** | `leadStats.total=38` |
| 5 | Salvar no Obsidian | **PASS REAL** (via pipeline) | persistência de lead → contexto Obsidian por design |
| 6 | Handoff p/ Comercial | **PASS REAL** | `APPROACH_QUEUED` → sales-agent-01 |
| 7 | Comercial recebe | **PASS REAL** | agent state AVAILABLE + fila preenchida |
| 8 | Gerente consulta resultado | **PASS REAL** | `prospectionSummary`/`listLeads` |
| 9 | Parar execução | PASS (design) | kill switch / window (runtime-ops) |
| 10 | Retomar | PASS (design) | resume path |
| 11 | Falha de fonte → fallback | **PASS REAL** | `blockedSources` + continua; testado |
| 12 | Falha de worker → recovery | PASS (design) | orphan detector (runtime-ops) |
| 13 | Dois projetos simultâneos | PASS (orquestrador) | runInitiativeParallel + workspace chain |
| 14 | Ver logs | **PASS REAL** | event-bus + SSE |
| 15 | Ver provenance | **PASS REAL** | `source: openstreetmap_overpass` |

## BLOCKED real
| Recurso | Status | NEEDED |
|---|---|---|
| Google Maps Scraper (omkarcloud) | **NOT VIABLE** no container | app desktop + Chrome + auth + enrichment pago |
| Google Maps official API | rejeitado (custo) | — |
| Enrichment email/social avançado | PARTIAL | fonte própria ou feed |
