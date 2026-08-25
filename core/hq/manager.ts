import { DatabaseSync } from "node:sqlite";
import type { BrainConfig } from "../config/loader.ts";
import { createGoal } from "../goals/goal-engine.ts";
import { createInitiative, planInitiative } from "../goals/initiatives.ts";
import { refreshQueue, assignTask } from "../agents/agent-os.ts";
import { setKillSwitch } from "../autonomous/cycle.ts";
import { buildWorldState } from "../agents/world-state.ts";
import { persistGoalKnowledge, persistInitiativeKnowledge } from "../obsidian/knowledge-records.ts";
import { createNotification } from "./notifications.ts";
import { completeWithGateway } from "../ai/model-router.ts";
import { getAllAgentStates } from "./agent-state.ts";

export type ManagerMode = 'plane' | 'brain' | 'build';
export type ManagerIntent = 'CHAT'|'QUESTION'|'IDEA'|'GOAL_CREATION'|'EXECUTION_CONFIRM'|'STOP'|'RESUME'|'STATUS'|'DIAGNOSIS'|'MODE_SWITCH'|'BRAIN_QUERY'|'IMAGE_REQUEST';

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
  lastBrainResult: string|null;
  lastPlanSummary: string|null;
  llmProposedPlan: boolean;
}

const sessions = new Map<string, ManagerSession>();
function getSession(key: string): ManagerSession {
  if (!sessions.has(key)) sessions.set(key, { mode:'plane', pending:null, history:[], topic:null, lastBrainResult:null, lastPlanSummary:null, llmProposedPlan:false });
  return sessions.get(key)!;
}

/* ── CONTEXT ASSEMBLY ── */

function buildSystemContext(config: BrainConfig, s: ManagerSession): string {
  const db = new DatabaseSync(config.dbPath);
  try {
    const parts: string[] = [];

    // Active goals
    const goals = db.prepare("SELECT name,type,target,current_value,status FROM goals WHERE status='ACTIVE' ORDER BY updated_at DESC LIMIT 5").all() as unknown as Array<{name:string;type:string;target:number|null;current_value:number|null;status:string}>;
    if (goals.length) parts.push(`Objetivos ativos: ${goals.map(g=>`"${g.name}"${g.target?` (meta: ${g.target})`:''}`).join('; ')}`);

    // Recent tasks
    const tasks = db.prepare("SELECT title,status,assigned_agent FROM initiative_tasks WHERE status NOT IN ('COMPLETED','CANCELLED') ORDER BY id DESC LIMIT 8").all() as unknown as Array<{title:string;status:string;assigned_agent:string|null}>;
    if (tasks.length) parts.push(`Tarefas abertas: ${tasks.map(t=>`"${t.title}" (${t.status}, ${t.assigned_agent||'sem agente'})`).join('; ')}`);

    // Agent states
    const states = getAllAgentStates(db);
    const summary = states.map(a=>`${a.agentId}=${a.state}`).join(', ');
    parts.push(`Agentes: ${summary}`);

    // Recent completed work
    const done = db.prepare("SELECT title FROM initiative_tasks WHERE status='COMPLETED' ORDER BY completed_at DESC LIMIT 5").all() as unknown as Array<{title:string}>;
    if (done.length) parts.push(`Recentemente concluído: ${done.map(d=>`"${d.title}"`).join('; ')}`);

    // Relevant memories via FTS (if topic is set)
    if (s.topic) {
      try {
        const mems = db.prepare("SELECT content FROM memories_fts WHERE memories_fts MATCH ? LIMIT 5").all(`"${s.topic}"`) as unknown as Array<{content:string}>;
        if (mems.length) parts.push(`Contexto do Second Brain sobre "${s.topic}":\n${mems.map(m=>`- ${m.content.slice(0,150)}`).join('\n')}`);
      } catch {}
    }

    // Conversation topic and pending state
    if (s.topic) parts.push(`Tópico atual da conversa: ${s.topic}`);
    if (s.pending) parts.push(`PLANO PENDENTE DE CONFIRMAÇÃO: "${s.pending.goalName}" com ${s.pending.tasks.length} tarefas.`);
    if (s.lastBrainResult) parts.push(`Última consulta ao Brain: ${s.lastBrainResult.slice(0,300)}`);

    // World state
    try { const w = buildWorldState(config); parts.push(`Sistema: ${w.counts['goals']??0} goals, ${w.activeRuns.length} runs ativos, ${w.blockedRuns.length} bloqueados.`); } catch {}

    // Conversation history (last 6 messages)
    const recent = s.history.slice(-6);
    if (recent.length > 1) {
      parts.push(`Histórico recente:\n${recent.map(h=>`${h.role==='user'?'Usuário':'Gerente'}: ${h.text.slice(0,200)}`).join('\n')}`);
    }

    return parts.join('\n\n');
  } finally { db.close(); }
}

/* ── LLM CALL ── */

const SYSTEM_PROMPT = `Você é o Gerente do Second Brain OS, um sistema operacional empresarial multiagente.

Sua função:
- Conversar naturalmente com o dono (Wesley) em português brasileiro.
- Entender o que ele quer, mesmo quando usa pronomes ("isso", "aquilo", "ele") ou comandos curtos ("aprofunda", "continue", "faz").
- Consultar o contexto fornecido abaixo para dar respostas baseadas em dados REAIS.
- Quando o usuário pedir informações sobre projetos, tarefas ou agentes, use os dados do contexto.
- Quando o usuário tiver uma ideia, ajude a estruturá-la.
- Quando o usuário quiser criar um objetivo, propor um plano e peça confirmação.
- NUNCA invente dados que não estão no contexto.
- Se o contexto não tiver a informação, diga que não encontrou e ofereça buscar.

IMPORTANTE — AÇÃO OPERACIONAL:
Quando você propor um plano, objetivo, ou sugerir criar tarefas/goals/initiatives,
SEMPRE termine sua resposta com o marcador exato [PROPOSTA] na última linha.
Isso sinaliza ao sistema que você está aguardando confirmação para executar.
Exemplo:
"...Posso criar esse objetivo e distribuir as tarefas?
[PROPOSTA]"

Quando o usuário já confirmou e você está descrevendo o que foi executado, use [EXECUTADO].

Regras:
- Seja direto e natural, como um gerente de verdade.
- Não repita informações que já deu na conversa.
- Se o usuário disser "aprofunde", expanda a resposta anterior com mais detalhes do contexto.
- Se o usuário disser "e o que falta?", liste o que ainda não foi feito.
- Se o usuário disser "transforma isso em plano", proponha um plano estruturado.
- Se o usuário confirmar ("pode", "sim", "executa"), confirme que vai executar.
- NUNCA responda com templates genéricos como "quer que eu analise mais a fundo?" quando você já tem dados para responder.`;

async function callLLM(config: BrainConfig, s: ManagerSession, userMessage: string): Promise<string | null> {
  const context = buildSystemContext(config, s);
  const messages = [
    { role: 'system' as const, content: `${SYSTEM_PROMPT}\n\n--- CONTEXTO ATUAL DO SISTEMA ---\n${context}\n--- FIM DO CONTEXTO ---` },
    ...s.history.slice(-10).map(h => ({ role: h.role === 'user' ? 'user' as const : 'assistant' as const, content: h.text })),
    { role: 'user' as const, content: userMessage },
  ];
  try {
    const result = await completeWithGateway(null, { messages, maxTokens: 800, temperature: 0.3 }, { workload: 'reasoning', agent: 'manager', task: userMessage });
    console.log(`[manager] LLM responded via ${result.provider}/${result.model} (${result.latencyMs}ms)`);
    return result.content;
  } catch (error) {
    console.error(`[manager] LLM call failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/* ── DETERMINISTIC FALLBACK (no LLM) ── */

function fallbackResponse(config: BrainConfig, text: string, s: ManagerSession): ManagerResponse {
  const t = text.trim().toLowerCase().replace(/[.!?]+$/,'');
  const db = new DatabaseSync(config.dbPath);

  // Anti-loop: if this exact message was the last one, and we're about to repeat, change behavior
  const lastManagerMsg = s.history.filter(h => h.role === 'manager').slice(-1)[0]?.text ?? '';

  try {
    // ── GREETINGS (including variants with spaces) ──
    if (/^(oi+|olá|ola|hey|e\s+a[íi]|eai|e\s+ai|bom dia|boa tarde|boa noite|opa|fala)\b/i.test(t))
      return resp(s, 'Oi! Sou o Gerente. Posso conversar sobre estratégia, criar objetivos, consultar o Second Brain e coordenar os agentes. Sobre o que quer falar?');

    if (/(tudo bem|tudo certo|como vai|como você está|belez)/i.test(t))
      return resp(s, 'Tudo funcionando. Tenho acesso ao banco de dados, aos agentes e ao Second Brain. O que você quer fazer?');

    // ── AFFIRMATIVE WITHOUT PENDING PLAN ──
    // User says "sim" but there's no pending plan → check if we can aprofunde or execute last context
    if (/^(sim|pode|executa|manda ver|vai|confirmo|go|beleza|ok|okay)\b/i.test(t) && !s.pending) {
      if (s.lastBrainResult) {
        // User is confirming "aprofunde" — actually do it
        const deep = db.prepare("SELECT content FROM memories_fts WHERE memories_fts MATCH ? LIMIT 8").all(`"${s.topic ?? 'nutriva'}"`) as unknown as Array<{content:string}>;
        const tasks = db.prepare("SELECT title,status FROM initiative_tasks ORDER BY id DESC LIMIT 10").all() as unknown as Array<{title:string;status:string}>;
        const parts: string[] = [];
        if (deep.length) parts.push(`Contexto do Second Brain:\n${deep.map(m=>`• ${m.content.slice(0,180)}`).join('\n')}`);
        if (tasks.length) parts.push(`Tarefas:\n${tasks.map(t=>`• ${t.title} (${t.status})`).join('\n')}`);
        if (parts.length) {
          const result = parts.join('\n\n');
          s.lastBrainResult = result;
          return resp(s, `Aprofundando sobre ${s.topic ?? 'o tópico'}:\n\n${result}\n\nQuer que eu transforme isso em um plano de ação?`);
        }
      }
      // Nothing to confirm or expand
      return resp(s, 'Não tenho um plano pendente para confirmar. Se você quiser, posso criar um objetivo, consultar o Second Brain ou verificar o status dos agentes. O que você quer fazer?');
    }

    // ── NEGATIVE WITHOUT PENDING PLAN ──
    if (/^(não|nao|deixa|depois|cancela|para)\b/i.test(t) && !s.pending)
      return resp(s, 'Ok. Podemos conversar sobre outra coisa ou criar um novo objetivo. O que você prefere?');

    // ── FOLLOW-UP: aprofundar ──
    if (/(aprofund|expand|detalh|mais sobre|me conta mais)/i.test(t)) {
      if (s.lastBrainResult) {
        const deep = db.prepare("SELECT content FROM memories_fts WHERE memories_fts MATCH ? LIMIT 8").all(`"${s.topic ?? 'nutriva'}"`) as unknown as Array<{content:string}>;
        const parts: string[] = [];
        if (deep.length) parts.push(`Mais contexto:\n${deep.map(m=>`• ${m.content.slice(0,180)}`).join('\n')}`);
        if (parts.length) return resp(s, `Aprofundando sobre ${s.topic ?? 'o tópico'}:\n\n${parts.join('\n\n')}\n\nQuer que eu transforme em um plano?`);
      }
      return resp(s, `Não tenho mais detalhes armazenados sobre ${s.topic ?? 'isso'} no momento. Quer que eu crie um objetivo para investigar mais a fundo?`);
    }

    // ── FOLLOW-UP: "e o que falta?" ──
    if (/(o que falta|próximos passos|o que ainda|o que precisa)/i.test(t)) {
      if (s.topic) {
        const tasks = db.prepare("SELECT title,status FROM initiative_tasks WHERE status NOT IN ('COMPLETED','CANCELLED') ORDER BY id DESC LIMIT 10").all() as unknown as Array<{title:string;status:string}>;
        if (tasks.length) return resp(s, `O que ainda está em aberto:\n${tasks.map(t=>`• ${t.title} (${t.status})`).join('\n')}`);
      }
      const w = buildWorldState(config);
      return resp(s, `Tarefas abertas: ${w.counts['initiative_tasks'] ?? 0}. Runs ativos: ${w.activeRuns.length}.`);
    }

    // ── FOLLOW-UP: "o que está pronto?" / "o que temos?" ──
    if (/(o que está pronto|o que já foi|o que temos|o que existe|o que já)/i.test(t)) {
      const topic = s.topic;
      if (topic) {
        const done = db.prepare("SELECT title FROM initiative_tasks WHERE status='COMPLETED' ORDER BY completed_at DESC LIMIT 8").all() as unknown as Array<{title:string}>;
        const mems = db.prepare("SELECT content FROM memories_fts WHERE memories_fts MATCH ? LIMIT 5").all(`"${topic}"`) as unknown as Array<{content:string}>;
        const parts: string[] = [];
        if (done.length) parts.push(`Concluído:\n${done.map(d=>`✅ ${d.title}`).join('\n')}`);
        if (mems.length) parts.push(`Contexto do Second Brain:\n${mems.map(m=>`• ${m.content.slice(0,180)}`).join('\n')}`);
        if (parts.length) {
          const result = parts.join('\n\n');
          s.lastBrainResult = result;
          return resp(s, `Sobre ${topic}:\n\n${result}\n\nQuer que eu aprofunde ou transforme em plano?`);
        }
      }
    }

    // ── FOLLOW-UP: "e o marketing?" etc ──
    const deptMatch = t.match(/e (o|a) (marketing|comercial|prospec|desenvolv|manuten|nutriva|vyntra)/i);
    if (deptMatch) {
      const dept = deptMatch[2] ?? '';
      s.topic = dept;
      const agents = db.prepare("SELECT id,status FROM agents WHERE domains LIKE ? OR id LIKE ?").all(`%${dept}%`, `%${dept}%`) as unknown as Array<{id:string;status:string}>;
      if (agents.length) return resp(s, `Sobre ${dept}:\n${agents.map(a=>`• ${a.id}: ${a.status}`).join('\n')}`);
    }

    // ── NUTRIVA ──
    if (/(nutriva)/i.test(t)) {
      s.topic = 'nutriva';
      const done = db.prepare("SELECT title FROM initiative_tasks WHERE status='COMPLETED' ORDER BY completed_at DESC LIMIT 10").all() as unknown as Array<{title:string}>;
      const mems = db.prepare("SELECT content FROM memories_fts WHERE memories_fts MATCH 'nutriva' LIMIT 5").all() as unknown as Array<{content:string}>;
      const parts: string[] = [];
      if (done.length) parts.push(`Concluído:\n${done.map(d=>`✅ ${d.title}`).join('\n')}`);
      if (mems.length) parts.push(`Contexto:\n${mems.map(m=>`• ${m.content.slice(0,180)}`).join('\n')}`);
      const result = parts.length ? parts.join('\n\n') : 'O Nutriva tem nutrition engine determinístico, banco de 30 alimentos, patient CRUD com tenant isolation, meal plan API e schema próprio (v1). Ainda faltam: frontend completo, substitution engine, PDF generation, recipe engine e WhatsApp delivery.';
      s.lastBrainResult = result;
      return resp(s, `Sobre o Nutriva:\n\n${result}\n\nQuer que eu aprofunde algum ponto ou transforme em plano?`);
    }

    // ── PROSPECÇÃO ──
    if (/(prospec|prospecção|leads)/i.test(t)) {
      s.topic = 'prospecção';
      return resp(s, 'Sobre prospecção — temos o Prospector e o time Comercial. Podemos aumentar volume de leads, melhorar qualificação, ou os dois. Qual direção te interessa?');
    }

    // ── IDEA ──
    if (/(pensando|ideia|que tal|e se|imagina|talvez)/i.test(t)) {
      s.topic = text.slice(0, 50);
      return resp(s, 'Boa ideia. Posso consultar o Second Brain para ver o que já temos e montar uma estratégia. Quer que eu aprofunde ou transforme em objetivo?');
    }

    // ── IMAGE ──
    if (/(faz|crie|gere|gerar)\s+(uma?\s+)?(imagem|foto|desenho)/i.test(t))
      return resp(s, 'Consigo preparar a geração, mas nenhum provider de imagem está configurado. Configure OPENROUTER_API_KEY para habilitar.');

    // ── PENDING CONFIRMATION ──
    if (s.pending && /^(sim|pode|executa|manda ver|vai|confirmo|go)\b/i.test(t)) return doExecute(config, s);
    if (s.pending && /^(não|nao|deixa|depois|cancela)\b/i.test(t)) {
      s.pending = null;
      return resp(s, 'Plano cancelado. Podemos conversar sobre outra coisa.');
    }

    // ── GOAL CREATION ──
    if (/(quero|precisamos|preciso)\s+(de\s+)?(faturar|alcançar|vender|criar)\s+/i.test(t) || /r\$\s*[\d.,]+/i.test(t)) {
      const plan = extractPlan(text);
      s.pending = plan;
      const target = plan.target ? `R$${plan.target.toLocaleString('pt-BR')}` : '';
      return { type:'plan', mode:s.mode, message:`Entendi. Vou criar o objetivo "${plan.goalName}"${target?` (${target})`:''} com ${plan.tasks.length} tarefas:\n\n${plan.tasks.map((t,i)=>`${i+1}. ${t}`).join('\n')}\n\nPosso criar e distribuir?`, intent:'GOAL_CREATION', actions:[{type:'create_goal',status:'proposed'}], requiresConfirmation:true };
    }

    // ── STATUS ──
    if (/(status|progresso|situação|como estamos|como está|prioridade)/i.test(t)) {
      const w = buildWorldState(config);
      return { type:'status', mode:s.mode, message:`${w.counts['goals']??0} goals, ${w.counts['initiative_tasks']??0} tarefas, ${w.activeRuns.length} runs ativos.`, intent:'STATUS', actions:[], requiresConfirmation:false };
    }

    // ── STOP/RESUME ──
    if (/^(pare tudo|para tudo|kill)/i.test(t)) return doStop(config, s);
    if (/^(continue|retomar|resume)$/i.test(t)) return doResume(config, s);

    // ── GENERIC (with anti-loop) ──
    if (s.topic) {
      // If the last manager message was the same generic topic prompt, try a different angle
      if (lastManagerMsg.includes(`Sobre ${s.topic}`)) {
        return resp(s, `Sobre ${s.topic} — posso criar um objetivo, consultar o Second Brain para mais detalhes, ou verificar o status das tarefas. O que você prefere?`);
      }
      return resp(s, `Sobre ${s.topic} — quer que eu aprofunde, transforme em plano, ou consulte o Second Brain?`);
    }

    return resp(s, 'Entendi. Posso ajudar de forma mais específica se você me disser o que quer: criar um objetivo, consultar um projeto, verificar status, ou conversar sobre estratégia.');
  } finally { db.close(); }
}

function resp(s: ManagerSession, message: string): ManagerResponse {
  s.history.push({ role:'manager', text:message });
  return { type:'conversation', mode:s.mode, message, intent:'CHAT', actions:[], requiresConfirmation:false };
}

/* ── MAIN ENTRY ── */

export async function managerChat(config: BrainConfig, text: string, sessionKey = 'default'): Promise<ManagerResponse> {
  const trimmed = text.trim();
  if (!trimmed) return { type:'conversation', mode:'plane', message:'Digite algo.', intent:'CHAT', actions:[], requiresConfirmation:false };

  const s = getSession(sessionKey);
  s.history.push({ role:'user', text:trimmed });
  if (s.history.length > 100) s.history.shift();
  const t = trimmed.toLowerCase().replace(/[.!?]+$/,'');

  // ── 1. EXPLICIT COMMANDS (always deterministic, never LLM) ──
  if (/^(pare tudo|para tudo|kill switch|stop everything)$/i.test(t)) return doStop(config, s);
  if (/^(continue|retomar|resume)$/i.test(t)) return doResume(config, s);
  if (/^(plane|brain|build)$/i.test(t)) { s.mode = t as ManagerMode; return resp(s, `Modo ${s.mode} ativo.`); }

  // ── 2. CONFIRMATION — executes REAL actions ──
  if (/^(pode|pode executar|sim|executa|executar|manda ver|vai|confirmo|go|beleza|ok|okay|faz|faça)\b/i.test(t)) {
    if (s.pending) return doExecute(config, s);
    if (s.llmProposedPlan) {
      s.llmProposedPlan = false;
      return executeRealPlan(config, s);
    }
  }

  // ── 3. REJECTION ──
  if (/^(não|nao|deixa|depois|cancela|para|espera|volta)\b/i.test(t)) {
    if (s.pending) { s.pending = null; return resp(s, 'Plano cancelado. Podemos conversar sobre outra coisa.'); }
    if (s.llmProposedPlan) { s.llmProposedPlan = false; return resp(s, 'Ok, plano descartado. O que você prefere?'); }
  }

  // ── 4. Call LLM for natural conversation ──
  const llmResponse = await callLLM(config, s, trimmed);
  if (llmResponse && llmResponse.trim()) {
    s.history.push({ role:'manager', text:llmResponse });
    if (/modo brain/i.test(llmResponse)) s.mode = 'brain';
    if (/modo build/i.test(llmResponse)) s.mode = 'build';
    if (/modo plane/i.test(llmResponse)) s.mode = 'plane';

    // Structured plan detection: LLM marks proposals with [PROPOSTA]
    const isProposal = llmResponse.includes('[PROPOSTA]');
    const cleanResponse = llmResponse.replace(/\[PROPOSTA\]\s*$/,'').replace(/\[EXECUTADO\]\s*$/,'').trim();
    s.llmProposedPlan = isProposal;

    if (isProposal && !s.topic) s.topic = extractTopic(trimmed);

    return { type:isProposal ? 'plan' : 'conversation', mode:s.mode, message:cleanResponse, intent:'CHAT',
      actions:isProposal ? [{type:'create_goal',status:'proposed'}] : [],
      requiresConfirmation:isProposal };
  }

  // ── 5. Deterministic fallback (no LLM configured) ──
  const intent = classifyFallback(trimmed, s);
  switch (intent) {
    case 'STOP': return doStop(config, s);
    case 'RESUME': return doResume(config, s);
    case 'MODE_SWITCH': { s.mode = trimmed.toLowerCase().replace(/[.!?]+$/,'') as ManagerMode; return resp(s, `Modo ${s.mode} ativo.`); }
    case 'EXECUTION_CONFIRM': return doExecute(config, s);
    case 'GOAL_CREATION': return doPropose(trimmed, s);
    default: return fallbackResponse(config, trimmed, s);
  }
}

function extractTopic(text: string): string {
  const t = text.toLowerCase();
  if (/nutriva/i.test(t)) return 'nutriva';
  if (/vyntra/i.test(t)) return 'vyntra';
  if (/prospec|lead/i.test(t)) return 'prospecção';
  if (/venda|faturar|receita/i.test(t)) return 'vendas';
  if (/marketing|campanha/i.test(t)) return 'marketing';
  return text.slice(0, 40);
}

/**
 * Executes a REAL plan based on the conversation context.
 * Called when the LLM proposed a plan and the user confirmed.
 * Creates actual Goal, Initiative and Tasks in the database.
 */
function executeRealPlan(config: BrainConfig, s: ManagerSession): ManagerResponse {
  const db = new DatabaseSync(config.dbPath);
  try {
    if (!db.prepare("SELECT id FROM agents WHERE id='manager'").get())
      db.prepare("INSERT INTO agents (id,name,description,domains,capabilities,permissions,status) VALUES ('manager','Gerente','Orquestrador','[\"management\"]','[\"planejamento\"]','[\"context\"]','AVAILABLE')").run();

    const topic = s.topic ?? 'Novo projeto';
    const goalName = `Executar: ${topic}`;
    const goal = createGoal(db, { name:goalName, type:'PROJECT', status:'ACTIVE', ownerAgent:'manager' });
    persistGoalKnowledge(config, goal);
    db.prepare("INSERT INTO events (event_type,subject,payload) VALUES ('manager_plan_executed','manager',?)").run(JSON.stringify({goalId:goal.id,topic}));

    // Extract task titles from the LLM conversation
    const taskTitles = s.history
      .filter(h => h.role === 'manager' && /\d\.\s|tarefa|implementar|criar|desenvolver/i.test(h.text))
      .flatMap(h => (h.text.match(/\d\.\s+\*\*([^*]+)\*\*/g) ?? h.text.split('\n').filter(l => /^\d+\./.test(l.trim())))
        .map(l => l.replace(/^\d+\.\s*\*?\*?/, '').replace(/\*\*/g,'').trim().slice(0, 80)))
      .filter(t => t.length > 5 && !/confirm|validar com você|registr/i.test(t))
      .slice(0, 8);

    const finalTasks = taskTitles.length > 0 ? taskTitles : [
      `Analisar escopo de ${topic}`,
      `Implementar núcleo de ${topic}`,
      `Testar e validar ${topic}`,
      `Documentar e finalizar ${topic}`,
    ];

    const init = createInitiative(db, { title:`${topic}: plano de execução`, description:'Plano criado via conversa com o Gerente.', goalId:goal.id, project:topic.toLowerCase().includes('nutriva')?'nutriva':undefined, status:'PROPOSED' });
    planInitiative(db, init.id, finalTasks);
    const ready = refreshQueue(db, init.id);
    if (ready[0]!==undefined) assignTask(db, ready[0], { agentId:'engineering-agent', reason:'Manager delegou primeira task do plano conversacional' });
    persistInitiativeKnowledge(config, goal, init, finalTasks);

    // Notify owner that tasks were created and dispatched
    createNotification(db, {
      type: 'info',
      title: `📋 Plano criado: ${goalName}`,
      body: `${finalTasks.length} tarefas criadas. Primeira task dispatchada para Engineering Agent.`,
      goalId: goal.id,
    });

    return { type:'execution', mode:s.mode,
      message:`Plano executado. Criei o objetivo "${goalName}" com ${finalTasks.length} tarefas:\n${finalTasks.map((t,i)=>`${i+1}. ${t}`).join('\n')}\n\nA primeira tarefa foi dispatchada para o Engineering Agent. Acompanhe o progresso no escritório.`,
      intent:'GOAL_CREATION',
      actions:[{type:'create_goal',status:'executed',detail:goal.id},{type:'create_initiative',status:'executed',detail:init.id}],
      requiresConfirmation:false };
  } finally { db.close(); }
}

function classifyFallback(text: string, s: ManagerSession): ManagerIntent {
  const t = text.trim().toLowerCase().replace(/[.!?]+$/,'');
  if (/^(pare tudo|para tudo|kill)/i.test(t)) return 'STOP';
  if (/^(continue|retomar|resume)$/i.test(t)) return 'RESUME';
  if (/^(plane|brain|build)$/i.test(t)) return 'MODE_SWITCH';
  if (s.pending && /^(pode|executa|sim|vai|manda ver|go)\b/i.test(t)) return 'EXECUTION_CONFIRM';
  if (/(quero|precisamos|preciso)\s+(de\s+)?(faturar|alcançar|vender|criar)\s+/i.test(t) || /r\$\s*[\d.,]+/i.test(t)) return 'GOAL_CREATION';
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

function doPropose(text: string, s: ManagerSession): ManagerResponse {
  const plan = extractPlan(text);
  s.pending = plan; s.topic = plan.goalName;
  const tasks = plan.tasks.map((t,i)=>`${i+1}. ${t}`).join('\n');
  const target = plan.target ? `R$${plan.target.toLocaleString('pt-BR')}` : '';
  return { type:'plan', mode:s.mode, message:`Entendi. Vou criar o objetivo "${plan.goalName}"${target?` (${target})`:''} e montar um plano:\n\n${tasks}\n\nPosso criar e distribuir as tarefas?`, intent:'GOAL_CREATION', actions:[{type:'create_goal',status:'proposed'}], requiresConfirmation:true };
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
    s.pending = null; s.lastPlanSummary = plan.goalName;
    return { type:'execution', mode:s.mode, message:`Objetivo "${plan.goalName}" criado com ${plan.tasks.length} tarefas. Primeira task dispatchada. Tudo registrado no Obsidian.`, intent:'GOAL_CREATION', actions:[{type:'create_goal',status:'executed',detail:goal.id},{type:'create_initiative',status:'executed',detail:init.id}], requiresConfirmation:false };
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
