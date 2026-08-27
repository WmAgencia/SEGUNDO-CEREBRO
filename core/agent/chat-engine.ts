/**
 * Chat Engine - Extracted chat logic from manager.ts
 * Handles user input, intent classification, and response generation
 */

import { DatabaseSync } from "node:sqlite";
import { AgentState, ManagerIntent, ChatResponse, UserInput, BrainConfig, Plan } from "./types.js";
import { compileContext } from "./context-compiler.js";

// Mock implementations - will be replaced with actual logic
export async function chatEngine(
  config: BrainConfig,
  input: string,
  sessionKey: string
): Promise<ChatResponse> {
  const db = new DatabaseSync(config.dbPath);
  
  try {
    // 1. Get session state (mock implementation)
    const session = getSession(db, sessionKey);
    
    // 2. Classify intent
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

// Mock helper functions
function getSession(db: DatabaseSync, sessionKey: string): any {
  return {
    id: sessionKey,
    history: [],
    pending: null,
    lastActive: new Date().toISOString()
  };
}

function persistMessage(db: DatabaseSync, sessionKey: string, role: string, text: string): void {
  // In real implementation: insert into manager_messages table
}

function classifyIntent(input: string): ManagerIntent {
  const lower = input.toLowerCase();
  
  if (lower.includes('oi') || lower.includes('olá') || lower.includes('hello')) return 'GREETING';
  if (lower.includes('pare') || lower.includes('stop') || lower.includes('cancela')) return 'STOP';
  if (lower.includes('retoma') || lower.includes('continua')) return 'RESUME';
  if (lower.includes('plano') || lower.includes('planejar') || lower.includes('objetivo')) return 'GOAL_CREATION';
  if (lower.includes('executa') || lower.includes('faz') || lower.includes('roda')) return 'EXECUTION_CONFIRM';
  if (lower.includes('como') || lower.includes('?')) return 'QUESTION';
  if (lower.includes('quero') || lower.includes('pensando em')) return 'IDEA';
  
  return 'CHAT';
}

function isGreeting(input: string): boolean {
  const greetings = ['oi', 'olá', 'hello', 'hey', 'bom dia', 'boa tarde', 'boa noite'];
  return greetings.some(g => input.toLowerCase().includes(g));
}

function generateGreeting(): string {
  const greetings = [
    "Oi! Como posso te ajudar hoje?",
    "Olá! Estou aqui para conversar com você.",
    "E aí! O que você está pensando agora?"
  ];
  return greetings[Math.floor(Math.random() * greetings.length)] ?? "Oi!";
}

function handleStop(db: DatabaseSync, session: any): ChatResponse {
  return {
    type: 'status',
    message: "Entendi. Parei tudo. Estou aqui quando você quiser continuar.",
    intent: 'STOP',
    requiresConfirmation: false
  };
}

function handleResume(db: DatabaseSync, session: any): ChatResponse {
  return {
    type: 'status',
    message: "Retomei nossa conversa anterior. O que você quer fazer agora?",
    intent: 'RESUME',
    requiresConfirmation: false
  };
}

function handleModeSwitch(db: DatabaseSync, session: any, input: string): ChatResponse {
  return {
    type: 'status',
    message: `Mudei para o modo solicitado. ${input}`,
    intent: 'MODE_SWITCH',
    requiresConfirmation: false
  };
}

async function createPlan(input: string, session: any): Promise<Plan> {
  // In real implementation: parse input and create structured plan
  return {
    id: `plan-${Date.now()}`,
    goalName: `Novo objetivo baseado em "${input.substring(0, 30)}..."`,
    description: `Objetivo criado a partir da ideia: "${input}"`,
    tasks: [
      `Analisar requisitos para "${input.substring(0, 20)}..."`,
      `Pesquisar soluções existentes`,
      `Criar protótipo inicial`,
      `Validar com stakeholders`
    ],
    estimatedEffort: 8,
    potentialImpact: 7,
    risk: 3,
    steps: [
      { id: 'step1', description: 'Análise de requisitos' },
      { id: 'step2', description: 'Pesquisa de mercado' },
      { id: 'step3', description: 'Desenvolvimento do protótipo' }
    ]
  };
}

async function executePlan(db: DatabaseSync, plan: any, session: any): Promise<ChatResponse> {
  return {
    type: 'execution',
    message: `Comecei a executar o plano "${plan.goalName}". Estou trabalhando nas tarefas...`,
    intent: 'EXECUTION_CONFIRM',
    requiresConfirmation: false
  };
}

async function callLLM(config: BrainConfig, context: any, input: string, session: any): Promise<ChatResponse> {
  // In real implementation: call LLM with context and input
  return {
    type: 'conversation',
    message: `Entendi sua mensagem sobre "${input.substring(0, 30)}...". Posso te ajudar com isso?`,
    intent: 'CHAT',
    requiresConfirmation: false
  };
}