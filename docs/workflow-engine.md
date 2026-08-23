# WORKFLOW ENGINE (Fase 23)

## Modelo
Workflow → WorkflowSteps (ordinais + dependências) → WorkflowRuns (checkpoints).

## Estados
DRAFT READY RUNNING WAITING BLOCKED FAILED COMPLETED CANCELLED

## APIs
- createWorkflow(db,{name,initiativeId?,steps[]})
- startWorkflowRun(db,workflowId) → runId
- getWorkflowProgress(db,runId) → {progressPct,currentStep}

## Templates prontos para sales/marketing/engineering.
