# Capability Acquisition Benchmark

Data da pesquisa: 2026-08-24. Fontes primárias foram consultadas quando
disponíveis; contagens e capabilities mudam com os repositórios.

| Projeto | Capacidade observada | Qualidade/licença | Risco | Decisão |
|---|---|---|---|---|
| OpenRouter | Gateway OpenAI-compatible, fallback por modelos, provider routing, streaming, tools, structured outputs, usage/cost | API oficial; SDK ESM beta | custo/egress e provider variance | Incorporar adapter opcional e router |
| OpenClaw | Gateway único, canais, pairing, sessão como roteamento, sandbox, allowlists | MIT | grande superfície host/browser/plugins | Adaptar conceitos de gateway/session boundary; não copiar |
| Hermes Agent | learning loop, skills auto-evolutivas, memória de conversa, cron, gateway, subagentes | MIT | Python/runtime/dependências e auto-modificação | Adaptar padrões, sem dependência |
| OpenHuman | Memory Tree, rollups, prompt prefix estável, graph runs, middleware de budget, cost ledger | GPL-3.0 | copyleft e stack Rust/Tauri | Adaptar compaction/graph ideas; não incorporar código |
| Claude Obsidian | capture→ground→connect→reuse, provenance, transação com lock/backup, workers como drafts | MIT | custo Claude; escrita exige operação | Incorporar princípios de transaction/provenance |
| Awesome Agent Skills | catálogo curado de skills oficiais/comunidade | MIT do catálogo; cada skill tem licença própria | supply chain, shell/fs permissions | Usar como discovery; instalar só após scan |
| Browser2API | Playwright + Chrome CDP para automatizar UIs, sessão persistente | README sem licença explícita encontrada | fragilidade, login, termos e scraping | Adapter NOT_CONFIGURED; sem bypass |
| GPT Image 2 | biblioteca de prompts estruturados/template library | MIT | conteúdo comunitário e providers pagos | Skill de prompt futura, não runtime |
| API Evangelist | OpenAPI governance, catalogs machine-readable, lifecycle/policy | ecossistema heterogêneo | dependência de serviços externos | Adotar contratos/schema governance |
| nicocuenkbermeo | `awesome-mcp-servers` (fork MIT); `pomelli-mcp` CDP não oficial | MIT nos repos consultados | browser automation e APIs privadas | Não instalar; registrar como referência |
| Gemini Geo Unblocker | patch de UI/requests internos para região | MIT | circumvention, conta, servidor muda | Rejeitado |

## Agent Architecture Benchmark

| Feature | Second Brain OS | OpenClaw | Hermes | OpenHuman | Melhor abordagem |
|---|---|---|---|---|---|
| Gateway | HQ/HTTP + webhook | Gateway WS central | Gateway | desktop/gateway | gateway separado do agent loop |
| Sessions | work sessions + runs | channel-peer sessions | cross-channel sessions | durable transcripts | sessão é contexto + boundary |
| Context | BM25/context package | skills/bootstrap/context | memory + context files | Memory Tree + stable prefix | ranking limitado + compressão |
| Orchestration | task queue + harness | bounded subagents | delegate tools | durable graph | manter harness; evoluir para DAG |
| Recovery | checkpoints SQL | steering/cancel | session persistence | graph checkpointer | checkpoint + cancellation |
| Skills | SQLite registry | plugins/skills | self-improving skills | archetypes/skills | registry com scan e aprovação |
| Security | policy/sandbox/SECOM | pairing/sandbox/audit | approvals/sandbox | keyring/privacy mode | combinar allowlist + sandbox + approval |
| Cost | budgets básicos | telemetry | cost per turn | authoritative per-call cost | ledger por geração/modelo |

## Incorporado

- Model Gateway/Router OpenRouter opcional, sem obrigar cloud.
- Fallback chain e seleção declarativa por workload.
- Ledger de tokens, custo e latência em `model_generations`.
- Princípios de transaction/provenance do claude-obsidian.
- Context compression e prompt-prefix stability como decisões futuras.

## Rejeitado

- Instalar projetos inteiros ou substituir o Agent Runtime.
- Bypass geográfico, scraping abusivo e automação de UIs privadas.
- Dependência obrigatória de SDK/API paga.
- Copiar código GPL-3.0 para o projeto MIT/sem licença definida.
