import { DatabaseSync } from "node:sqlite";
import type { BrainConfig } from "../config/loader.ts";
import { createGoal } from "../goals/goal-engine.ts";
import { createInitiative, planInitiative } from "../goals/initiatives.ts";
import { refreshQueue, assignTask } from "../agents/agent-os.ts";
import { setKillSwitch } from "../autonomous/cycle.ts";
import { buildWorldState } from "../agents/world-state.ts";
import { persistGoalKnowledge, persistInitiativeKnowledge } from "../obsidian/knowledge-records.ts";
import { getAllAgentStates } from "./agent-state.ts";

export type ManagerMode = 'plane' | 'brain' | 'build';
export type ManagerIntent = 'CHAT'|'QUESTION'|'IDEA'|'GOAL_CREATION'|'EXECUTION_CONFIRM'|'STOP'|'RESUME'|'STATUS'|'DIAGNOSIS'|'MODE_SWITCH';

export interface ManagerResponse {
  type: 'conversation'|'plan'|'execution'|'status'|'brain';
  mode: ManagerMode;
  message: string;
  intent: ManagerIntent;
  actions: Array<{ type: string; status: 'proposed'|'executed'|'failed'; detail?: string }>;
  requiresConfirmation: boolean;
  contextCards?: Array<{ label: string; value: string }>;
}

interface PendingPlan {
  goalName: string; goalType: 'FINANCIAL'|'PROJECT';
  target?: number; tasks: string[]; project?: string;
}

interface ManagerSession {
  mode: ManagerMode;
  pending: PendingPlan|null;
  history: Array<{ role: 'user'|'manager'; text: string }>;
  topic: string|null;
}

const sessions = new Map<string, ManagerSession>();
function getSession(key: string): ManagerSession {
  if (!sessions.has(key)) sessions.set(key, { mode:'plane', pending:null, history:[], topic:null });
  return sessions.get(key)!;
}

function classify(text: string, session: ManagerSession): ManagerIntent {
  const t = text.trim().toLowerCase().replace(/[.!?]+$/,'');
  if (/^(pare tudo|para tudo|kill switch|stop)$/i.test(t)) return 'STOP';
  if (/^(continue|retomar|resume)$/i.test(t)) return 'RESUME';
  if (/^(plane|brain|build)$/i.test(t)) return 'MODE_SWITCH';
  if (session.pending && /^(pode|executa|sim|confirmo|vai|manda ver|aprovado|go)\b/i.test(t)) return 'EXECUTION_CONFIRM';
  // Greetings before question detection
  if (/^(oi|olá|ola|hey|e aí|eai|bom dia|boa tarde|boa noite)\b/i.test(t)) return 'CHAT';
  if (/(tudo bem|tudo certo|como você está|como vc tá|como vai|você está bem)/i.test(t)) return 'CHAT';
  if (/(você consegue|consegue me ajudar|pode me ajudar|pode ajudar)/i.test(t)) return 'CHAT';
  if (/(quero|precisamos|preciso)\s+(de\s+)?(faturar|alcançar|vender|ganhar|criar)\s+/i.test(t)) return 'GOAL_CREATION';
  if (/r\$\s*[\d.,]+/i.test(t) && /(faturar|vender|alcançar|meta|objetivo)/i.test(t)) return 'GOAL_CREATION';
  if (/(qual|como)\s+(é?\s+)?(a\s+|o\s+)?(nossa\s+)?(prioridade|status|progresso|situação)/i.test(t)) return 'STATUS';
  if (/(o que está|o que tá)\s+(acontecendo|rolando)/i.test(t)) return 'STATUS';
  if (/^(qual|quais|como|quando|onde|por que|quem)\b/i.test(t)) return 'QUESTION';
  if (/\?$/.test(text.trim())) return 'QUESTION';
  if (/(estou pensando|tô pensando|ideia|que tal|e se|talvez|imagina)/i.test(t)) return 'IDEA';
  if (/(aumentar|melhorar)\s+(vendas|prospec|comercial|leads|qualidade)/i.test(t)) return 'IDEA';
  return 'CHAT';
}

function extractPlan(text: string): PendingPlan {
  const t = text.trim();
  const tm = t.match(/r\$\s*([\d.,]+)/i);
  const target = tm?.[1] ? Number(tm[1].replace(/\./g,'').replace(',','.')) : undefined;
  const isCommercial = /r\$|venda|vendas|faturar|receita|lead|prospec/i.test(t);
  const isNutriva = /nutriva/i.test(t);
  let name = t.replace(/^(quero|precisamos|preciso|vamos)\s+(de\s+|a\s+)?/i,'').replace(/^(faturar|alcançar|atingir|criar)\s+/i,'').replace(/\s+até\s+.*$/i,'').replace(/\s+este\s+mês.*$/i,'').trim();
  if (!name) name = isCommercial ? 'Meta comercial' : 'Novo objetivo';
  const tasks = isCommercial
    ? ['Definir segmentos prioritários','Prospecção de leads qualificados','Preparar abordagem e proposta','Executar outreach comercial','Follow-up e qualificação','Consolidar resultados']
    : isNutriva
      ? ['Auditar estado atual do Nutriva','Implementar próxima melhoria','Executar testes e avaliação']
      : ['Analisar contexto','Definir abordagem','Executar','Avaliar'];
  return { goalName:name, goalType:isCommercial?'FINANCIAL':'PROJECT', target, tasks, project:isNutriva?'nutriva':isCommercial?'consecom':undefined };
}

function getCtx(config: BrainConfig): string {
  try { const w = buildWorldState(config); return `${w.counts['goals']??0} goals, ${w.activeRuns.length} runs ativos`; } catch { return ''; }
}

export function managerChat(config: BrainConfig, text: string, sessionKey = 'default'): ManagerResponse {
  const trimmed = text.trim();
  if (!trimmed) return { type:'conversation', mode:'plane', message:'Digite algo.', intent:'CHAT', actions:[], requiresConfirmation:false };
  const s = getSession(sessionKey);
  s.history.push({ role:'user', text:trimmed });
  if (s.history.length > 100) s.history.shift();
  const intent = classify(trimmed, s);

  switch (intent) {
    case 'STOP': return doStop(config, s);
    case 'RESUME': return doResume(config, s);
    case 'MODE_SWITCH': return doModeSwitch(trimmed, s);
    case 'EXECUTION_CONFIRM': return doExecute(config, s);
    case 'GOAL_CREATION': return doPropose(trimmed, s);
    case 'STATUS': return doStatus(config, s);
    case 'QUESTION': return doQuestion(trimmed, config, s);
    case 'IDEA': return doIdea(trimmed, config, s);
    default: return doChat(trimmed, config, s);
  }
}

function doChat(text: string, config: BrainConfig, s: ManagerSession): ManagerResponse {
  const t = text.toLowerCase();
  if (/^(oi|olá|ola|hey|e aí|eai|bom dia|boa tarde|boa noite)\b/i.test(t))
    return { type:'conversation', mode:s.mode, message:'Oi, Wesley. Sou o Gerente do Second Brain. Posso conversar sobre estratégia, criar objetivos, distribuir tarefas e acompanhar execução. Sobre o que você quer falar?', intent:'CHAT', actions:[], requiresConfirmation:false };
  if (/(tudo bem|tudo certo|como vai|como você está)/i.test(t))
    return { type:'conversation', mode:s.mode, message:'Tudo funcionando. Tenho acesso ao banco, aos agentes e ao contexto do Second Brain. O que você quer atacar?', intent:'CHAT', actions:[], requiresConfirmation:false };
  if (/(você consegue|consegue me ajudar|pode me ajudar|pode ajudar|como funciona)/i.test(t))
    return { type:'conversation', mode:s.mode, message:'Consigo te ajudar a planejar objetivos, distribuir tarefas para os agentes, consultar o Second Brain e acompanhar execução. Você pode conversar comigo naturalmente — quando tivermos um plano, eu peço confirmação antes de executar.', intent:'CHAT', actions:[], requiresConfirmation:false };
  if (/(obrigado|valeu|show|legal|bacana|ótimo|otimo|perfeito)/i.test(t))
    return { type:'conversation', mode:s.mode, message:'Disponha. Estou aqui quando precisar.', intent:'CHAT', actions:[], requiresConfirmation:false };
  if (/(prospec|prospecção|prospection)/i.test(t))
    return { type:'conversation', mode:s.mode, message:'Sobre prospecção — temos o Prospector e o Comercial trabalhando nisso. Podemos focar em aumentar volume de leads, melhorar a qualificação, ou os dois. Qual dessas direções te interessa mais?', intent:'CHAT', actions:[], requiresConfirmation:false };
  if (/(campanha|campanhas)/i.test(t))
    return { type:'conversation', mode:s.mode, message:'Posso analisar campanhas anteriores no Second Brain e montar uma estratégia. Você tem em mente algum público ou canal específico?', intent:'CHAT', actions:[], requiresConfirmation:false };
  if (/(não|nao|deixa|depois|ainda não)/i.test(t) && s.pending)
    return { type:'conversation', mode:s.mode, message:'Sem problema. O plano fica guardado — quando quiser executar, é só dizer "pode executar".', intent:'CHAT', actions:[], requiresConfirmation:false };

  const lastTopic = s.topic ? ` Sobre ${s.topic}, ` : '';
  return { type:'conversation', mode:s.mode, message:`${lastTopic}entendi. Quer que eu analise isso mais a fundo ou transforme em algo acionável?`, intent:'CHAT', actions:[], requiresConfirmation:false };
}

function doIdea(text: string, config: BrainConfig, s: ManagerSession): ManagerResponse {
  s.topic = text.slice(0, 60);
  return { type:'conversation', mode:s.mode, message:'Boa. Posso consultar o Second Brain para ver o que já temos sobre isso e montar uma estratégia. Quer que eu aprofunde a análise ou já transforme em um objetivo com plano de ação?', intent:'IDEA', actions:[], requiresConfirmation:false };
}

function doQuestion(text: string, config: BrainConfig, s: ManagerSession): ManagerResponse {
  const t = text.toLowerCase();
  if (/(vyntra|nutriva|consecom)/i.test(t)) {
    const proj = t.match(/(vyntra|nutriva|consecom)/i)?.[1] ?? 'projeto';
    s.topic = proj;
    return { type:'conversation', mode:s.mode, message:`Tenho contexto sobre ${proj} no Second Brain. Posso puxar goals, tasks ou histórico específico. O que você quer saber?`, intent:'QUESTION', actions:[], requiresConfirmation:false };
  }
  if (/(prioridade|prioridade atual|mais importante)/i.test(t)) {
    const ctx = getCtx(config);
    return { type:'status', mode:s.mode, message:`Contexto atual: ${ctx}. Quer que eu detalhe por projeto ou por agente?`, intent:'STATUS', actions:[], requiresConfirmation:false };
  }
  if (/(situação|situação atual)/i.test(t)) {
    const ctx = getCtx(config);
    return { type:'status', mode:s.mode, message:`Situação: ${ctx}. Posso detalhar o que cada agente está fazendo se quiser.`, intent:'STATUS', actions:[], requiresConfirmation:false };
  }
  return { type:'conversation', mode:s.mode, message:'Boa pergunta. Posso consultar o Second Brain para te responder com precisão. O que especificamente você quer saber?', intent:'QUESTION', actions:[], requiresConfirmation:false };
}

function doStatus(config: BrainConfig, s: ManagerSession): ManagerResponse {
  const db = new DatabaseSync(config.dbPath);
  try {
    const states = getAllAgentStates(db);
    const working = states.filter(a=>a.state==='WORKING').length;
    const available = states.filter(a=>a.state==='AVAILABLE').length;
    const blocked = states.filter(a=>['BLOCKED','AWAITING_APPROVAL'].includes(a.state)).length;
    const ctx = getCtx(config);
    return { type:'status', mode:s.mode,
      message:`${ctx}. Agentes: ${working} trabalhando, ${available} disponíveis, ${blocked} bloqueados/aguardando.`,
      intent:'STATUS', actions:[], requiresConfirmation:false,
      contextCards:[{label:'Trabalhando',value:String(working)},{label:'Disponíveis',value:String(available)},{label:'Bloqueados',value:String(blocked)}] };
  } finally { db.close(); }
}

function doPropose(text: string, s: ManagerSession): ManagerResponse {
  const plan = extractPlan(text);
  s.pending = plan; s.topic = plan.goalName;
  const tasks = plan.tasks.map((t,i)=>`${i+1}. ${t}`).join('\n');
  const target = plan.target ? `R$${plan.target.toLocaleString('pt-BR')}` : '';
  return { type:'plan', mode:s.mode,
    message:`Entendi. Vou criar o objetivo "${plan.goalName}"${target?` (${target})`:''} e montar um plano:\n\n${tasks}\n\nPosso criar e distribuir as tarefas?`,
    intent:'GOAL_CREATION', actions:[{type:'create_goal',status:'proposed'}], requiresConfirmation:true };
}

function doExecute(config: BrainConfig, s: ManagerSession): ManagerResponse {
  const plan = s.pending;
  if (!plan) return { type:'conversation', mode:s.mode, message:'Não tenho um plano pendente. Me diz o que você quer criar.', intent:'EXECUTION_CONFIRM', actions:[], requiresConfirmation:false };
  const db = new DatabaseSync(config.dbPath);
  try {
    if (!db.prepare("SELECT id FROM agents WHERE id='manager'").get())
      db.prepare("INSERT INTO agents (id,name,description,domains,capabilities,permissions,status) VALUES ('manager','Gerente','Orquestrador','[\"management\"]','[\"planejamento\"]','[\"context\"]','AVAILABLE')").run();
    const goal = createGoal(db, { name:plan.goalName, type:plan.goalType, status:'ACTIVE', ownerAgent:'manager', metricName:plan.goalType==='FINANCIAL'?'receita':undefined, target:plan.target, currentValue:plan.goalType==='FINANCIAL'?0:undefined });
    persistGoalKnowledge(config, goal);
    db.prepare("INSERT INTO events (event_type,subject,payload) VALUES ('command_center_order','manager',?)").run(JSON.stringify({goalId:goal.id}));
    const init = createInitiative(db, { title:plan.goalName, description:'Plano via Command Center.', goalId:goal.id, project:plan.project??undefined, status:'PROPOSED' });
    planInitiative(db, init.id, plan.tasks);
    const ready = refreshQueue(db, init.id);
    if (ready[0]!==undefined) assignTask(db, ready[0], { agentId:'manager', reason:'Manager delegou primeira task' });
    persistInitiativeKnowledge(config, goal, init, plan.tasks);
    s.pending = null;
    return { type:'execution', mode:s.mode,
      message:`Objetivo "${plan.goalName}" criado com ${plan.tasks.length} tarefas. Primeira task dispatchada. Tudo registrado no Obsidian.`,
      intent:'GOAL_CREATION', actions:[{type:'create_goal',status:'executed',detail:goal.id},{type:'create_initiative',status:'executed',detail:init.id}], requiresConfirmation:false };
  } finally { db.close(); }
}

function doStop(config: BrainConfig, s: ManagerSession): ManagerResponse {
  const db = new DatabaseSync(config.dbPath);
  try { setKillSwitch(true);
    db.prepare("UPDATE agent_runs SET kill_switch=1,previous_state=state,state='PAUSED' WHERE state NOT IN ('COMPLETED','FAILED','CANCELLED')").run();
    db.prepare("INSERT INTO events (event_type,subject,payload) VALUES ('kill_switch_activated','manager','{}')").run();
    return { type:'execution', mode:s.mode, message:'Kill switch ativado. Runs pausados.', intent:'STOP', actions:[{type:'kill_switch',status:'executed'}], requiresConfirmation:false };
  } finally { db.close(); }
}

function doResume(config: BrainConfig, s: ManagerSession): ManagerResponse {
  const db = new DatabaseSync(config.dbPath);
  try { setKillSwitch(false);
    const r = db.prepare("UPDATE agent_runs SET kill_switch=0,state='READY' WHERE kill_switch=1 AND state='PAUSED'").run();
    return { type:'execution', mode:s.mode, message:`Operações retomadas (${r.changes} runs recuperados).`, intent:'RESUME', actions:[{type:'resume',status:'executed'}], requiresConfirmation:false };
  } finally { db.close(); }
}

function doModeSwitch(text: string, s: ManagerSession): ManagerResponse {
  const mode = text.trim().toLowerCase().replace(/[.!?]+$/,'') as ManagerMode;
  s.mode = mode;
  const descriptions: Record<ManagerMode,string> = {
    plane:'Modo Plane ativo. Posso conversar, analisar, planejar e propor estratégias. Não executo nada sem sua confirmação.',
    brain:'Modo Brain ativo. Vou consultar o Second Brain e o contexto antes de responder.',
    build:'Modo Build ativo. Pronto para executar tarefas de engenharia via OpenCode.',
  };
  return { type:'conversation', mode, message:descriptions[mode], intent:'MODE_SWITCH', actions:[], requiresConfirmation:false };
}
