# AGENTS — Agent Runtime & OS (Fases 11 + 19)

## Modelo do agente
id, name, description, role, domains[], capabilities[], skills[], tools[],
projects[], goals[], permissions[], status, workload/capacity, metadata.

Status determinísticos: IDLE AVAILABLE ASSIGNED PLANNING WORKING WAITING
BLOCKED HANDOFF COMPLETED FAILED PAUSED. Nenhum usa IA.

## APIs core (core/agents/)
- agent-runtime.ts: upsertAgent/getAgent/listAgents/agentContext
- agent-os.ts: setAgentStatus, listAgentsFiltered, selectAgent (score+reasons),
  refreshQueue, assignTask, startTaskWork, submitResult (validação +
  review opcional + rework), blockTask/unblockTask, createHandoff/
  acceptHandoff/completeHandoff, sendMessage, requestApproval/
  resolveApproval/listPendingApprovals, reportOutcome, agentPerformance,
  activityLog
- orchestrator.ts: orchestrateCycle(initiativeId), teams
  (createTeam/listTeams/dispatchToTeam)

## Seleção de agente (determinística)
score = base 40 + capability(+20) + skill(+15) + tools cobertas(+10)
+ projeto autorizado(+10) − carga (workload×5). Retorna score e reasons[];
nunca escolhe "pelo nome".

## Performance (informativa)
tasks_completed/failed, average_duration_ms, rework_count, blocked_count.
Não usada para punição automática.