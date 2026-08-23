# ORCHESTRATOR

orthestrateCycle(config,{initiativeId}) executa UM ciclo persistido:
1. gate: iniciativa APPROVED/RUNNING (senão ValidationError)
2. refreshQueue (dependências)
3. auto-assign de até 50 READY via selectAgent
4. snapshot {assigned, ready, blocked, progressPct, done}
5. all completed → initiative COMPLETED

Sem loop infinito: cada chamada avança o estado persistido; chame repetidamente (CLI/MCP) para continuar.
