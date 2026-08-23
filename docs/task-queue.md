# TASK QUEUE

Estados: PENDING → READY → ASSIGNED → RUNNING → WAITING/BLOCKED → COMPLETED/FAILED/CANCELLED.

- refreshQueue(initiativeId): PENDING vira READY quando depends_on está COMPLETED.
- assignTask: exige READY/PENDING, cria assignment, incrementa workload, evento task_assigned.
- startTaskWork: RUNNING + work_session.
- submitResult: valida (INCOMPLETE se output/summary vazio), roteia para review ou completa e desbloqueia dependentes.
- blockTask/unblockTask: BLOCKED com mensagem BLOCKER; input fornecido volta a READY.

Fila ordena por ordinal; prioridade da iniciativa/goal entra via ordem de dispatch do orchestrator.
