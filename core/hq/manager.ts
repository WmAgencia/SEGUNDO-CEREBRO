import { DatabaseSync } from "node:sqlite";
import type { BrainConfig } from "../config/loader.ts";
import { createGoal, type GoalRecord } from "../goals/goal-engine.ts";
import { createInitiative, planInitiative } from "../goals/initiatives.ts";
import { refreshQueue, assignTask } from "../agents/agent-os.ts";
import { setKillSwitch } from "../autonomous/cycle.ts";
import { buildWorldState } from "../agents/world-state.ts";
import { persistGoalKnowledge, persistInitiativeKnowledge } from "../obsidian/knowledge-records.ts";

export type ManagerIntent = 'CHAT'|'QUESTION'|'IDEA'|'GOAL_CREATION'|'EXECUTION_CONFIRM'|'STOP'|'RESUME'|'STATUS'|'DIAGNOSIS'|'APPROVAL';

export interface ManagerResponse {
  type: 'conversation'|'plan'|'execution'|'status';
  message: string;
  intent: ManagerIntent;
  actions: Array<{ type: string; status: 'proposed'|'executed'|'failed'; detail?: string }>;
  requiresConfirmation: boolean;
}

interface PendingPlan {
  goalName: string;
  goalType: 'FINANCIAL'|'PROJECT';
  target?: number;
  deadline?: string;
  tasks: string[];
  project?: string;
}

const sessions = new Map<string, { pending: PendingPlan|null; history: string[] }>();

function getSession(key: string) {
  if (!sessions.has(key)) sessions.set(key, { pending: null, history: [] });
  return sessions.get(key)!;
}

function classifyIntent(text: string, session: { pending: PendingPlan|null }): ManagerIntent {
  const t = text.trim().toLowerCase().replace(/[.!?]+$/, '');

  // Explicit commands first
  if (/^(pare tudo|para tudo|kill switch|stop everything)$/i.test(t)) return 'STOP';
  if (/^(continue|retomar|resume)$/i.test(t)) return 'RESUME';

  // If we have a pending plan and user confirms
  if (session.pending && /^(pode|executa|executar|sim|confirmo|vai|manda ver|pode executar|aprovado|go)\b/i.test(t)) return 'EXECUTION_CONFIRM';
  if (session.pending && /^(pode|executa)\b/i.test(t) && t.length < 30) return 'EXECUTION_CONFIRM';

  // Greetings BEFORE question detection (they often end with ?)
  if (/^(oi|olá|ola|hey|e aí|eai|bom dia|boa tarde|boa noite|tudo bem|tudo certo|como vai)\b/i.test(t)) return 'CHAT';
  if (/(tudo bem|tudo certo|como você está|como vc tá|como vai|você está bem)/i.test(t)) return 'CHAT';

  // Goal creation patterns
  if (/(quero|precisamos|preciso|vamos|objetivo|meta)\s+(de\s+)?(faturar|alcançar|vender|ganhar|criar|atingir|fazer)\s+/i.test(t)) return 'GOAL_CREATION';
  if (/(criar|definir|iniciar)\s+(um\s+)?(objetivo|meta)\s+/i.test(t)) return 'GOAL_CREATION';
  if (/r\$\s*[\d.,]+/i.test(t) && /(faturar|vender|alcançar|meta|objetivo)/i.test(t)) return 'GOAL_CREATION';

  // Status / diagnosis
  if (/(qual|como)\s+(é?\s+)?(a\s+|o\s+)?(nossa\s+)?(prioridade|status|progresso|situação|estado)/i.test(t)) return 'STATUS';
  if (/(o que está|o que tá)\s+(acontecendo|rolando)/i.test(t)) return 'STATUS';
  if (/(por que|porque)\s+.*bloquead/i.test(t)) return 'DIAGNOSIS';

  // Ideas / exploration
  if (/(estou pensando|tô pensando|ideia|que tal|e se|talvez|imagina)/i.test(t)) return 'IDEA';
  if (/(aumentar|melhorar)\s+(vendas|prospec|comercial|leads)/i.test(t)) return 'IDEA';

  // Questions about the system
  if (/^(qual|quais|como|quando|onde|por que|quem)\b/i.test(t)) return 'QUESTION';
  if (/\?$/.test(text.trim())) return 'QUESTION';

  // Default: chat
  return 'CHAT';
}

function extractPlan(text: string): PendingPlan {
  const t = text.trim();
  const targetMatch = t.match(/r\$\s*([\d.,]+)/i);
  const target = targetMatch?.[1] ? Number(targetMatch[1].replace(/\./g,'').replace(',','.')) : undefined;
  const isCommercial = /r\$|venda|vendas|faturar|receita|lead|prospec/i.test(t);
  const isNutriva = /nutriva/i.test(t);

  let name = t.replace(/^(quero|precisamos|preciso|vamos)\s+(de\s+|a\s+)?/i,'')
    .replace(/^(faturar|alcançar|atingir|criar)\s+/i,'')
    .replace(/\s+até\s+.*$/i,'').replace(/\s+este\s+mês.*$/i,'').trim();
  if (!name) name = isCommercial ? 'Meta comercial' : 'Novo objetivo';

  const tasks = isCommercial
    ? ['Definir segmentos prioritários','Prospecção de leads qualificados','Preparar abordagem e proposta','Executar outreach comercial','Follow-up e qualificação','Consolidar resultados']
    : isNutriva
      ? ['Auditar estado atual do Nutriva','Implementar próxima melhoria de baixo risco','Executar testes e avaliação']
      : ['Analisar contexto atual','Definir abordagem','Executar ação principal','Avaliar resultados'];

  return {
    goalName: name,
    goalType: isCommercial ? 'FINANCIAL' : 'PROJECT',
    target,
    tasks,
    project: isNutriva ? 'nutriva' : isCommercial ? 'consecom' : undefined,
  };
}

function getWorldContext(config: BrainConfig): string {
  try {
    const w = buildWorldState(config);
    const activeGoals = w.counts['goals'] ?? 0;
    const activeRuns = w.activeRuns.length;
    const blocked = w.blockedRuns.length;
    return `${activeGoals} goals no sistema, ${activeRuns} runs ativos, ${blocked} bloqueados.`;
  } catch { return 'Contexto indisponível.'; }
}

export function managerChat(config: BrainConfig, text: string, sessionKey = 'default'): ManagerResponse {
  const trimmed = text.trim();
  if (!trimmed) return { type:'conversation', message:'Digite algo para eu ajudar.', intent:'CHAT', actions:[], requiresConfirmation:false };

  const session = getSession(sessionKey);
  session.history.push(trimmed);
  if (session.history.length > 50) session.history.shift();

  const intent = classifyIntent(trimmed, session);

  switch (intent) {
    case 'STOP': return executeStop(config);
    case 'RESUME': return executeResume(config);
    case 'EXECUTION_CONFIRM': return executeConfirmedPlan(config, session);
    case 'GOAL_CREATION': return proposeGoalPlan(trimmed, session);
    case 'STATUS': return respondStatus(config);
    case 'DIAGNOSIS': return respondDiagnosis(config);
    case 'QUESTION': return respondQuestion(trimmed, config);
    case 'IDEA': return respondIdea(trimmed, config);
    case 'CHAT': default: return respondChat(trimmed, session, config);
  }
}

function respondChat(text: string, session: { history: string[]; pending: PendingPlan|null }, config: BrainConfig): ManagerResponse {
  const t = text.toLowerCase();

  if (/^(oi|olá|ola|hey|e aí|eai|bom dia|boa tarde|boa noite)\b/i.test(t))
    return { type:'conversation', message:'Oi, Wesley. Estou aqui e conectado ao Second Brain. O que você quer resolver?', intent:'CHAT', actions:[], requiresConfirmation:false };

  if (/(tudo bem|tudo certo|como você está|como vc tá|como vai)/i.test(t))
    return { type:'conversation', message:'Tudo funcionando por aqui. Tenho acesso ao banco, aos agentes e ao contexto. O que você precisa?', intent:'CHAT', actions:[], requiresConfirmation:false };

  if (/(você consegue|voce consegue|consegue me ajudar|pode me ajudar|pode ajudar)/i.test(t))
    return { type:'conversation', message:'Sim. Posso criar objetivos, distribuir tarefas, consultar contexto, acompanhar execução e reportar progresso. Me diz o que você quer atacar.', intent:'CHAT', actions:[], requiresConfirmation:false };

  if (/(obrigado|valeu|thanks|show|legal|bacana|ótimo|otimo)/i.test(t))
    return { type:'conversation', message:'Disponha. Estou aqui quando precisar.', intent:'CHAT', actions:[], requiresConfirmation:false };

  if (/(campanha|campanhas)/i.test(t) && /(consecom|criar|nova)/i.test(t))
    return { type:'conversation', message:'Boa. Posso analisar o que já temos sobre a Consecom, campanhas anteriores e prioridades atuais antes de montarmos a campanha. Quer que eu faça essa análise?', intent:'IDEA', actions:[], requiresConfirmation:false };

  if (/(aumentar|melhorar)\s+(vendas|prospec|comercial|leads)/i.test(t))
    return { type:'conversation', message:'Faz sentido. Hoje temos o Prospector e o Comercial como pontos principais dessa operação. Podemos aumentar volume, melhorar qualificação ou trabalhar os dois. Quer que eu monte um plano?', intent:'IDEA', actions:[], requiresConfirmation:false };

  if (/(não|nao|ainda não|deixa|depois)/i.test(t) && session.pending)
    return { type:'conversation', message:'Sem problema. O plano fica guardado — quando quiser executar, é só dizer "pode executar".', intent:'CHAT', actions:[], requiresConfirmation:false };

  // Context-aware fallback using world state
  const ctx = getWorldContext(config);
  const recent = session.history.slice(-3).join(' → ');
  return { type:'conversation', message:`Entendi. Estou vendo: ${ctx} Sobre "${text.slice(0,80)}" — quer que eu analise mais a fundo ou transforme em algo acionável?`, intent:'CHAT', actions:[], requiresConfirmation:false };
}

function respondIdea(text: string, config: BrainConfig): ManagerResponse {
  const ctx = getWorldContext(config);
  return { type:'conversation', message:`Boa ideia. Deixa eu ver o que temos... ${ctx} Posso transformar isso em um objetivo com plano de ação se você quiser. Quer que eu monte uma proposta?`, intent:'IDEA', actions:[], requiresConfirmation:false };
}

function respondQuestion(text: string, config: BrainConfig): ManagerResponse {
  const t = text.toLowerCase();
  if (/(vyntra|nutriva|consecom)/i.test(t)) {
    const project = t.match(/(vyntra|nutriva|consecom)/i)?.[1] ?? 'projeto';
    return { type:'conversation', message:`Deixa eu consultar o Second Brain sobre ${project}... Tenho contexto no banco sobre isso. Posso puxar detalhes específicos de goals, tasks ou histórico se você quiser. O que exatamente você quer saber?`, intent:'QUESTION', actions:[], requiresConfirmation:false };
  }
  if (/(prioridade|prioridade atual|mais importante)/i.test(t)) {
    const ctx = getWorldContext(config);
    return { type:'conversation', message:`Contexto atual: ${ctx} Posso detalhar por projeto ou por agente se quiser.`, intent:'QUESTION', actions:[], requiresConfirmation:false };
  }
  return { type:'conversation', message:'Boa pergunta. Posso consultar o Second Brain e o estado atual para te responder com precisão. Quer que eu procure algo específico?', intent:'QUESTION', actions:[], requiresConfirmation:false };
}

function respondStatus(config: BrainConfig): ManagerResponse {
  const ctx = getWorldContext(config);
  return { type:'status', message:`Status atual: ${ctx}`, intent:'STATUS', actions:[], requiresConfirmation:false };
}

function respondDiagnosis(config: BrainConfig): ManagerResponse {
  const db = new DatabaseSync(config.dbPath);
  try {
    const blocked = db.prepare("SELECT id,state,retry_count FROM agent_runs WHERE state IN ('BLOCKED','WAITING_HUMAN') ORDER BY updated_at DESC LIMIT 3").all() as unknown as Array<{ id:string; state:string; retry_count:number }>;
    const msg = blocked.length ? blocked.map(b=>`${b.id.slice(0,20)}: ${b.state} (${b.retry_count} tentativas)`).join('; ') : 'Nenhum run bloqueado agora.';
    return { type:'conversation', message:msg, intent:'DIAGNOSIS', actions:[], requiresConfirmation:false };
  } finally { db.close(); }
}

function proposeGoalPlan(text: string, session: { pending: PendingPlan|null; history: string[] }): ManagerResponse {
  const plan = extractPlan(text);
  session.pending = plan;
  const taskList = plan.tasks.map((t,i)=>`${i+1}. ${t}`).join('\n');
  const targetStr = plan.target ? `R$${plan.target.toLocaleString('pt-BR')}` : '';
  return {
    type:'plan',
    message:`Entendi. Vou criar o objetivo "${plan.goalName}"${targetStr ? ` (${targetStr})` : ''} e montar um plano:\n\n${taskList}\n\nPosso criar e distribuir as tarefas?`,
    intent:'GOAL_CREATION',
    actions:[{ type:'create_goal', status:'proposed' }],
    requiresConfirmation:true,
  };
}

function executeConfirmedPlan(config: BrainConfig, session: { pending: PendingPlan|null }): ManagerResponse {
  const plan = session.pending;
  if (!plan) return { type:'conversation', message:'Não tenho um plano pendente para executar. Me diz o que você quer criar.', intent:'EXECUTION_CONFIRM', actions:[], requiresConfirmation:false };

  const db = new DatabaseSync(config.dbPath);
  try {
    // Ensure manager agent exists for FK constraint
    if (!db.prepare("SELECT id FROM agents WHERE id='manager'").get()) {
      db.prepare("INSERT INTO agents (id,name,description,domains,capabilities,permissions,status) VALUES ('manager','Gerente','Orquestrador','[\"management\"]','[\"planejamento\"]','[\"context\"]','AVAILABLE')").run();
    }
    const goal = createGoal(db, {
      name: plan.goalName,
      type: plan.goalType,
      status: 'ACTIVE',
      ownerAgent: 'manager',
      metricName: plan.goalType === 'FINANCIAL' ? 'receita' : undefined,
      target: plan.target,
      currentValue: plan.goalType === 'FINANCIAL' ? 0 : undefined,
    });
    persistGoalKnowledge(config, goal);
    db.prepare("INSERT INTO events (event_type,subject,payload) VALUES ('command_center_order','manager',?)").run(JSON.stringify({ goalId: goal.id }));

    const initiative = createInitiative(db, {
      title: `${plan.goalName}`,
      description: `Plano criado via Command Center.`,
      goalId: goal.id,
      project: plan.project ?? undefined,
      status: 'PROPOSED',
    });
    const tasks = planInitiative(db, initiative.id, plan.tasks);
    const ready = refreshQueue(db, initiative.id);
    if (ready[0] !== undefined) assignTask(db, ready[0], { agentId:'manager', reason:'Manager delegou primeira task' });
    const obsidianPath = persistInitiativeKnowledge(config, goal, initiative, plan.tasks);

    session.pending = null;

    return {
      type:'execution',
      message:`Objetivo "${plan.goalName}" criado com ${tasks.length} tarefas. Primeira task dispatchada. Tudo registrado no Obsidian.`,
      intent:'GOAL_CREATION',
      actions:[{ type:'create_goal', status:'executed', detail:goal.id }, { type:'create_initiative', status:'executed', detail:initiative.id }],
      requiresConfirmation:false,
    };
  } finally { db.close(); }
}

function executeStop(config: BrainConfig): ManagerResponse {
  const db = new DatabaseSync(config.dbPath);
  try {
    setKillSwitch(true);
    db.prepare("UPDATE agent_runs SET kill_switch=1,previous_state=state,state='PAUSED' WHERE state NOT IN ('COMPLETED','FAILED','CANCELLED')").run();
    db.prepare("INSERT INTO events (event_type,subject,payload) VALUES ('kill_switch_activated','manager','{}')").run();
    return { type:'execution', message:'Kill switch ativado. Todos os runs ativos foram pausados.', intent:'STOP', actions:[{type:'kill_switch',status:'executed'}], requiresConfirmation:false };
  } finally { db.close(); }
}

function executeResume(config: BrainConfig): ManagerResponse {
  const db = new DatabaseSync(config.dbPath);
  try {
    setKillSwitch(false);
    const r = db.prepare("UPDATE agent_runs SET kill_switch=0,state='READY' WHERE kill_switch=1 AND state='PAUSED'").run();
    db.prepare("INSERT INTO events (event_type,subject,payload) VALUES ('operations_resumed','manager',?)").run(JSON.stringify({resumed:r.changes}));
    return { type:'execution', message:`Operações retomadas (${r.changes} runs recuperados).`, intent:'RESUME', actions:[{type:'resume',status:'executed'}], requiresConfirmation:false };
  } finally { db.close(); }
}
