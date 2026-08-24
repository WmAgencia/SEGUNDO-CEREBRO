import { DatabaseSync } from "node:sqlite";
import { mkdirSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";
import type { BrainConfig } from "../config/loader.ts";

const VAULT_FOLDERS = [
  "00 - Core",
  "01 - Life",
  "02 - Consecom",
  "02 - Consecom/Clients",
  "02 - Consecom/Offers",
  "03 - Projects",
  "04 - People",
  "05 - Conversations/Personal",
  "05 - Conversations/Friend",
  "05 - Conversations/Commercial",
  "06 - Knowledge",
  "07 - Decisions",
  "08 - Goals",
  "09 - Agents",
  "10 - Skills",
  "11 - Tools",
  "14 - Learnings",
  "15 - Opportunities",
  "99 - System",
];

function fm(fields: Record<string, unknown>): string {
  const lines = Object.entries(fields).map(([k, v]) => {
    if (Array.isArray(v)) return `${k}:\n${v.map((x) => `  - "${x}"`).join("\n")}`;
    if (typeof v === "string") return `${k}: "${v.replace(/"/g, '\\"')}"`;
    return `${k}: ${v}`;
  });
  return `---\n${lines}\n---\n`;
}

export function buildKnowledgeLayer(config: BrainConfig): {
  foldersCreated: string[];
  notesCreated: number;
  notesUpdated: number;
} {
  const vault = config.vaultPath;
  const result = { foldersCreated: [] as string[], notesCreated: 0, notesUpdated: 0 };

  // 1. Create folder structure
  for (const folder of VAULT_FOLDERS) {
    const full = path.join(vault, folder);
    if (!existsSync(full)) {
      mkdirSync(full, { recursive: true });
      result.foldersCreated.push(folder);
    }
  }

  const db = new DatabaseSync(config.dbPath);

  // 2. Core identity note
  const coreDir = path.join(vault, "00 - Core");
  const identityContent = [
    fm({ type: "identity", owner: "Wesley / Ju", privacy: "personal", updated: new Date().toISOString().slice(0,10) }),
    "# Wesley / Ju",
    "",
    "## Localização",
    "Sorocaba, São Paulo, Brasil.",
    "",
    "## Empresa",
    "[[CONSECOM]] — agência de negócios digitais.",
    "",
    "## Característica central",
    "PROBLEMA → SOLUÇÃO → SISTEMA → AUTOMAÇÃO → PRODUTO → VENDA",
    "",
    "## Objetivo principal",
    "GERAR CAIXA RAPIDAMENTE através de sites, sistemas, automações e marketing.",
    "",
    "## Canais",
    "- **Operacional:** [[SECOM]] (grupo WhatsApp)",
    "- **Owner:** 15981817336 (apenas identificador)",
  ].join("\n");
  writeNote(path.join(coreDir, "Identity.md"), identityContent, result);

  // 3. CONSECOM company note
  const consecomDir = path.join(vault, "02 - Consecom");
  const companyContent = [
    fm({ type: "company", entity_id: "company.consecom", privacy: "commercial", tags: ["consecom", "agencia"] }),
    "# CONSECOM",
    "",
    "Agência de negócios digitais em Sorocaba/SP.",
    "",
    "## Modelo de negócio",
    "SERVIÇOS → CAIXA → REINVESTIMENTO → PRODUTOS → AUTOMAÇÃO → ESCALA",
    "",
    "## Ofertas principais",
    "- Sites profissionais",
    "- Landing pages",
    "- Sistemas personalizados",
    "- Automações",
    "- Marketing e tráfego",
    "",
    "## Projetos",
    "- [[Vyntra]] — Sales Operating System",
    "- [[Samira Revela]] — Site profissional",
    "- [[Talita Barreto]] — Solução para psicólogos",
    "- [[ClipCon]] — Edição de vídeos",
    "",
    "## Campanha",
    "**Reage, Psicólogo!** — R$349,90 site para psicólogos",
  ].join("\n");
  writeNote(path.join(consecomDir, "Company.md"), companyContent, result);

  // 4. Person notes from wa_contacts
  const contacts = db.prepare(
    "SELECT id, external_id, name, metadata FROM wa_contacts ORDER BY id"
  ).all() as unknown as Array<{ id: number; external_id: string; name: string | null; metadata: string }>;

  for (const contact of contacts) {
    let meta: Record<string, unknown> = {};
    try { meta = JSON.parse(contact.metadata ?? "{}"); } catch {}
    const scope = String(meta.contextScope ?? "COMMERCIAL").toUpperCase();
    const name = contact.name ?? contact.external_id;

    // Determine which folder based on scope
    const personFolder = scope === "PERSONAL"
      ? path.join(vault, "05 - Conversations", "Personal")
      : scope === "FRIEND"
        ? path.join(vault, "05 - Conversations", "Friend")
        : path.join(vault, "04 - People");

    const noteFile = path.join(personFolder.replace(/^.*?Conversations/, path.join(vault, "05 - Conversations")), `${sanitize(name)}.md`);

    // Count messages
    const msgCount = Number(
      (db.prepare("SELECT COUNT(*) AS c FROM memories WHERE source_id LIKE ?").get(`%${contact.external_id}%`) as { c: number }).c,
    );

    const content = [
      fm({
        type: "person",
        entity_id: `person.${contact.external_id}`,
        privacy_scope: scope,
        source: "whatsapp",
        messages_count: msgCount,
        updated: new Date().toISOString().slice(0, 10),
      }),
      `# ${name}`,
      ``,
      `## Identificação`,
      `- **Telefone/ID:** ${contact.external_id}`,
      `- **Contexto:** ${scope}`,
      `- **Mensagens indexadas:** ${msgCount}`,
      ``,
      `## Relaciona-se com`,
      `- [[CONSECOM]]`,
      `- [[Vyntra]]`,
    ].join("\n");
    writeNote(noteFile, content, result);
  }

  // 5. Conversation summaries per source
  const sources = db.prepare(
    "SELECT id, location FROM sources WHERE source_type = 'whatsapp_export'"
  ).all() as unknown as Array<{ id: string; location: string }>;

  for (const src of sources) {
    const shortId = src.id.replace("src.", "");
    const scope = shortId.includes("ana") ? "PERSONAL" : shortId.includes("derek") ? "FRIEND" : "COMMERCIAL";
    const personName = shortId.includes("ana") ? "Ana" : shortId.includes("derek") ? "Derek" :
      shortId.includes("samira-b") ? "Samira B" : shortId.includes("samira-a") ? "Samira A" : shortId;

    const convFolder = path.join(
      vault,
      "05 - Conversations",
      scope === "PERSONAL" ? "Personal" : scope === "FRIEND" ? "Friends" : "Commercial",
      personName
    );
    mkdirSync(convFolder, { recursive: true });

    const count = Number(
      (db.prepare("SELECT COUNT(*) AS c FROM memories WHERE source_id = ?").get(`src.${shortId}`) as { c: number }).c,
    );

    // Conversation summary note
    const convFile = path.join(convFolder, "conversation.md");
    const convContent = [
      fm({
        type: "conversation",
        person: personName,
        privacy_scope: scope,
        source: `src.${shortId}`,
        messages_count: count,
        imported_at: new Date().toISOString().slice(0, 10),
      }),
      `# Conversa com ${personName}`,
      ``,
      `## Metadata`,
      `- **Escopo:** ${scope}`,
      `- **Mensagens:** ${count}`,
      `- **Arquivo original:** ${src.location}`,
      ``,
      `## Conteúdo`,
      `Ver banco de dados para mensagens detalhadas.`,
      `FTS indexado para busca por palavras-chave.`,
    ].join("\n");
    writeNote(convFile, convContent, result);

    // Extracted knowledge note
    const knowledgeFile = path.join(convFolder, "extracted-knowledge.md");
    const knowledgeContent = [
      fm({ type: "knowledge", person: personName, privacy_scope: scope }),
      `# Conhecimento extraído — ${personName}`,
      ``,
      `Ver [[${personName} — conversation]] para contexto original.`,
      ``,
      `Memórias armazenadas no Memory Engine.`,
    ].join("\n");
    writeNote(knowledgeFile, knowledgeContent, result);
  }

  db.close();
  return result;
}

function writeNote(filePath: string, content: string, result: { notesCreated: number; notesUpdated: number }): void {
  try {
    if (existsSync(filePath)) result.notesUpdated++;
    else result.notesCreated++;
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, content, "utf8");
  } catch {}
}

function sanitize(name: string): string {
  return name.replace(/[<>:"/\\|?*]/g, "").trim() || "unnamed";
}
