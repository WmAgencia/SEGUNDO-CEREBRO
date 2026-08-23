# HANDOFFS & MESSAGES

HANDOFF: transferência estruturada de resultado entre agentes.
createHandoff(from,to,summary,payload,sources) → CREATED; acceptHandoff → ACCEPTED; completeHandoff(output) → COMPLETED. Eventos handoff_created/accepted/completed.

MESSAGES (agent_messages): comunicação interna orientada a trabalho.
Tipos: REQUEST RESULT QUESTION HANDOFF BLOCKER STATUS REVIEW.
BLOCKER registra requiredInput/Agent/Tool/Approval no context_data e move task para BLOCKED; unblockTask devolve a READY.
