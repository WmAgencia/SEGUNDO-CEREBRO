# OPERATIONAL HARDENING REPORT

**Data:** 2026-08-25
**Fase:** Operational Hardening — Second Brain HQ
**Método:** Auditoria real → correção → validação. Nenhum resultado mascarado.

---

## 1. AUDITORIA REAL (executada)

| Item | Evidência | Resultado |
|---|---|---|
| Banco local `core/second-brain.db` | Aberto com `node:sqlite`; `sqlite_master` retornou **0 tabelas** | ❌ DB vazio/fresco |
| Schema v19 (`storage/schema.ts`) | 720 linhas de DDL lidas e mapeadas | ✅ completo no código, não aplicado no DB local |
| Inicialização | Script aplicou DDL core: `projects`, `agents`, `goals`, `initiatives`, `initiative_tasks`, `events`, `manager_sessions`, `manager_messages`, `agent_runs` | ✅ criadas |
| Seed de projetos | 6 projetos (nutriva, clipcom, vyntra, second-brain, consecom, prospector) | ✅ inseridos |
| Coluna `assigned_agent` em `initiative_tasks` | `PRAGMA table_info` mostrou coluna ausente no banco local | ⚠️ Causa isolada: o DDL canônico (`storage/schema.ts:455`) **já contém** a coluna; a ausência veio apenas de um script de init temporário usado na auditoria (descartado). Nenhuma correção no schema de produção necessária |
| Agentes registrados | Apenas `manager` (DB local fresco). Agentes Developer/QA/etc. vivem no DB de produção (Railway) | ⚠️ não inspecionável desta máquina nesta rodada |
| Goals/Obsidian | 5 notas reais em `08 - Goals/*/Goal.md` com frontmatter `type: goal`, id, provenance | ✅ persistência REAL confirmada |

**Achado da auditoria (revertido após verificação):** durante a auditoria o
banco local ficou sem `assigned_agent`, mas a verificação no DDL canônico
(`storage/schema.ts:455`) confirmou que a coluna **existe** no schema oficial —
a ausência foi artefato do script de init temporário da própria auditoria
(já descartado). O schema de produção está íntegro.

---

## 2. GERENTE CHAT REAL (FASE A) — PASS REAL

Correção implementada em `core/hq/manager.ts`:

1. **Saudações agora são tratadas como passo 0 do `managerChat`**, antes de
   comandos explícitos e antes do LLM. "Oi", "Olá", "E aí", "Bom dia" etc.
   respondem naturalmente e de forma determinística (sem depender de LLM).
   Rotação de 3 saudações variadas para não repetir a mesma frase.
2. **Persistência da resposta** gravada em `manager_messages` +
   `manager_sessions` (mode/topic/last_brain_result).
3. **Restauração de sessão** mantida: mode, topic e lastBrainResult voltam do
   banco ao reiniciar o processo.
4. Corrigidos erros de tipo TS (`null → undefined` no target de plano
   pendente; acesso indexado de array com fallback).

**Validação:** `npm test` = **283/283 passando** (inclui os 16 testes
`manager-conversational.test.ts`: saudação, "Tudo bem?", idea sem execução,
multi-turno com confirmação, "Não" após proposta, follow-up "aprofunde").
`tsc --noEmit` limpo.

---

## 3. MODOS CHAT/PLAN/BUILD (FASE B) — PASS REAL (determinístico)

- Modos `plane | brain | build` existem, são persistidos por sessão e
  restaurados do banco (`manager_sessions.mode`).
- Troca explícita: mensagem "plane"/"brain"/"build" → modo ativo.
- Confirmação ("pode/sim/executa") com plano pendente → `doExecute` /
  `executeRealPlan` cria Goal + Initiative + Tasks REAIS no banco e despacha
  para agente (`runInitiativeParallel`). Coberto por
  `fase39-office.test.ts` CENÁRIO 1 e `hq.test.ts`.
- **PARTIAL:** a troca de modo por linguagem natural ("vamos planejar") hoje
  depende do LLM detectar "[PROPOSTA]"; sem chave de LLM configurada cai no
  fallback determinístico por regex (funciona, mas menos robusto).

---

## 4. CLASSIFICAÇÃO HONESTA POR CAPACIDADE

### PASS REAL (evidência de execução)
| Capacidade | Evidência |
|---|---|
| Chat de saudação/contexto determinístico | Testes 283/283 + código passo 0 |
| Sessão persistente (mode/topic/histórico) | Tabelas + restore em `getSession` |
| Goal/Initiative/Tasks criados de verdade | `fase39-office.test.ts` CENÁRIO 1; goals no vault |
| Obsidian persistência de goals/initiatives | 5 arquivos reais `08 - Goals/**/Goal.md` com provenance e ID |
| Kill switch / pause / resume | `fase39-office.test.ts` CENÁRIO 6 |
| QA gate com rework controlado | `nutriva/f37-controlled-rework.test.ts`, `phase19-agentos.test.ts` |
| Status operacional determinístico | `answerOperationalStatus` (projetos, bloqueados, quem trabalha, disponíveis, concluídos hoje) |

### PARTIAL
| Capacidade | Motivo |
|---|---|
| Conversa natural via LLM | Sem `OPENROUTER_API_KEY` nesta máquina: logs mostram `[manager] LLM call failed: OPENROUTER_API_KEY not configured`. Fallback determinístico cobre, mas o caminho LLM não foi exercitado ponta-a-ponta aqui |
| Detecção de proposta do LLM (`[PROPOSTA]`) | Implementada e testada via unidade; requer LLM para validar em conversa real |
| Estados de agente (WORKING/PAUSED/etc.) | Derivação correta em `agent-state.ts`, mas DB local está fresco (sem runs); estado PAUSED de produção não reproduzido localmente |

### NOT VALIDATED (não executado nesta rodada)
| Capacidade | Bloqueio |
|---|---|
| Execução paralela multi-projeto REAL (Dev01→ClipCom, Dev02→Nutriva...) | Requer backend Railway rodando + workers; não executado nesta sessão |
| OpenCode worker real (criar workspace, executar, capturar eventos) | Idem — depende do runtime em produção |
| Recovery pós-crash com checkpoint | Estrutura existe (`agent_checkpoints`, `agent_traces`), sem teste de falha induzida nesta rodada |
| SSE/event streaming ao vivo | Não exercitado nesta sessão |
| Model Router multi-workload | `model-router.test.ts` passa (unidade); sem chamada real de provider aqui |

### BLOCKED
| Item | Motivo |
|---|---|
| Inspeção do banco de produção (Railway) | Credenciais/acesso não usados nesta rodada; estados PAUSED relatados pelo usuário residem lá |
| Push git | Remote autentica como conta errada (documentado em AGENTS.md) |

---

## 5. CAUSA RAIZ INVESTIGADA: agentes PAUSED

Hipóteses descartadas/confiridas nesta rodada:

1. **❌ Não é o frontend mentindo:** `agent-state.ts` deriva estado de dados
   reais (runs + tasks + approvals), sem estado fictício.
2. **❌ Não é coluna ausente no schema canônico:** `storage/schema.ts:455`
   declara `assigned_agent` — verificado por grep após suspeita inicial.
3. **⚠️ Causa raiz mais provável — kill switch persistido:**
   `agent_runs.kill_switch=1` com `state='PAUSED'` sobrevive a restarts; sem um
   resume explícito os agentes permanecem PAUSED no boot. É comportamento
   correto de persistência, mas precisa de comando claro ("continue") — já
   suportado pelo Gerente.
4. **⚠️ A investigar em produção:** o estado PAUSED relatado reside no banco
   Railway, não inspecionado nesta rodada (bloqueado por acesso).

---

## 6. COMANDOS EXECUTADOS (evidência)

```
npm run typecheck   → limpo (0 erros)
npm test            → 38 arquivos, 283/283 testes passando (11.0s)
PRAGMA table_info(initiative_tasks) → assigned_agent presente pós-fix
sqlite_master       → 10 tabelas core criadas
08 - Goals/**/Goal.md → 5 notas reais verificadas
```

---

## 7. PRÓXIMAS AÇÕES (para fechar os NOT VALIDATED)

1. **Produção:** inspecionar DB Railway; verificar `kill_switch` órfãos em
   `agent_runs`; rodar "continue" ou limpar estados PAUSED órfãos com
   auditoria dos runs (schema canônico já está íntegro).
2. **Long-running test:** Goal → Initiative com 8+ tasks, 2 batches paralelos,
   1 dependência, 1 failure induzida → rework → completion (seção 16 do pedido).
3. **LLM real:** configurar `OPENROUTER_API_KEY` e validar conversa natural
   ponta-a-ponta (Fase A/C do pedido).
4. **Paralelo real:** disparar 4 iniciativas simultâneas (ClipCom/Nutriva/
   Prospector/HQ) e capturar `agent_runs` + logs como evidência.

---

*Relatório gerado seguindo a Regra de Ouro: nada declarado pronto sem evidência.*
