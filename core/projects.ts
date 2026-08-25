/**
 * Projects as first-class operational units.
 * The Manager queries these to know what exists, its state and who is on it.
 */
import { DatabaseSync } from "node:sqlite";

export interface ProjectRecord {
  id: string;
  name: string;
  description: string;
  repository: string | null;
  repository_url: string | null;
  workspace: string | null;
  status: string;
  priority: string;
  owner_agent: string;
  assigned_agents: string;
}

export function createProject(db: DatabaseSync, input: { id?: string; name: string; description?: string; workspace?: string; repositoryUrl?: string; status?: string; priority?: string; }): ProjectRecord {
  const slug = input.name.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const id = input.id ?? `project.${slug}`;
  db.prepare(
    `INSERT INTO projects (id, name, description, repository_url, workspace, status, priority)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       description = excluded.description,
       status = excluded.status,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`
  ).run(id, input.name, input.description ?? "", input.repositoryUrl ?? null, input.workspace ?? null, input.status ?? "planned", input.priority ?? "normal");
  return getProject(db, id)!;
}

export function getProject(db: DatabaseSync, id: string): ProjectRecord | undefined {
  return db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as ProjectRecord | undefined;
}

export function findProjectByName(db: DatabaseSync, text: string): ProjectRecord | undefined {
  const t = `%${text.toLowerCase()}%`;
  return db.prepare(
    `SELECT * FROM projects WHERE LOWER(name) LIKE ? OR LOWER(description) LIKE ? OR id LIKE ?
     ORDER BY CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END LIMIT 1`
  ).get(t, t, t) as ProjectRecord | undefined;
}

export function listProjects(db: DatabaseSync): Array<ProjectRecord & { open_tasks: number; blocked_tasks: number }> {
  return db.prepare(
    `SELECT p.*,
       (SELECT COUNT(*) FROM initiatives i JOIN initiative_tasks t ON t.initiative_id = i.id
          WHERE i.project = REPLACE(p.id, 'project.', '') AND t.status NOT IN ('COMPLETED','CANCELLED')) AS open_tasks,
       (SELECT COUNT(*) FROM initiatives i JOIN initiative_tasks t ON t.initiative_id = i.id
          WHERE i.project = REPLACE(p.id, 'project.', '') AND t.status = 'BLOCKED') AS blocked_tasks
     FROM projects p
     ORDER BY CASE p.priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, p.name`
  ).all() as never[];
}

export function setProjectStatus(db: DatabaseSync, id: string, status: string): void {
  db.prepare("UPDATE projects SET status=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?").run(status, id);
}
