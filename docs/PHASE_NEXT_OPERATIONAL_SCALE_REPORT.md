# PHASE NEXT — Operational Scale Report

Data: 25/08/2026 · Commits `b334cc1..HEAD` · Reality Gate **13/13 PASS**

## Arquitetura

Hierarquia implementada: Usuário → Gerente → Departamentos → Agentes → Tasks → Tools.
O Gerente distribui (Supervisor→Workers); o usuário conversa apenas com o Gerente.

## Novos componentes (reutilizando infra existente)

| Componente | Onde | Nota |
|---|---|---|
| Entidade Project | tabela `projects` (v19) + `core/projects.ts` | id/name/workspace/status/priority; seeds: Nutriva, Clipcom, Vyntra, Second Brain, Consecom, Prospector |
| Developer 01–04 | `SPECIALIZED_AGENTS` + seed no boot (`ensureHqAgents`) | capacity=1 cada (concorrência unitária) |
| QA Agent / Integrator Agent | idem | gate de qualidade independente do implementador |
| Orchestrator paralelo | `core/hq/orchestrator.ts` | READY+ASSIGNED por prioridade; Promise.all por agente; serialização por workspace; QA gate; integration gate |
| Status operacional do Gerente | `answerOperationalStatus()` em manager.ts | respostas determinísticas de estado real (sem LLM) |
| Log ao vivo | v17/v18 `agent_task_logs` + `logStep()` + endpoint `/api/hq/agent/:id/logs` | painel do perfil faz polling 2s |

## Reuso (anti-duplicação)

Nada novo foi criado onde já existia: review/rework (`submitResult`, MAX_RETRIES), approvals,
handoffs, budgets/sandbox (`professional-harness`), OpenCode Runtime, Model Gateway,
knowledge-records (Obsidian) — todos consumidos pelo orquestrador.

## Execução paralela & isolamento

- Tarefas READY/ASSIGNED independentes rodam em `Promise.all`, um agente por task (capacidade respeitada).
- Serialização por workspace: mesmo diretório ⇒ cadeia sequencial (sem git worktree — `.git`
  não existe no container Railway; limitação documentada, não simulada).

## Evidência (Reality Gate local, runtime real)

3 tasks por 3 agentes distintos em ~12s (Drive + Pollinations reais);
9 entradas de log; Obsidian: 2 notas; eventos: 20; Gerente respondeu sobre o Clipcom
citando objetivo e status das tarefas a partir do contexto persistido.

## Limitações honestas

1. Worktrees git indisponíveis no container (sem `.git`); isolamento real hoje = por-workspace serial.
2. QA gate avalia apenas quando TODAS as tasks (não canceladas) estão concluídas; iniciativas
   com backlog pendente ficam `SKIPPED`.
3. Integração (quality gate final) roda testes+typecheck do workspace raiz; por-projeto quando
   houver runner próprio.
4. Tarefas de código fora de workspaces registrados falham honestamente (sandbox valida caminho).

## Próximos passos

Worktrees reais via sidecar git; scheduler com budget/tokens por agente; UI de projetos;
expansão para AI/Data/Security agents (estrutura já suporta registro).
