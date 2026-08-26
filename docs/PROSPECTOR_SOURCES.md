# PROSPECTOR SOURCES

## Fonte ativa: OpenStreetMap (Overpass)

| Atributo | Valor |
|---|---|
| id | `openstreetmap_overpass` |
| URL | `https://overpass-api.de/api/interpreter` (configurável: `OVERPASS_ENDPOINT`) |
| Licença | **ODbL** (OpenStreetMap) — dados abertos, sem key, sem custo |
| Credencial | nenhuma (`needsCredential: false`) |
| Coleta | nome, categoria, endereço, telefone, website, Instagram, email |
| Rate limit | ~10 req/min (exigência do serviço público) |
| Confiabilidade | 0.7 (dados colaborativos; nem todo negócio está no OSM) |

### Por que Overpass e NÃO Google Maps Scraper
O projeto `omkarcloud/google-maps-scraper` foi **estudado e REJEITADO** como fonte para o container:

1. **É app desktop** (binário `.deb/.rpm/.exe` + Chrome instalado), não lib pip/npm portável.
2. Exige **auth token/assinatura** e a UI é desktop-GUI.
3. **Enrichment** (email/redes) requer **API key paga** da Omkar Cloud.
4. Baseado em **Botasaurus/Playwright + stealth** — roda em IPs de nuvem (Railway) e é frágil
   contra anti-bot do Google, além de risco de ToS.
5. Disclaimer do próprio repo: "educacional/pesquisa, respeite leis e privacidade".

Sua única contribuição viável seria o conceito de **enrichment + paginação + rate limit**,
já incorporados por design no nosso engine.

## Fontes planejadas (registry pronto, ainda não implementadas)
- **search engine** (DuckDuckGo HTML) — sem key, com rate limit; rastreia presença digital.
- **crawler de website** — visita `website` do lead para avaliar qualidade (presença de CTA,
  WhatsApp, velocidade heurística).
- **diretórios públicos** — feed configurável.

Cada nova fonte só precisa implementar `ProspectingSource.search(query)` e ser registrada.

## Fallback (BLOCKED_SOURCE)
Se uma fonte lançar erro, o ciclo registra `blockedSources[{source, reason}]` e CONTINUA
com as demais habilitadas — nunca para o Prospector por causa de uma fonte.
