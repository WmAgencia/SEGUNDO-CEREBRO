# OPPORTUNITIES & OBSERVATIONS — Funil de sinais

## Observations (`goal_observations`)

Sinais do sistema — **nunca viram ações automaticamente**.

Tipos: METRIC_CHANGE · NEW_INFORMATION · PROBLEM · OPPORTUNITY_SIGNAL ·
DEADLINE · PATTERN · ANOMALY · USER_SIGNAL (lista aberta em runtime).

Campos: `source`, `project`, `entity_id`, `data` (JSON livre),
`confidence`, `importance`, timestamp.

Exemplos:
- "CPL aumentou 30%" → METRIC_CHANGE
- "50 leads sem follow-up" → PROBLEM
- "Projeto parado há 14 dias" → ANOMALY

## Opportunities (`opportunities`)

OBSERVATION → SIGNAL → OPPORTUNITY.

Campos: title, description, `source_observation` (rastreabilidade),
`goal_id`, `project`, potential_impact/estimated_effort/risk (0–10),
confidence, status.

Status: NEW → ANALYZING → PROPOSED → ACCEPTED/REJECTED → EXPIRED/CONVERTED.

## Hypotheses (`hypotheses`)

Uma oportunidade gera uma HIPÓTESE testável:

- statement (com "Se…, então…"), evidence[], confidence,
  expected_outcome, metric_name, validation_method.

**Regra dura:** statement iniciado com "FATO:"/"FACT:" é rejeitado —
hipótese nunca é tratada como fato. Distinção de epistemic status:
FACT < OBSERVATION < HYPOTHESIS < OPINION < ASSUMPTION.

## APIs / MCP

- core: `addObservation`, `listObservations`, `createOpportunity`,
  `listOpportunities`, `createHypothesis`, `getHypothesis`
- MCP: `brain_observations {action:add|list}`, `brain_opportunities {action:add|list}`
