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
import { runInitiativeParallel } from "./orchestrator.ts";

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

function getSession(key: string, config?: BrainConfig): ManagerSession {
  if (sessions.has(key)) return sessions.get(key)!;

  // Try to restore from database
  const session: ManagerSession = { mode:'plane', pending:null, history:[], topic:null, lastBrainResult:null, lastPlanSummary:null, llmProposedPlan:false };
  if (config) {
    try {
      const db = new DatabaseSync(config.dbPath);
      try {
        const rows = db.prepare(
          "SELECT role,content FROM manager_messages WHERE session_key=? ORDER BY id ASC LIMIT 50"
        ).all(key) as unknown as Array<{role:string;content:string}>;
        for (const row of rows) {
          session.history.push({ role: row.role as 'user'|'manager', text: row.content });
          if (row.role === 'manager' && /sobre (nutriva|vyntra|prospec|vendas|marketing)/i.test(row.content)) {
            const m = row.content.match(/sobre (nutriva|vyntra|prospec[^—]*|vendas|marketing)/i);
            if (m?.[1]) session.topic = m[1].trim().toLowerCase();
          }
        }
        const meta = db.prepare("SELECT mode,topic,last_brain_result FROM manager_sessions WHERE session_key=?").get(key) as {mode:string;topic:string;last_brain_result:string}|undefined;
        if (meta) {
          session.mode = (meta.mode ?? 'plane') as ManagerMode;
          session.topic = meta.topic ?? session.topic;
          session.lastBrainResult = meta.last_brain_result ?? null;
        }
      } finally { db.close(); }
    } catch {}
  }
  sessions.set(key, session);
  return session;
}

function persistMessage(config: BrainConfig, sessionKey: string, role: 'user'|'manager', text: string, mode: ManagerMode, topic: string|null, lastBrainResult: string|null): void {
  try {
    const db = new DatabaseSync(config.dbPath);
    try {
      db.prepare("INSERT INTO manager_messages (session_key,role,content) VALUES (?,?,?)").run(sessionKey, role, text.slice(0,2000));
      db.prepare(`INSERT INTO manager_sessions (session_key,mode,topic,last_brain_result,updated_at)
        VALUES (?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        ON CONFLICT(session_key) DO UPDATE SET mode=excluded.mode,topic=excluded.topic,last_brain_result=excluded.last_brain_result,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')`)
        .run(sessionKey, mode, topic ?? '', lastBrainResult ?? '');
    } finally { db.close(); }
  } catch {}
}

/* ── CONTEXT ASSEMBLY ── */

export function buildSystemContext(config: BrainConfig, s: ManagerSession): string {
  const db = new DatabaseSync(config.dbPath);
  try {
    const parts: string[] = [];

    // Active goals
    const goals = db.prepare("SELECT name,type,target,current_value,status FROM goals WHERE status='ACTIVE' ORDER BY updated_at DESC LIMIT 5").all() as unknown as Array<{name:string;type:string;target:number|null;current_value:number|null;status:string}>;
    if (goals.length) parts.push(`Objetivos ativos: ${goals.map(g=>`"${g.name}"${g.target?` (meta: ${g.target})`:''}`).join('; ')}`);

    // Projects registry (formal operational units)
    const projects = db.prepare("SELECT name,status,priority FROM projects ORDER BY CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, name").all() as Array<{name:string;status:string;priority:string}>;
    if (projects.length) parts.push(`Projetos registrados: ${projects.map((p)=>`"${p.name}" (${p.status}, prioridade ${p.priority})`).join("; ")}`);

    // Recent goals regardless of status (ACHIEVED/PAUSED etc. still exist!)
    const otherGoals = db.prepare("SELECT name,status,updated_at FROM goals WHERE status!='ACTIVE' ORDER BY updated_at DESC LIMIT 6").all() as unknown as Array<{name:string;status:string;updated_at:string}>;
    if (otherGoals.length) parts.push(`Outros objetivos no histórico: ${otherGoals.map(g=>`"${g.name}" (${g.status})`).join('; ')}`);

    // Initiatives = registered projects/plans
    const inits = db.prepare("SELECT title,status,project FROM initiatives ORDER BY rowid DESC LIMIT 8").all() as unknown as Array<{title:string;status:string;project:string|null}>;
    if (inits.length) parts.push(`Iniciativas/projetos registrados: ${inits.map(i=>`"${i.title}" (${i.status}${i.project?`, projeto ${i.project}`:''})`).join('; ')}`);

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
- REGRA CRÍTICA: se o contexto listar objetivos, iniciativas, projetos ou tarefas, você DEVE citá-los
  quando perguntarem sobre eles. NUNCA afirme que "não há nada registrado" ou que "não existe nada"
  sobre um assunto se o contexto contém itens relacionados. Procure por palavras-chave do assunto
  (ex.: "Nutriva") em TODAS as seções do contexto, incluindo histórico e concluídos.
- Um objetivo concluído (ACHIEVED) ou tarefa COMPLETA ainda é informação real: relate o que foi feito e quando.

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

/** Wrapper used by managerChat: opens the DB and tries the deterministic status answer first. */
function tryAnswerStatus(config: BrainConfig, t: string): string | null {
  const db = new DatabaseSync(config.dbPath);
  try { return answerOperationalStatus(db, t); } catch { return null; } finally { db.close(); }
}

/**
 * Deterministic operational-status answers from REAL system state.
 * Returns null when the question is not an operational status query.
 */
function answerOperationalStatus(db: DatabaseSync, t: string): string | null {
  const isQuestion = /\?|como est|qual|quais|quem|o que|quantos|em que etapa|por que|pr[oó]xim/i.test(t);
  if (!isQuestion) return null;

  // "O que o Developer 01 está fazendo?"
  if (/o que .* (est[áa]|ta) (fazendo|trabalhando)/i.test(t) || /em que etapa/i.test(t)) {
    const devMatch = t.match(/developer\s*0?(\d)/i);
    const token = devMatch ? `developer-0${devMatch[1]}` : (t.match(/(?:o|a)\s+([a-z0-9\- ]+)\s+est/)?.[1]?.trim() ?? "");
    const agentId = devMatch ? token : (db.prepare("SELECT id FROM agents WHERE id LIKE ? OR LOWER(name) LIKE ?").get(`%${token}%`, `%${token}%`) as {id:string}|undefined)?.id;
    if (!agentId) return null;
    const task = db.prepare("SELECT title,status FROM initiative_tasks WHERE assigned_agent=? AND status IN ('RUNNING','ASSIGNED','READY','WAITING') ORDER BY id DESC LIMIT 1").get(agentId) as {title:string;status:string}|undefined;
    const lastLog = db.prepare("SELECT stage,message,created_at FROM agent_task_logs WHERE agent_id=? ORDER BY id DESC LIMIT 1").get(agentId) as {stage:string;message:string;created_at:string}|undefined;
    if (!task && !lastLog) return `${agentId}: sem tarefas atribuídas no momento (disponível).`;
    const parts = [`${agentId}:`];
    if (task) parts.push(`task "${task.title}" (${task.status}).`);
    if (lastLog) parts.push(`Última etapa [${lastLog.stage}] às ${lastLog.created_at.slice(11,19)}: ${lastLog.message}`);
    return parts.join(" ");
  }

  // "Quais projetos estão bloqueados?"
  if (/bloquead/i.test(t)) {
    const blocked = db.prepare(
      `SELECT DISTINCT p.name AS pname FROM projects p
       JOIN initiatives i ON i.project = REPLACE(p.id,'project.','')
       JOIN initiative_tasks t ON t.initiative_id = i.id AND t.status='BLOCKED'`
    ).all() as Array<{pname:string}>;
    return blocked.length
      ? `Projetos com tarefas bloqueadas: ${blocked.map((b)=>b.pname).join(", ")}.`
      : "Nenhum projeto com tarefas bloqueadas agora.";
  }

  // "Quem está trabalhando?"
  if (/quem\s+(est[áa]\s+)?(trabalhando|ocupado|executando)/i.test(t)) {
    const rows = db.prepare("SELECT agent_id,title FROM initiative_tasks WHERE status='RUNNING' ORDER BY id").all() as Array<{agent_id:string;title:string}>;
    return rows.length ? rows.map((r)=>`${r.agent_id} → "${r.title}"`).join(" | ") : "Ninguém executando neste momento.";
  }

  // "Quais agentes estão disponíveis?"
  if (/dispon[íi]ve/i.test(t)) {
    const rows = db.prepare(
      `SELECT a.id,a.name FROM agents a
       WHERE a.status IN ('IDLE','AVAILABLE')
         AND NOT EXISTS (SELECT 1 FROM initiative_tasks t WHERE t.assigned_agent=a.id AND t.status IN ('RUNNING','ASSIGNED'))
       ORDER BY a.id`
    ).all() as Array<{id:string;name:string}>;
    return rows.length ? `Disponíveis: ${rows.map((r)=>`${r.name} (${r.id})`).join(", ")}.` : "Nenhum agente livre agora.";
  }

  // "O que foi concluído hoje?"
  if (/conclu[íi]d|entregue hoje|feito hoje/i.test(t)) {
    const rows = db.prepare(
      `SELECT title,assigned_agent FROM initiative_tasks
       WHERE status='COMPLETED' AND completed_at >= date('now') ORDER BY completed_at DESC LIMIT 10`
    ).all() as Array<{title:string;assigned_agent:string|null}>;
    return rows.length ? `Concluído hoje (${rows.length}): ${rows.map((r)=>`"${r.title}"${r.assigned_agent?` por ${r.assigned_agent}`:""}`).join("; ")}.` : "Nada concluído ainda hoje.";
  }

  // "Qual é a próxima ação?"
  if (/pr[oó]xim(a|o)\s+a[çc]/i.test(t)) {
    const row = db.prepare(
      `SELECT title, assigned_agent FROM initiative_tasks
       WHERE status='READY' ORDER BY CASE WHEN priority IS NULL THEN 1 ELSE 0 END, priority DESC, ordinal LIMIT 1`
    ).get() as {title:string;assigned_agent:string|null}|undefined;
    if (!row) return "Fila vazia — nenhuma ação pronta para execução.";
    return `Próxima ação: "${row.title}"${row.assigned_agent?` (agente: ${row.assigned_agent})`:""}.`;
  }

  // "Como está o projeto X?" / "O que aconteceu com o Clipcom?"
  const projMatch = t.match(/(?:aconteceu com o|aconteceu com a|etapa d[oe]|estado d[oe]|andamento d[oe]|sobre o|sobre a)\s+([a-z0-9\- ]{3,40})/i)
    ?? t.match(/(?:clipcom|vyntra|nutriva|consecom|prospector)/i);
  if (projMatch) {
    const raw = (projMatch[1]?.trim() ?? projMatch[0]).split(" ").slice(-1)[0];
    const row = db.prepare(
      `SELECT p.name AS pname, t.title, t.status, t.assigned_agent FROM projects p
       JOIN initiatives i ON i.project = REPLACE(p.id,'project.','')
       JOIN initiative_tasks t ON t.initiative_id = i.id
       WHERE LOWER(p.name) LIKE ? OR p.description LIKE ?
       ORDER BY t.updated_at DESC LIMIT 4`
    ).all(`%${raw}%`, `%${raw}%`) as Array<{pname:string;title:string;status:string;assigned_agent:string|null}>;
    if (row.length) {
      const done = row.filter((r)=>r.status==="COMPLETED").length;
      const parts = [`Projeto ${row[0]!.pname}: ${done}/${row.length} atividades recentes concluídas.`];
      for (const r of row) parts.push(`"${r.title}" (${r.status}${r.assigned_agent?`, ${r.assigned_agent}`:""})`);
      return parts.join(" ");
    }
    // Projeto registrado mas sem tarefas ainda — resposta honesta com o estado real
    const projRow = db.prepare("SELECT name,status FROM projects WHERE LOWER(name) LIKE ? OR id LIKE ? LIMIT 1")
      .get(`%${raw}%`, `%${raw}%`) as {name:string;status:string}|undefined;
    if (projRow) {
      return `Projeto "${projRow.name}" está registrado (status: ${projRow.status}) e ainda não possui tarefas criadas. Quer que eu monte um plano para ele?`;
    }
  }

  return null;
}

function fallbackResponse(config: BrainConfig, text: string, s: ManagerSession): ManagerResponse {
  const t = text.trim().toLowerCase().replace(/[.!?]+$/,'');
  const db = new DatabaseSync(config.dbPath);

  // Anti-loop: if this exact message was the last one, and we're about to repeat, change behavior
  const lastManagerMsg = s.history.filter(h => h.role === 'manager').slice(-1)[0]?.text ?? '';

  try {
    // ── STATUS OPERACIONAL (dados reais do sistema, determinístico) ──
    const statusAnswer = answerOperationalStatus(db, t);
    if (statusAnswer) return resp(s, statusAnswer);
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
    if (/^(continue|retomar|resume)$/i.test(t)) {
      const paused = db.prepare("SELECT COUNT(*) AS n FROM agent_runs WHERE kill_switch=1 AND state='PAUSED'").get() as { n: number };
      if (paused.n > 0) return doResume(config, s);
      // Nothing paused: fall through to generic conversation instead of a hollow resume.
    }

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

function respPersist(config: BrainConfig, sessionKey: string, s: ManagerSession, message: string): ManagerResponse {
  s.history.push({ role:'manager', text:message });
  persistMessage(config, sessionKey, 'manager', message, s.mode, s.topic, s.lastBrainResult);
  return { type:'conversation', mode:s.mode, message, intent:'CHAT', actions:[], requiresConfirmation:false };
}

/* ── MAIN ENTRY ── */

export async function managerChat(config: BrainConfig, text: string, sessionKey = 'default'): Promise<ManagerResponse> {
  const trimmed = text.trim();
  if (!trimmed) return { type:'conversation', mode:'plane', message:'Digite algo.', intent:'CHAT', actions:[], requiresConfirmation:false };

  const s = getSession(sessionKey, config);
  s.history.push({ role:'user', text:trimmed });
  if (s.history.length > 100) s.history.shift();
  persistMessage(config, sessionKey, 'user', trimmed, s.mode, s.topic, s.lastBrainResult);
  const t = trimmed.toLowerCase().replace(/[.!?]+$/,'');

  // ── 1. EXPLICIT COMMANDS (always deterministic, never LLM) ──
  if (/^(pare tudo|para tudo|kill switch|stop everything)$/i.test(t)) return doStop(config, s);
  if (/^(continue|retomar|resume)$/i.test(t)) {
    const cdb = new DatabaseSync(config.dbPath);
    try {
      const paused = cdb.prepare("SELECT COUNT(*) AS n FROM agent_runs WHERE kill_switch=1 AND state='PAUSED'").get() as { n: number };
      if (paused.n > 0) return doResume(config, s);
    } finally { cdb.close(); }
    // Nothing paused: treat as conversational continuation instead of a command.
  }
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

  // ── 3.5 CREATIVE/PROJECT REQUESTS ──
  // Latest intent wins: overwrite any stale pending plan.
  const wantsVideo = /\b(v[íi]deo|videos|anima[çc][ãa]o|anime)\b/i.test(t) || /\b(gerar?|crie|criar?)\s+(um\s+)?v[íi]deo\b/i.test(t);
  const wantsImage = !wantsVideo && /\b(logo|imagem|banner|arte|ilustra[çc][ãa]o|criativo|thumbnail|capa)\b/i.test(t) && /\b(gere|gerar|crie|criar|faz|fa[çc]a|fazer)\b/i.test(t);
  const wantsDev = !wantsVideo && !wantsImage && /\b(site|sites|sistema|sistemas|aplicativo|app|plataforma|dashboard|landing\s?page|webapp|e-?commerce|projeto)\b/i.test(t) && /\b(criar?|crie|desenvolver|desenvolve|fazer|faz|iniciar|inicia|construir|montar|come[çc]ar)\b/i.test(t);
  if ((wantsImage || wantsVideo || wantsDev) && !/^Gerar (imagem|v[íi]deo):|^Registrar projeto no Drive:/i.test(s.pending?.tasks[0] ?? '')) {
    return doPropose(trimmed, s);
  }

  // ── 3.6 OPERATIONAL STATUS — deterministic, before any LLM call ──
  const statusAnswer = tryAnswerStatus(config, t);
  if (statusAnswer) return resp(s, statusAnswer);

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

    if (isProposal) {
      // Always update topic when a NEW plan is proposed (not just first time)
      const newTopic = extractTopic(trimmed) ?? extractTopic(llmResponse);
      if (newTopic) s.topic = newTopic;
      // Store the LLM's response so executeRealPlan can extract actual tasks from it
      s.lastBrainResult = cleanResponse;
    }
    persistMessage(config, sessionKey, 'manager', cleanResponse, s.mode, s.topic, s.lastBrainResult);

    return { type:isProposal ? 'plan' : 'conversation', mode:s.mode, message:cleanResponse, intent:'CHAT',
      actions:isProposal ? [{type:'create_goal',status:'proposed'}] : [],
      requiresConfirmation:isProposal };
  }

  // ── 5. Deterministic fallback (no LLM configured) ──
  const intent = classifyFallback(trimmed, s);
  let fallbackResult: ManagerResponse;
  switch (intent) {
    case 'STOP': fallbackResult = doStop(config, s); break;
    case 'RESUME': {
      const cdb = new DatabaseSync(config.dbPath);
      try {
        const paused = cdb.prepare("SELECT COUNT(*) AS n FROM agent_runs WHERE kill_switch=1 AND state='PAUSED'").get() as { n: number };
        fallbackResult = paused.n > 0 ? doResume(config, s) : fallbackResponse(config, trimmed, s);
      } finally { cdb.close(); }
      break;
    }
    case 'MODE_SWITCH': { s.mode = trimmed.toLowerCase().replace(/[.!?]+$/,'') as ManagerMode; fallbackResult = resp(s, `Modo ${s.mode} ativo.`); break; }
    case 'EXECUTION_CONFIRM': fallbackResult = doExecute(config, s); break;
    case 'GOAL_CREATION': fallbackResult = doPropose(trimmed, s); break;
    default: fallbackResult = fallbackResponse(config, trimmed, s); break;
  }
  persistMessage(config, sessionKey, 'manager', fallbackResult.message, s.mode, s.topic, s.lastBrainResult);
  return fallbackResult;
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

    // Extract tasks from the LAST LLM response (the one with [PROPOSTA])
    // NOT from the entire conversation history
    const lastProposal = s.lastBrainResult ?? '';
    const taskTitles: string[] = [];

    // Match numbered items: "1. Task", "1) Task", "- Task", "• Task"
    const lines = lastProposal.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      // Skip headers, empty lines, and non-task lines
      if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('---')) continue;
      // Match numbered: "1. Something" or "1) Something"
      const numbered = trimmed.match(/^\d+[\.\)]\s+(.+)/);
      if (numbered?.[1]) {
        const clean = numbered[1].replace(/\*\*/g,'').trim();
        if (clean.length > 5 && clean.length < 120 && !/confirm|validar com você|registr/i.test(clean)) taskTitles.push(clean);
        continue;
      }
      // Match bullet: "- Something" or "• Something"
      const bulleted = trimmed.match(/^[-•]\s+(.+)/);
      if (bulleted?.[1]) {
        const clean = bulleted[1].replace(/\*\*/g,'').trim();
        if (clean.length > 5 && clean.length < 120 && !/confirm|validar com você|registr/i.test(clean)) taskTitles.push(clean);
      }
    }

    const finalTasks = taskTitles.length > 0 ? taskTitles.slice(0, 10) : [
      `Analisar escopo de ${topic}`,
      `Implementar núcleo de ${topic}`,
      `Testar e validar ${topic}`,
      `Documentar e finalizar ${topic}`,
    ];

    // Design intent: route to Designer agent with a single creative task
    const userMsgs = s.history.filter(h => h.role === 'user');
    const videoMsg = [...userMsgs].reverse().find(h => /\b(v[íi]deo|videos|anima[çc][ãa]o)\b/i.test(h.text));
    const imageMsg = !videoMsg && [...userMsgs].reverse().find(h => /\b(logo|imagem|banner|arte|ilustra[çc][ãa]o|criativo|thumbnail|capa)\b/i.test(h.text));
    const creativeMsg = videoMsg ?? imageMsg;
    const isImageRequest = Boolean(creativeMsg) || /^Gerar (imagem|v[íi]deo):/i.test(finalTasks[0] ?? '');
    let assignedAgent = 'engineering-agent';
    if (isImageRequest && creativeMsg) {
      const wantsVideo = Boolean(videoMsg);
      const imagePrompt = creativeMsg.text
        .replace(/^\s*designer\s*,?\s*/i, '')
        .replace(/^(por\s+favor\s*)?(pode\s+)?(gere|gerar|crie|criar|faz|fa[çc]a|fazer)\s+(um\s+|uma\s+)?/i, '')
        .trim() || topic;
      finalTasks.length = 0;
      finalTasks.push(`${wantsVideo ? 'Gerar vídeo' : 'Gerar imagem'}: ${imagePrompt}`);
      assignedAgent = 'designer-agent';
    }
    if (assignedAgent === 'designer-agent' && !db.prepare("SELECT id FROM agents WHERE id='designer-agent'").get())
      db.prepare("INSERT INTO agents (id,name,description,domains,capabilities,permissions,status) VALUES ('designer-agent','Designer','Criativos e imagens','[\"MARKETING\"]','[\"image_generation\"]','[\"context\",\"image_generate\",\"drive_upload\"]','AVAILABLE')").run();

    const init = createInitiative(db, { title:`${topic}: plano de execução`, description:'Plano criado via conversa com o Gerente.', goalId:goal.id, project:topic.toLowerCase().includes('nutriva')?'nutriva':undefined, status:'PROPOSED' });
    planInitiative(db, init.id, finalTasks);
    const ready = refreshQueue(db, init.id);
    if (ready[0]!==undefined) assignTask(db, ready[0], { agentId:assignedAgent, reason:'Manager delegou primeira task do plano conversacional' });
    persistInitiativeKnowledge(config, goal, init, finalTasks);

    // Reset LLM plan state
    s.llmProposedPlan = false;
    s.lastBrainResult = null;

    // Auto-execute the dispatched task (skip under tests)
    if (!process.env.VITEST && ready[0] !== undefined) {
      void runInitiativeParallel(config, init.id).catch(() => {});
    }

    const agentLabel = assignedAgent === 'designer-agent' ? 'Designer Agent' : 'Engineering Agent';
    return { type:'execution', mode:s.mode,
      message:`Plano executado. Criei o objetivo "${goalName}" com ${finalTasks.length} tarefa(s):\n${finalTasks.map((t,i)=>`${i+1}. ${t}`).join('\n')}\n\nA primeira tarefa foi dispatchada para o ${agentLabel}. Acompanhe o progresso no escritório.`,
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
  if (/\b(v[íi]deo|videos|anima[çc][ãa]o)\b/i.test(t)) return 'GOAL_CREATION';
  if (/\b(site|sites|sistema|sistemas|aplicativo|app|plataforma|dashboard|landing\s?page|webapp|e-?commerce|projeto)\b/i.test(t) && /\b(criar?|crie|desenvolver|desenvolve|fazer|faz|iniciar|inicia|construir|montar|come[çc]ar)\b/i.test(t)) return 'GOAL_CREATION';
  if (/\b(logo|imagem|banner|arte|ilustra[çc][ãa]o|criativo|thumbnail|capa)\b/i.test(t) && /ger|cri|fa[çc]|faz/i.test(t)) return 'GOAL_CREATION';
  if (/(quero|precisamos|preciso)\s+(de\s+)?(faturar|alcançar|vender|criar)\s+/i.test(t) || /r\$\s*[\d.,]+/i.test(t)) return 'GOAL_CREATION';
  return 'CHAT';
}

function extractPlan(text: string): PendingPlan {
  const t = text.trim();
  const tm = t.match(/r\$\s*([\d.,]+)/i);
  const target = tm?.[1] ? Number(tm[1].replace(/\./g,'').replace(',','.')) : undefined;
  const isCommercial = /r\$|venda|vendas|faturar|receita|lead|prospec/i.test(t);
  const isNutriva = /nutriva/i.test(t);
  const wantsVideo = /\b(v[íi]deo|videos|anima[çc][ãa]o)\b/i.test(t);
  const isImage = !wantsVideo && /\b(logo|imagem|banner|arte|ilustra[çc][ãa]o|criativo|thumbnail|capa)\b/i.test(t);
  const wantsDev = !wantsVideo && !isImage && /\b(site|sites|sistema|sistemas|aplicativo|aplicativo|app|plataforma|dashboard|landing\s?page|webapp|e-?commerce|projeto)\b/i.test(t) && /\b(criar?|crie|desenvolver|desenvolve|fazer|faz|iniciar|inicia|construir|montar|começar|comeca)\b/i.test(t);
  let name = t.replace(/^(quero|precisamos|preciso|vamos)\s+(de\s+|a\s+)?/i,'').replace(/^(faturar|alcançar|atingir|criar)\s+/i,'').replace(/\s+até\s+.*$/i,'').replace(/\s+este\s+mês.*$/i,'').trim();
  if (wantsDev) {
    const projectName = name
      .replace(/^(por\s+favor\s*)?(pode\s+)?/i,'')
      .replace(/^(criar|crie|desenvolver|desenvolve|fazer|faz|iniciar|inicia|construir|montar|come[çc]ar)\s+(um|uma|o|a|novo|nova)?\s*/i,'')
      .replace(/^(projeto|projetos)\s+(de\s+)?/i,'')
      .trim() || 'Novo projeto';
    return { goalName:`Projeto: ${projectName}`, goalType:'PROJECT', target, tasks:[`Registrar projeto no Drive: ${projectName}`], project:isNutriva?'nutriva':undefined };
  }
  if (wantsVideo || isImage) {
    const prefix = wantsVideo ? 'Gerar vídeo' : 'Gerar imagem';
    const prompt = name.replace(/^\s*designer\s*,?\s*/i,'').replace(/^(por\s+favor\s*)?(pode\s+)?(gere|gerar|crie|criar|faz|fa[çc]a|fazer)\s+(um\s+|uma\s+)?(logo\s+|imagem\s+|v[íi]deo\s+|anima[çc][ãa]o\s+)?/i,'').trim() || 'criativo solicitado';
    return { goalName:`${wantsVideo?'Vídeo':'Imagem'}: ${prompt}`, goalType:'PROJECT', target, tasks:[`${prefix}: ${prompt}`], project:isNutriva?'nutriva':undefined };
  }
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
    const isDesignPlan = /^Gerar (imagem|v[íi]deo):/i.test(plan.tasks[0] ?? '');
    const isProjectRecord = /^Registrar projeto no Drive:/i.test(plan.tasks[0] ?? '');
    if (isDesignPlan && !db.prepare("SELECT id FROM agents WHERE id='designer-agent'").get())
      db.prepare("INSERT INTO agents (id,name,description,domains,capabilities,permissions,status) VALUES ('designer-agent','Designer','Criativos e imagens','[\"MARKETING\"]','[\"image_generation\"]','[\"context\",\"image_generate\",\"drive_upload\"]','AVAILABLE')").run();
    if (isProjectRecord && !db.prepare("SELECT id FROM agents WHERE id='engineering-agent'").get())
      db.prepare("INSERT INTO agents (id,name,description,domains,capabilities,permissions,status) VALUES ('engineering-agent','Engenharia','Projetos e sistemas','[\"DESENVOLVIMENTO\"]','[\"execute\"]','[\"context\",\"execute\",\"drive_upload\"]','AVAILABLE')").run();
    if (ready[0]!==undefined) assignTask(db, ready[0], { agentId:isDesignPlan?'designer-agent':isProjectRecord?'engineering-agent':'manager', reason:'Manager delegou primeira task' });
    persistInitiativeKnowledge(config, goal, init, plan.tasks);
    if (!process.env.VITEST && ready[0] !== undefined) {
      void runInitiativeParallel(config, init.id).catch(() => {});
    }
    s.pending = null; s.lastPlanSummary = plan.goalName;
    const agentLabel = isDesignPlan ? 'Designer Agent' : isProjectRecord ? 'Engineering Agent' : 'agente responsável';
    return { type:'execution', mode:s.mode, message:`Objetivo "${plan.goalName}" criado com ${plan.tasks.length} tarefa(s). Primeira task dispatchada para o ${agentLabel}. Tudo registrado no Obsidian.`, intent:'GOAL_CREATION', actions:[{type:'create_goal',status:'executed',detail:goal.id},{type:'create_initiative',status:'executed',detail:init.id}], requiresConfirmation:false };
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
