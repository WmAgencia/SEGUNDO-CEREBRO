# SECOND BRAIN — ARQUITETURA SIMPLIFICADA (SPEC v1.0)

## 1. VISÃO GERAL

O Second Brain será transformado em **UM ÚNICO AGENTE PESSOAL**, conversacional, com memória, contexto, ferramentas e loop autônomo.

Não haverá mais:
- múltiplos agentes conversando entre si
- escritório virtual com departamentos
- dashboards operacionais complexos
- orquestração distribuída
- sistemas duplicados

Apenas:

```
USUÁRIO
   ↓
CHAT (conversa natural)
   ↓
AGENTE ÚNICO
   ├── CONTEXT COMPILER (just-in-time)
   ├── MEMORY ENGINE (Obsidian + long-term)
   ├── TOOL EXECUTOR (web, drive, image, opencode)
   ├── LLM ROUTER (Groq pool + fallback)
   └── AGENT LOOP (OBSERVE → UNDERSTAND → PLAN → ACT → EVALUATE)
```

## 2. PRINCÍPIOS FUNDAMENTAIS

### 2.1. Um único agente
- Nenhum outro agente principal
- Todos os "agentes" existentes viram **ferramentas** ou **funções internas**
- O agente é o usuário: conversa com ele, não com um sistema

### 2.2. Conversa natural é obrigatória
- Respostas não podem ser determinísticas artificiais como:
  - "Quer que eu analise mais fundo?"
  - "Posso transformar isso em algo acionável?"
  - "Sobre o projeto X..."
  - "Comando recebido."
- Se o usuário diz "Oi", responda naturalmente
- Se o usuário diz "Você está aí?", responda presença
- Se o usuário diz "Estou pensando em prospectar clínicas", discuta a ideia

### 2.3. Contexto é rei
- Memória de longo prazo (Obsidian) + curto prazo (working memory)
- Contexto carregado just-in-time (não tudo no prompt)
- Recuperação dinâmica: buscar apenas quando necessário
- Estrutura semântica: decisões, objetivos, projetos, tarefas, memórias, eventos

### 2.4. Ferramentas simples e bem descritas
- Cada ferramenta tem nome claro, descrição clara, parâmetros claros
- Não despejar respostas gigantes
- Paginar resultados grandes
- Filtros explícitos

### 2.5. Loop autônomo real
- OBSERVE → UNDERSTAND → RETRIEVE → REASON → PLAN → SELECT TOOL → EXECUTE → OBSERVE RESULT → EVALUATE
- Pode continuar trabalhando sem o usuário
- Checkpoints para retomada após falhas
- Aprovação explícita para ações sensíveis

## 3. ARQUITETURA FINAL

```
┌─────────────────────────────────────────────────────────────────┐
│                        SECOND BRAIN CORE                         │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│   ┌──────────────┐    ┌──────────────────┐    ┌──────────────┐  │
│   │   CHAT       │    │   AGENT LOOP     │    │   TOOLS      │  │
│   │   ENGINE     │◄───│   (OBSERVE→ACT)  │───►│   REGISTRY   │  │
│   └──────┬───────┘    └────────┬─────────┘    └──────┬───────┘  │
│          │                       │                       │        │
│          ▼                       ▼                       ▼        │
│   ┌──────────────────────────────────────────────────────────┐   │
│   │                    CONTEXT COMPILER                      │   │
│   │  Session + Memories + Entities + Projects + Tools + Obsidian │   │
│   └────────────────────────────┬──────────────────────────────┘   │
│                                │                                    │
│          ┌─────────────────────┼─────────────────────┐            │
│          ▼                     ▼                     ▼            │
│   ┌────────────┐       ┌─────────────┐        ┌────────────┐   │
│   │  MEMORY    │       │  OBSIDIAN   │        │  PROJECTS  │   │
│   │  ENGINE    │       │  INDEXER    │        │  / GOALS  │   │
│   └────────────┘       └─────────────┘        └────────────┘   │
│                                │                                   │
│                                ▼                                   │
│                    ┌──────────────────────┐                      │
│                    │   LLM ROUTER         │                      │
│                    │  Groq Pool + OR      │                      │
│                    └──────────────────────┘                      │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                      INTERFACES (Thin)                            │
├─────────────────────────────────────────────────────────────────┤
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐             │
│  │  CHAT REST  │  │  MCP STDIO  │  │  WHATSAPP   │  (proxies) │
│  │  + SSE      │  │  (19 tools) │  │  PROXY      │             │
│  └─────────────┘  └─────────────┘  └─────────────┘             │
└─────────────────────────────────────────────────────────────────┘
```

## 4. INTERFACES PRINCIPAIS

### 4.1. AgentLoop (core/agent/agent-loop.ts)

```typescript
interface AgentState {
  mode: 'CHAT' | 'PLAN' | 'EXECUTE';
  sessionId: string;
  context: CompiledContext;
  currentPlan?: Plan;
  pendingConfirmation?: ConfirmationRequest;
  backgroundRuns: Map<string, BackgroundRun>;
}

async function* agentLoop(
  input: UserInput, 
  state: AgentState
): AsyncGenerator<AgentEvent> {
  // 1. OBSERVE — input do usuário + estado atual
  yield { type: 'OBSERVE', input, state };
  
  // 2. UNDERSTAND — classificar intenção, extrair entidades
  const understanding = await understand(input, state.context);
  yield { type: 'UNDERSTAND', understanding };
  
  // 3. RETRIEVE CONTEXT — just-in-time
  const context = await compileContext(understanding, state);
  yield { type: 'CONTEXT', context };
  
  // 4. REASON — LLM com contexto compilado
  const reasoning = await reason(context, understanding, state.mode);
  yield { type: 'REASON', reasoning };
  
  // 5. PLAN — se modo PLAN ou execução complexa
  if (state.mode === 'PLAN' || reasoning.requiresPlan) {
    const plan = await createPlan(reasoning, context);
    state.currentPlan = plan;
    state.mode = 'PLAN';
    yield { type: 'PLAN', plan, requiresConfirmation: true };
    
    const confirmed = await waitForConfirmation();
    if (!confirmed) { yield { type: 'CANCELLED' }; return; }
    state.mode = 'EXECUTE';
  }
  
  // 6. EXECUTE — tool calling loop
  if (state.mode === 'EXECUTE') {
    for (const step of state.currentPlan?.steps ?? []) {
      yield { type: 'STEP_START', step };
      const result = await executeStep(step, context);
      yield { type: 'STEP_RESULT', step, result };
      
      // EVALUATE
      const evaluation = await evaluate(result, step);
      if (evaluation.needsRetry) {
        yield { type: 'RETRY', step, reason: evaluation.reason };
        continue;
      }
      if (evaluation.needsAdjustment) {
        yield { type: 'ADJUST', adjustment: evaluation.adjustment };
        continue;
      }
      if (evaluation.needsUserInput) {
        yield { type: 'ASK_USER', question: evaluation.question };
        const userInput = await waitForUserInput();
        // re-enter loop with new input
      }
    }
    yield { type: 'COMPLETE', summary: compileSummary(state.currentPlan) };
  }
  
  // 7. PERSIST — salvar memórias, decisões, checkpoints
  await persistOutcomes(state);
  yield { type: 'PERSISTED' };
}
```

### 4.2. Context Compiler (core/agent/context-compiler.ts)

```typescript
interface CompiledContext {
  subject: string;
  entityId: string | null;
  resolvedBy: ResolveMethod | null;
  entityType: string | null;
  status: string | null;
  summary: string | null;
  aliases: string[];
  relatedEntities: RelatedEntityInfo[];
  decisions: Array<{ id: string; title: string; status: string | null }>;
  procedures: Array<{ id: string; title: string; status: string | null }>;
  recentEvents: TimelineEntryLite[];
  documents: DocumentRef[];
  sources: Array<{ sourceType: string; location: string }>;
  warnings: string[];
  truncated: boolean;
  charBudget: { used: number; max: number };
  generatedAt: string;
}

export async function compileContext(
  input: { 
    subject: string; 
    task?: string; 
    depth?: number; 
    maxChars?: number;
  },
  dbPath: string
): Promise<CompiledContext> {
  // 1. Resolve entity (if any)
  // 2. Build context from:
  //    - session history (last 6 messages)
  //    - memories (related to subject)
  //    - entities & relations (graph traversal)
  //    - projects/goals/initiatives (by project name in subject)
  //    - recent events (last 12)
  //    - documents (search by subject + task)
  // 3. Budget-based truncation (maxChars)
  // 4. Return compiled context
}
```

### 4.3. Chat Engine (core/agent/chat-engine.ts)

```typescript
export interface ChatResponse {
  type: 'conversation' | 'plan' | 'execution' | 'status';
  message: string;
  intent: ManagerIntent;
  requiresConfirmation: boolean;
  contextCards?: Array<{ label: string; value: string }>;
}

export async function chatEngine(
  config: BrainConfig,
  input: string,
  sessionKey: string
): Promise<ChatResponse> {
  const db = new DatabaseSync(config.dbPath);
  try {
    // 1. Get session state
    let session = getSession(db, sessionKey);
    
    // 2. Classify intent (greeting, question, idea, command, etc)
    const intent: ManagerIntent = classifyIntent(input);
    
    // 3. Update session history
    session.history.push({ role: 'user', text: input });
    persistMessage(db, sessionKey, 'user', input);
    
    // 4. Handle greetings
    if (isGreeting(input)) {
      return { 
        type: 'conversation', 
        message: generateGreeting(), 
        intent: 'CHAT',
        requiresConfirmation: false 
      };
    }
    
    // 5. Handle explicit commands
    if (intent === 'STOP') return handleStop(db, session);
    if (intent === 'RESUME') return handleResume(db, session);
    if (intent === 'MODE_SWITCH') return handleModeSwitch(db, session, input);
    
    // 6. Handle creative intents (idea, proposal)
    if (intent === 'IDEA' || intent === 'QUESTION') {
      const context = await compileContext({ subject: input }, config.dbPath);
      const response = await callLLM(config, context, input, session);
      return { ...response, intent };
    }
    
    // 7. Handle planning
    if (intent === 'GOAL_CREATION') {
      const plan = await createPlan(input, session);
      session.pending = plan;
      return {
        type: 'plan',
        message: `Entendi. Vou criar o objetivo "${plan.goalName}" com ${plan.tasks.length} tarefas:\n\n${plan.tasks.map((t,i)=>`${i+1}. ${t}`).join('\n')}\n\nQuer que eu execute?`,
        intent: 'GOAL_CREATION',
        requiresConfirmation: true,
        contextCards: [{ label: 'Objetivo', value: plan.goalName }]
      };
    }
    
    // 8. Handle execution confirmation
    if (intent === 'EXECUTION_CONFIRM' && session.pending) {
      return await executePlan(db, session.pending, session);
    }
    
    // 9. Default: conversa normal com contexto
    const context = await compileContext({ subject: input }, config.dbPath);
    const response = await callLLM(config, context, input, session);
    return { ...response, intent: 'CHAT' };
  } finally {
    db.close();
  }
}
```

### 4.4. Tool Registry (core/agent/tools/tool-registry.ts)

```typescript
export interface Tool<Input, Output> {
  id: string;
  name: string;
  description: string;
  category: string;
  permissions: Permission[];
  riskLevel: RiskLevel;
  inputSchema: JSONSchema;
  outputSchema: JSONSchema;
  sideEffects: SideEffect[];
  execute: (input: Input, context: CompiledContext) => Promise<ToolResult<Output>>;
}

export interface ToolResult<Output> {
  success: boolean;
  output: Output;
  error?: string;
  artifacts?: string[];
  metadata?: Record<string, any>;
}
```

## 5. PLANO DE IMPLEMENTAÇÃO

### FASE 1 — Foundation (Semana 1)
- [ ] Criar `core/agent/types.ts` — interfaces compartilhadas
- [ ] Criar `core/agent/context-compiler.ts` — unificação de contexto
- [ ] Criar `core/agent/chat-engine.ts` — extração do manager
- [ ] Criar `core/agent/agent-loop.ts` — loop principal

### FASE 2 — Tool Integration (Semana 1-2)
- [ ] Mover todas as tools para `core/agent/tools/` com interface unificada
- [ ] Criar `ToolExecutor` com approval gates
- [ ] Integrar `web_search`, `brain_search`, `image_generate`, `drive_upload`, `opcode_run`

### FASE 3 — Server Simplification (Semana 2)
- [ ] Criar `apps/hq/chat-server.ts` — apenas REST/SSE para chat
- [ ] Criar `apps/hq/whatsapp-proxy.ts` — proxy Evolution API isolado
- [ ] Frontend: novo `index.html` estilo ChatGPT

### FASE 4 — Cleanup (Semana 2-3)
- [ ] Remover arquivos obsoletos (manager.ts, agent-os.ts, etc.)
- [ ] Arquivar diretórios desnecessários

## 6. CRITÉRIOS DE SUCESSO

- [ ] Conversa natural: "Oi" → resposta natural; multi-turn mantém contexto
- [ ] Chat → Plan → Execute funcionando
- [ ] Agent Loop real com checkpoints e retomada
- [ ] Tools funcionando (web_search, brain_search, image_generate, etc.)
- [ ] Memória persistente entre sessões
- [ ] Typecheck limpo + 25 Reality Gate tests PASS
- [ ] Deploy produção no Railway

---
Document created successfully. Now I can proceed with the implementation starting with Phase 1.