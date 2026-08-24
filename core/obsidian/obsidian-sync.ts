import { DatabaseSync } from "node:sqlite";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import type { BrainConfig } from "../config/loader.ts";

export interface SyncResult {
  foldersCreated: string[];
  notesCreated: number;
  notesUpdated: number;
  skipped: number;
}

function frontmatter(fields: Record<string, unknown>): string {
  const lines = Object.entries(fields)
    .map(([k, v]) => {
      if (Array.isArray(v)) return `${k}:\n${v.map((x) => `  - "${x}"`).join("\n")}`;
      if (typeof v === "string") return `${k}: "${v.replace(/"/g, '\\"')}"`;
      return `${k}: ${v}`;
    })
    .join("\n");
  return `---\n${lines}\n---\n`;
}

export function syncToObsidian(
  config: BrainConfig,
  vaultPath?: string,
): SyncResult {
  const vault = vaultPath ?? config.vaultPath;
  const result: SyncResult = { foldersCreated: [], notesCreated: 0, notesUpdated: 0, skipped: 0 };

  const FOLDERS = [
    "01 - ME", "02 - CONSECOM", "03 - PROJECTS", "04 - PEOPLE",
    "05 - CONVERSATIONS/PERSONAL", "05 - CONVERSATIONS/FRIEND",
    "05 - CONVERSATIONS/COMMERCIAL",
    "06 - KNOWLEDGE", "09 - DECISIONS", "10 - GOALS",
  ];
  for (const folder of FOLDERS) {
    const full = path.join(vault, folder);
    if (!existsSync(full)) {
      mkdirSync(full, { recursive: true });
      result.foldersCreated.push(folder);
    }
  }

  const db = new DatabaseSync(config.dbPath);

  // 1. People notes
  const contacts = db.prepare(
    "SELECT id, external_id, name, metadata FROM wa_contacts ORDER BY id"
  ).all() as unknown as Array<{ id: number; external_id: string; name: string | null; metadata: string }>;

  for (const contact of contacts) {
    const meta = safeJson(contact.metadata);
    const scope = String(meta.contextScope ?? "COMMERCIAL").toUpperCase();
    const name = contact.name ?? contact.external_id;
    const noteFolder = path.join(vault, "04 - PEOPLE");
    const noteFile = path.join(noteFolder, `${sanitize(name)}.md`);
    const content = [
      frontmatter({
        type: "person",
        entity_id: `person.${contact.external_id}`,
        privacy_scope: scope,
        source: "whatsapp",
        created_at: new Date().toISOString(),
      }),
      `# ${name}`,
      ``,
      `## Identificação`,
      `- **Telefone:** ${contact.external_id}`,
      `- **Contexto:** ${scope}`,
      ``,
      `## Relaciona-se com`,
      `- [[CONSECOM]]`,
      `- [[Vyntra]]`,
      ``,
    ].join("\n");
    writeNote(noteFile, content, result);
  }

  // 2. Project notes from entities type=project
  const projects = db.prepare(
    `SELECT e.id, e.canonical_name, e.status FROM entities e WHERE e.type = 'project'`
  ).all() as unknown as Array<Record<string, unknown>>;

  for (const proj of projects) {
    const name = String(proj.canonical_name ?? proj.id);
    const noteFolder = path.join(vault, "03 - PROJECTS");
    const noteFile = path.join(noteFolder, `${sanitize(name)}.md`);
    const content = [
      frontmatter({
        type: "project",
        entity_id: String(proj.id),
        status: String(proj.status ?? "unknown"),
        privacy_scope: "BUSINESS",
        created_at: new Date().toISOString(),
      }),
      `# ${name}`,
      ``,
      `## Status`,
      `${proj.status ?? "unknown"}`,
      ``,
      `## Relaciona-se com`,
      `- [[CONSECOM]]`,
      ``,
    ].join("\n");
    writeNote(noteFile, content, result);
  }
  void projects;

  // 3. Conversation summaries per source
  const sources = db.prepare(
    "SELECT id, location FROM sources WHERE source_type = 'whatsapp_export'"
  ).all() as unknown as Array<{ id: string; location: string }>;

  for (const src of sources) {
    const scope = src.id.includes("ana") ? "PERSONAL" : src.id.includes("derek") ? "FRIEND" : "COMMERCIAL";
    const personName = src.id.includes("ana") ? "Ana" : src.id.includes("derek") ? "Derek" : "Samira";
    const convFolder = path.join(vault, "05 - CONVERSATIONS", scope === "PERSONAL" ? "PERSONAL" : scope === "FRIEND" ? "FRIEND" : "COMMERCIAL", personName);
    mkdirSync(convFolder, { recursive: true });

    const count = Number(
      (db.prepare("SELECT COUNT(*) AS c FROM memories WHERE source_id = ?").get(`src.${src.id}`) as { c: number }).c,
    );

    const knowledgeFile = path.join(convFolder, "extracted-knowledge.md");
    const content = [
      frontmatter({
        type: "conversation_summary",
        person: personName,
        privacy_scope: scope,
        source: `src.${src.id}`,
        messages_count: count,
        imported_at: new Date().toISOString(),
      }),
      `# Conversa com ${personName}`,
      ``,
      `## Contexto`,
      `- **Escopo:** ${scope}`,
      `- **Mensagens:** ${count}`,
      `- **Fonte:** ${src.location}`,
      ``,
      `## Conhecimento extraído`,
      `Ver banco de dados para memórias detalhadas.`,
      ``,
      `## Links`,
      scope === "COMMERCIAL" ? `- [[CONSECOM]]` : "",
      scope === "COMMERCIAL" ? `- [[Vyntra]]` : "",
    ].filter(Boolean).join("\n");
    writeNote(knowledgeFile, content, result);
  }

  // 4. CONSECOM company note
  const consecomNote = path.join(vault, "02 - CONSECOM", "CONSECOM.md");
  const consecomContent = [
    frontmatter({
      type: "company",
      entity_id: "company.consecom",
      privacy_scope: "BUSINESS",
      created_at: new Date().toISOString(),
    }),
    `# CONSECOM`,
    ``,
    `Agência de negócios digitais baseada em Sorocaba/SP.`,
    ``,
    `## Atuação`,
    `- Sites e landing pages`,
    `- Sistemas personalizados`,
    `- Automações`,
    `- Marketing e tráfego pago`,
    `- Prospecção`,
    `- Soluções com IA`,
    `- SaaS`,
    ``,
    `## Projetos relacionados`,
    `- [[Vyntra]] — Sales Operating System`,
    `- [[Samira Revela]] — Site profissional`,
    `- [[Talita Barreto]] — Solução para psicólogos`,
    `- [[ClipCon]] — Edição automática de vídeos`,
    ``,
    `## Estratégia`,
    `SERVIÇOS → CAIXA → REINVESTIMENTO → PRODUTOS → AUTOMAÇÃO → ESCALA`,
  ].join("\n");
  writeNote(consecomNote, consecomContent, result);

  db.close();
  return result;
}

function sanitize(name: string): string {
  return name.replace(/[<>:"/\\|?*]/g, "").trim() || "unnamed";
}

function writeNote(filePath: string, content: string, result: SyncResult): void {
  try {
    if (existsSync(filePath)) {
      result.notesUpdated++;
    } else {
      result.notesCreated++;
    }
    const dir = path.dirname(filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(filePath, content, "utf8");
  } catch {
    result.skipped++;
  }
}

function safeJson(raw: string): Record<string, unknown> {
  try {
    const p = JSON.parse(raw);
    return p && typeof p === "object" && !Array.isArray(p) ? (p as Record<string, unknown>) : {};
  } catch { return {}; }
}
