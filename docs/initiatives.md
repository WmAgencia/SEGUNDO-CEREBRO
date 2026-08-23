# INITIATIVES — Iniciativas, Planner, Scoring e Aprovação

## Modelo

INITIATIVE = "Estratégia executável para atingir um objetivo."

Campos principais: `id (init.<hash10>)`, `title`, `description`, `goal_id`
(rastreabilidade TASK→INITIATIVE→SUBGOAL→GOAL), `project`,
`hypothesis_id`, `owner_agent`, `support_agents[]`, `required_skills[]`,
`required_tools[]`, `estimated_cost`, `effort/impact/probability/risk`
(escalas 0–10), `expected_outcome`, `status`, `approval_status`.

Status: DRAFT → PROPOSED → AWAITING_APPROVAL → APPROVED/REJECTED → RUNNING →
COMPLETED/FAILED/CANCELLED (+PAUSED).

## Scoring determinístico (`scoreInitiative`)

```
score = impact×3 + probability×2 − cost×1.5 − effort×1 − risk×2 + 30
        (+8 se alinhado a um objetivo)            clamp 0..100
```

Retorna `{ score, reasons[] }` — cada parcela explicada. Sem LLM.

## Planner (`planInitiative`)

- Tasks explícitas **ou** pipeline padrão de vendas (10 passos: ICP →
  pesquisa → qualificação → abordagem → campanha → aprovação humana →
  execução → acompanhamento → follow-up → medição).
- Dependência linear: cada task depende da anterior.
- Idempotente: re-planejar lança erro se já houver plano.

## Alinhamentos

- `alignInitiative(db, config, id)` retorna:
  - skills primary/supporting via Skill Intelligence (budget padrão)
  - tools com permissões via Tool Registry
  - ownerAgent = agente ativo com maior overlap capabilities/domínios ×
    skills; supportAgents = demais com overlap.

## Aprovação humana

`approveInitiative(db,id,by)` → approval_status=APPROVED + status=APPROVED +
evento `proposal_approved`.
`rejectInitiativeApproval(db,id,reason,by)` → REJECTED + motivo + evento
`proposal_rejected`.

## Proposta formatada

`formatProposal(db, config, initiativeId)` gera o bloco textual completo
(objetivo, hipótese marcada como hipótese, plano, agentes, skills,
ferramentas, custo, risco, resultado esperado, score/motivo, status).

## MCP / CLI

- `brain_initiatives {action: create|list|score|plan|approve|reject}`
- `brain_proposals {initiativeId}` → texto formatado
- CLI: `brain propose <initiativeId>`
