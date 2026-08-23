# GOALS — Motor de Objetivos

## Modelo

GOAL = "O que queremos alcançar."

| Campo | Tipo | Notas |
|---|---|---|
| id | `goal.<type>.<slug>.<hash6>` | determinístico pelo nome |
| name / description | text | |
| type | BUSINESS, PROJECT, FINANCIAL, MARKETING, SALES, PRODUCT, PERSONAL, OPERATIONAL | lista aberta (armazenado uppercase) |
| status | DRAFT, ACTIVE, PAUSED, ACHIEVED, FAILED, CANCELLED, ARCHIVED | |
| priority | 1–5 | 1 = mais importante |
| owner_agent | agente responsável (Agent Runtime) | opcional |
| parent_goal_id | goal.id | hierarquia GOAL→SUBGOAL |
| project | entity id do projeto relacionado | alinhamento estratégico |
| metric_name / target / current_value | ex.: revenue, leads, cpl… | progresso determinístico |
| deadline | ISO date | alimenta urgência |
| constraints_json | array de restrições | |

## Progresso (determinístico)

```
progressPct = clamp(0..100, round(current_value / target * 100))   -- se target e current existirem
```

## Prioridade explicável (`goalPriority`)

score inicial 50 + ajustes:
- prioridade declarada: `(4 - priority) × 6`
- prazo: ≤7d +20 · ≤30d +10 · outro +4 · vencido −15
- progresso já alcançado: até +10
- vinculado a projeto: +5
- subobjetivo: +5

Retorna `{ score, reasons[] }` — sempre explicável.

## APIs (core)

`createGoal(db, input)` · `getGoal(db,id)` · `updateGoal(db,id,patch)` ·
`listGoals(db,{status,type})` · `listActiveGoalsByPriority(db,limit)`

## MCP / CLI

- `brain_goals {status?,type?,prioritized?}` · `brain_goal {id}` · `brain_create_goal {...}`
- CLI: `brain goals`, `brain next`
