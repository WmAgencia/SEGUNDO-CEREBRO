import { DatabaseSync } from "node:sqlite";

export interface HqNotification {
  id: number;
  type: 'task_completed'|'task_failed'|'approval_required'|'goal_completed'|'manager_message'|'info';
  title: string;
  body: string;
  agentId: string|null;
  taskId: number|null;
  goalId: string|null;
  requiresAction: boolean;
  actionType: 'approve_reject'|null;
  actionPayload: Record<string, unknown>;
  read: boolean;
  createdAt: string;
}

export function createNotification(db: DatabaseSync, input: {
  type: HqNotification['type'];
  title: string;
  body?: string;
  agentId?: string;
  taskId?: number;
  goalId?: string;
  requiresAction?: boolean;
  actionType?: 'approve_reject';
  actionPayload?: Record<string, unknown>;
}): number {
  const result = db.prepare(
    `INSERT INTO hq_notifications (type,title,body,agent_id,task_id,goal_id,requires_action,action_type,action_payload)
     VALUES (?,?,?,?,?,?,?,?,?)`
  ).run(
    input.type, input.title, input.body ?? '', input.agentId ?? null,
    input.taskId ?? null, input.goalId ?? null,
    input.requiresAction ? 1 : 0, input.actionType ?? null,
    JSON.stringify(input.actionPayload ?? {})
  );
  return Number(result.lastInsertRowid);
}

export function listNotifications(db: DatabaseSync, unreadOnly = false): HqNotification[] {
  const sql = unreadOnly
    ? "SELECT * FROM hq_notifications WHERE read=0 ORDER BY id DESC LIMIT 50"
    : "SELECT * FROM hq_notifications ORDER BY id DESC LIMIT 50";
  const rows = db.prepare(sql).all() as unknown as Array<Record<string, unknown>>;
  return rows.map(r => ({
    id: Number(r.id), type: r.type as HqNotification['type'],
    title: String(r.title), body: String(r.body ?? ''),
    agentId: r.agent_id ? String(r.agent_id) : null,
    taskId: r.task_id ? Number(r.task_id) : null,
    goalId: r.goal_id ? String(r.goal_id) : null,
    requiresAction: Number(r.requires_action) === 1,
    actionType: r.action_type as 'approve_reject'|null,
    actionPayload: JSON.parse(String(r.action_payload ?? '{}')),
    read: Number(r.read) === 1,
    createdAt: String(r.created_at),
  }));
}

export function unreadCount(db: DatabaseSync): number {
  return Number((db.prepare("SELECT COUNT(*) AS n FROM hq_notifications WHERE read=0").get() as {n:number}).n);
}

export function markRead(db: DatabaseSync, id: number): void {
  db.prepare("UPDATE hq_notifications SET read=1, read_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?").run(id);
}

export function markAllRead(db: DatabaseSync): void {
  db.prepare("UPDATE hq_notifications SET read=1, read_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE read=0").run();
}
