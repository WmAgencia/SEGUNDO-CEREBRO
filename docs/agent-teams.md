# AGENT TEAMS

TEAM = agrupamento de agentes para receber iniciativas.

Campos: id (team.slug), name, description, manager_agent, members[], capabilities[], projects[].

- createTeam/listTeams/getTeam (core/agents/orchestrator.ts)
- dispatchToTeam(config,{initiativeId,teamId}): distribui tasks READY/ASSIGNED entre members em round-robin, pulando steps de APROVAÇÃO.

Regra: NÃO cria agentes automáticos — apenas organiza os registrados.
