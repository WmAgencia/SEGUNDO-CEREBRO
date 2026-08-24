# Agent Ecosystem

## Modelo adotado

```
SECOM / HQ / MCP
        ↓
Master Manager
        ↓
Context Compiler + Model Router
        ↓
Planner → Task Queue → Worker
        ↓             ↓
Evaluator ← OpenCode / Tools
        ↓
Learning → Memory Engine → Obsidian Knowledge Layer
```

O Manager continua sendo a camada de orquestração existente. OpenClaw fornece
boas referências para gateway, pairing e session boundaries; Hermes para
learning/skills/cron; OpenHuman para graphs/checkpoints/compaction. Nenhum
runtime externo foi duplicado ou instalado.

## Tiers

- Manager/reasoning: planeja e delega.
- Worker: executa tarefas delimitadas.
- Evaluator: independente e não autoriza seu próprio resultado.

## Segurança

Inbound externo é não confiável. Skills, plugins, MCP e browser exigem origem,
licença, scan, permissões, sandbox, budget e approval antes de ativação.
