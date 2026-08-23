# PROACTIVE BRAIN — "O que deveríamos fazer agora?"

## Pipeline alvo (contrato para fases futuras)

```
GOAL → OBSERVATION → OPPORTUNITY → HYPOTHESIS → INITIATIVE
     → APPROVAL → AGENT → TOOL → EXECUTION → RESULT
     → METRIC → LEARNING → GOAL
```

A Fase 18 entrega **OBSERVE → ANALYZE → PROPOSE**. EXECUTE não existe ainda:
nenhuma iniciativa dispara ação externa (mensagens, anúncios, pagamentos).

## `brainNextActions(config)`

Analisa e retorna:

1. **goals** ativos priorizados (`goalPriority` com reasons)
2. **observations** recentes (OPPORTUNITY_SIGNAL/PROBLEM/METRIC_CHANGE em
   destaque)
3. **initiatives** PROPOSED/AWAITING_APPROVAL/APPROVED com score
4. **recommendations[]** consolidadas: `{kind, ref, title, reason}`

## Integração no brain_query

Consultas proativas detectadas por regex determinística
("o que deveríamos/devemos/posso fazer", "próximos passos", "what should we
do") fazem `unifiedQuery` preencher `nextActions` completo; qualquer outra
consulta inclui ao menos os `goals` priorizados.

## Contrato de autonomia futura

Para a fase de execução autônoma, será necessário implementar sobre estes
ganchos já existentes:

- `initiatives.status = APPROVED` (gate atual: humano aprovou)
- `initiative_tasks` ordenadas com dependências (fila de execução)
- `assigned_agent + required_tools` por task (delegação)
- eventos `proposal_approved` / `initiative_updated` (gatilhos)

Nenhuma mudança estrutural será necessária — apenas um Executor que consuma
a fila respeitando permissões do Tool Registry.
