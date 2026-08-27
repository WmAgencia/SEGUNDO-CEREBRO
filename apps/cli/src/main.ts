import { existsSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { watch as fsWatch } from "node:fs";
import { Command } from "commander";
import { bootstrapVaultStructure } from "../../../connectors/obsidian/vault-structure.ts";
import { loadConfig } from "../../../core/config/loader.ts";
import { BrainError, toBrainError } from "../../../core/errors/errors.ts";
import { createLogger, setLogLevel } from "../../../core/logger/logger.ts";
import { indexVault } from "../../../core/indexing/vault-indexer.ts";
import { searchDocuments } from "../../../core/retrieval/searcher.ts";
import { getEntity, getEntityStats } from "../../../core/entities/entity.ts";
import { resolveEntity } from "../../../core/entities/resolver.ts";
import { relatedEdges, traverseGraph } from "../../../core/relations/graph.ts";
import type { Direction } from "../../../core/relations/graph.ts";
import { buildTimeline } from "../../../core/retrieval/timeline.ts";
import { openDatabase } from "../../../storage/connection.ts";
import { buildContext } from "../../../core/context/context-builder.ts";
import { ask } from "../../../core/orchestrator/brain-orchestrator.ts";
import { LocalLlamaCppProvider } from "../../../core/ai/llamacpp-provider.ts";
import { extractMemoryProposals } from "../../../core/ai/memory-extractor.ts";
import { saveConfirmedMemory } from "../../../core/ai/save-memory.ts";
import { compilePersonalContext, isAna } from "../../../core/personal/personal-agent.ts";
import { ingestWhatsAppArchive } from "../../../core/ingest/whatsapp-ingest.ts";
import { getProjectIntelligence } from "../../../core/projects/project-intelligence.ts";
import {
  listCandidates,
  acceptObservation,
  rejectObservation,
} from "../../../core/learning/learning-loop.ts";
import { brainNextActions } from "../../../core/goals/proactive.ts";
import {
  listActiveGoalsByPriority,
  createGoal,
  getGoal,
  goalPriority,
  listGoals,
} from "../../../core/goals/goal-engine.ts";
import { formatProposal } from "../../../core/goals/initiatives.ts";
import {
  applySchema,
  getMetadata,
} from "../../../storage/connection.ts";
import { auditVault, auditExplanation } from "../../../core/organization/vault-audit.ts";
import type { BrainConfig } from "../../../core/config/loader.ts";
import { recoverStaleRuns } from "../../../core/orchestration/recovery.ts";

const log = createLogger("cli");

function loadConfigOrExit(): ReturnType<typeof loadConfig> {
  try {
    return loadConfig();
  } catch (err) {
    if (err instanceof BrainError) {
      process.stderr.write(`brain: ${err.message}\n`);
    } else {
      process.stderr.write(`brain: unexpected error: ${String(err)}\n`);
    }
    process.exit(1);
  }
}

const program = new Command();

program
  .name("brain")
  .description("Second Brain OS — memória e contexto local para agentes de IA")
  .version("0.1.0")
  .option("-v, --verbose", "log detalhado (debug)")
  .hook("preAction", (thisCommand) => {
    const opts = thisCommand.opts<{ verbose?: boolean }>();
    if (opts.verbose) setLogLevel("debug");
  });

program
  .command("init")
  .description("cria estrutura do vault, .brainignore e o banco de índice (não sobrescreve nada)")
  .action(() => {
    const config = loadConfigOrExit();
    log.info("initializing", { vault: config.vaultPath, db: config.dbPath });
    const result = bootstrapVaultStructure(config.vaultPath);
    const db = openDatabase(config.dbPath, { createDirs: true });
    try {
      applySchema(db);
    } finally {
      db.close();
    }
    for (const folder of result.createdFolders)
      process.stdout.write(`+ pasta criada: ${folder}\n`);
    for (const file of result.createdFiles)
      process.stdout.write(`+ arquivo criado: ${file}\n`);
    for (const item of result.skipped)
      process.stdout.write(`  já existia: ${item}\n`);
    process.stdout.write(`\nbanco: ${config.dbPath} (schema aplicado)\n`);
    process.stdout.write("vault pronto.\n");
  });

program
  .command("index")
  .description("indexa o vault no banco de forma incremental")
  .option("--json", "saída em JSON")
  .action((opts: { json?: boolean }) => {
    const config = loadConfigOrExit();
    if (!existsSync(config.dbPath)) {
      process.stderr.write("banco inexistente. rode 'brain init' primeiro.\n");
      process.exit(1);
    }
    const report = indexVault(config);
    if (opts.json) {
      process.stdout.write(JSON.stringify(report, null, 2) + "\n");
      return;
    }
    process.stdout.write(
      `indexação concluída em ${report.durationMs} ms\n` +
        `  escaneados: ${report.scanned}\n` +
        `  novos: ${report.added} | alterados: ${report.changed} | removidos: ${report.removed}\n` +
        `  renomeados: ${report.renamed} | inalterados: ${report.unchanged}\n` +
        `  links não resolvidos: ${report.unresolvedLinks}\n` +
        `  erros: ${report.errors.length}\n`,
    );
    for (const err of report.errors.slice(0, 10)) {
      process.stdout.write(`  ! ${err.path}: ${err.error}\n`);
    }
  });

program
  .command("watch")
  .description("observa o vault e reindexa automaticamente ao detectar mudanças")
  .action(() => {
    const config = loadConfigOrExit();
    let running = false;
    let timer: NodeJS.Timeout | undefined;

    const runIndex = (): void => {
      if (running) return;
      running = true;
      try {
        const report = indexVault(config);
        if (
          report.added + report.changed + report.removed + report.renamed > 0 ||
          report.errors.length > 0
        ) {
          process.stdout.write(
            `[watch] +${report.added} ~${report.changed} -${report.removed} ` +
              `=${report.renamed} erros:${report.errors.length}\n`,
          );
        }
      } catch (err) {
        log.error("watch reindex failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        running = false;
      }
    };

    process.stdout.write(`observando ${config.vaultPath} (Ctrl+C para sair)\n`);
    runIndex();
    fsWatch(
      config.vaultPath,
      { recursive: true },
      (_event, filename) => {
        if (!filename) return;
        const name = String(filename);
        if (/\.brainignore$/.test(name)) return;
        clearTimeout(timer);
        timer = setTimeout(runIndex, 800);
      },
    );
  });

interface StatsRow {
  documents: number;
  entities: number;
  relations: number;
  memories: number;
  events: number;
}

function printStats(): void {
  const config = loadConfigOrExit();
  if (!existsSync(config.dbPath)) {
    process.stdout.write("banco inexistente. rode 'brain init' + 'brain index'.\n");
    return;
  }
  const db = openDatabase(config.dbPath, { createDirs: false });
  try {
    const row = db
      .prepare(
        `SELECT
          (SELECT COUNT(*) FROM documents) AS documents,
          (SELECT COUNT(*) FROM entities)  AS entities,
          (SELECT COUNT(*) FROM relations) AS relations,
          (SELECT COUNT(*) FROM memories)  AS memories,
          (SELECT COUNT(*) FROM events)    AS events`,
      )
      .get() as StatsRow | undefined;
    const lastIndexed = getMetadata(db, "last_indexed_at");
    for (const [key, value] of Object.entries(row ?? {})) {
      process.stdout.write(`${key.padEnd(12)} ${value}\n`);
    }
    process.stdout.write(`last_indexed ${lastIndexed ?? "nunca"}\n`);
  } finally {
    db.close();
  }
}

interface ContextCommandOptions {
  json?: boolean;
  task?: string;
  depth?: string;
  maxChars?: string;
}

program
  .command("context <subject>")
  .description("monta contexto consolidado para trabalhar em um assunto")
  .option("--json", "saída em JSON")
  .option("--task <texto>", "tarefa pretendida (afina documentos)")
  .option("-d, --depth <n>", "profundidade do grafo", "1")
  .option("--max-chars <n>", "orçamento de caracteres", "12000")
  .action((subject: string, opts: ContextCommandOptions) => {
    const config = loadConfigOrExit();
    try {
      const context = buildContext({
        dbPath: config.dbPath,
        subject,
        task: opts.task,
        depth: Number(opts.depth ?? "1"),
        maxChars: Number(opts.maxChars ?? String(config.context.maxChars)),
      });
      if (opts.json) {
        process.stdout.write(JSON.stringify(context, null, 2) + "\n");
        return;
      }
      process.stdout.write(
        `# CONTEXTO: ${context.entityId ?? context.subject}\n` +
          (context.resolvedBy ? `resolvido por: ${context.resolvedBy}\n` : "") +
          (context.entityType ? `tipo: ${context.entityType}` : "") +
          (context.status ? ` | status: ${context.status}\n` : "\n") +
          `\n## RESUMO\n${context.summary ?? "(sem resumo disponível)"}\n` +
          (context.aliases.length > 0
            ? `\nalises: ${context.aliases.join(", ")}\n`
            : "") +
          `\n## RELACIONADOS (${context.relatedEntities.length})\n` +
          context.relatedEntities
            .map(
              (r) =>
                `- ${r.id} (${r.type}) via ${r.relation} [${r.direction}]`,
            )
            .join("\n") +
          `\n\n## DECISÕES (${context.decisions.length})\n` +
          (context.decisions.map((d) => `- ${d.id}: ${d.title}`).join("\n") ||
            "(nenhuma)") +
          `\n\n## PROCEDIMENTOS (${context.procedures.length})\n` +
          (context.procedures.map((p) => `- ${p.id}: ${p.title}`).join("\n") ||
            "(nenhum)") +
          `\n\n## EVENTOS RECENTES (${context.recentEvents.length})\n` +
          (context.recentEvents
            .map((e) => `- [${e.at}] ${e.kind}: ${e.summary}`)
            .join("\n") || "(nenhum)") +
          `\n\n## DOCUMENTOS (${context.documents.length})\n` +
          (context.documents.map((d) => `- ${d.path}`).join("\n") || "(nenhum)") +
          `\n\n## FONTES\n` +
          (context.sources
            .map((s) => `- ${s.sourceType}:${s.location}`)
            .join("\n") || "(nenhuma)") +
          `\n\n## AVISOS\n` +
          (context.warnings.join("; ") || "(nenhum)") +
          `\n\norçamento: ${context.charBudget.used}/${context.charBudget.max} chars` +
          `${context.truncated ? " (TRUNCADO)" : ""}\n`,
      );
    } catch (err) {
      const brainErr = toBrainError(err);
      process.stderr.write(`brain: [${brainErr.code}] ${brainErr.message}\n`);
      process.exit(1);
    }
  });

interface AskCommandOptions {
  json?: boolean;
  depth?: string;
  maxChars?: string;
}

program
  .command("ask <query>")
  .description("pipeline completo: roteia intenção, resolve, busca e monta contexto")
  .option("--json", "saída em JSON")
  .option("-d, --depth <n>", "profundidade do grafo", "1")
  .option("--max-chars <n>", "orçamento de caracteres", "12000")
  .action((query: string, opts: AskCommandOptions) => {
    const config = loadConfigOrExit();
    try {
      const response = ask({
        dbPath: config.dbPath,
        query,
        depth: Number(opts.depth ?? "1"),
        maxChars: Number(opts.maxChars ?? String(config.context.maxChars)),
      });
      if (opts.json) {
        process.stdout.write(JSON.stringify(response, null, 2) + "\n");
        return;
      }
      process.stdout.write(
        `pergunta: "${response.query}"\n` +
          `rota: ${response.route.intent} ` +
          `(busca=${response.route.useSearch}, grafo=${response.route.useGraph}, timeline=${response.route.useTimeline})\n` +
          (response.resolution
            ? `entidade: ${response.resolution.entityId} (${response.resolution.method}, conf=${response.resolution.confidence})\n`
            : "entidade: nenhuma\n") +
          `hits: ${response.searchHits.length} | avisos: ${response.warnings.length}\n` +
          response.searchHits
            .slice(0, 5)
            .map((h) => `  ▸ ${h.title} — ${h.snippet.replaceAll("\n", " ").slice(0, 100)}…`)
            .join("\n") +
          "\n",
      );
    } catch (err) {
      const brainErr = toBrainError(err);
      process.stderr.write(`brain: [${brainErr.code}] ${brainErr.message}\n`);
      process.exit(1);
    }
  });

interface AIStatusOptions {
  json?: boolean;
}

program
  .command("ai:status")
  .description("verifica o runtime de IA local (llama.cpp + Qwen 3)")
  .option("--json", "saída em JSON")
  .action(async (opts: AIStatusOptions) => {
    const config = loadConfigOrExit();
    const provider = new LocalLlamaCppProvider({
      baseUrl: config.ai.baseUrl,
      model: config.ai.model,
    });
    const available = await provider.isAvailable();
    if (opts.json) {
      process.stdout.write(
        JSON.stringify({ provider: provider.name, model: provider.model, available, baseUrl: config.ai.baseUrl }, null, 2) + "\n",
      );
      return;
    }
    process.stdout.write(
      `runtime:  ${provider.name}\nmodelo:   ${provider.model}\nurl:      ${config.ai.baseUrl}\nstatus:   ${available ? "DISPONIVEL" : "OFFLINE (rode scripts/llama-serve.cmd)"}\n`,
    );
    process.exitCode = available ? 0 : 1;
  });

interface AIExtractOptions {
  json?: boolean;
  entity?: string;
  save?: boolean;
}

program
  .command("ai:extract <texto>")
  .description("classifica um texto e propoe memorias (salva apenas com --save)")
  .option("--json", "saída em JSON")
  .option("-e, --entity <entidade>", "vincula a uma entidade (id, alias ou nome)")
  .option("--save", "confirma e salva as memorias propostas")
  .action(async (text: string, opts: AIExtractOptions) => {
    const config = loadConfigOrExit();
    const provider = new LocalLlamaCppProvider({
      baseUrl: config.ai.baseUrl,
      model: config.ai.model,
    });
    try {
      if (!(await provider.isAvailable())) {
        process.stderr.write("IA local offline. Rode: npm run llama:serve\n");
        process.exit(1);
        return;
      }
      const { proposals } = await extractMemoryProposals(provider, text);
      if (opts.json) {
        process.stdout.write(JSON.stringify({ proposals, saved: opts.save === true }, null, 2) + "\n");
      } else {
        process.stdout.write(`propostas (${proposals.length}):\n`);
        for (const p of proposals) {
          process.stdout.write(`  [${p.category}] conf=${p.confidence.toFixed(2)} — ${p.summary}\n`);
        }
        if (proposals.length === 0) {
          process.stdout.write("  (nenhuma proposta reconhecida)\n");
        }
      }
      if (opts.save && proposals.length > 0) {
        for (const p of proposals) {
          const saved = saveConfirmedMemory(config, {
            content: p.summary,
            category: p.category,
            memoryKind:
              p.category === "DECISION"
                ? "decision"
                : p.category === "PROCEDURE"
                  ? "procedural"
                  : "semantic",
            entityId: opts.entity,
            confidence: p.confidence,
          });
          if (!opts.json) {
            process.stdout.write(`  salva #${saved.memoryId}${saved.entityId ? ` → ${saved.entityId}` : ""}\n`);
          }
        }
      }
    } catch (err) {
      const brainErr = toBrainError(err);
      process.stderr.write(`brain: [${brainErr.code}] ${brainErr.message}\n`);
      process.exit(1);
    }
  });

interface TimelineCommandOptions {
  json?: boolean;
  limit?: string;
  kinds?: string;
}

program
  .command("timeline <id>")
  .description("histórico de uma entidade: eventos, relações, documento e memórias")
  .option("--json", "saída em JSON")
  .option("-l, --limit <n>", "máximo de entradas", "30")
  .option("-k, --kinds <tipos>", "filtrar (vírgula: event,relation,document,memory)")
  .action((idOrName: string, opts: TimelineCommandOptions) => {
    const config = loadConfigOrExit();
    try {
      const result = withDatabase(config, (db) => {
        const resolution = resolveEntity(db, idOrName);
        if (!resolution.best) return null;
        const kinds = opts.kinds
          ? (opts.kinds.split(",").map((k) => k.trim()).filter(Boolean) as Array<
              "event" | "relation" | "document" | "memory"
            >)
          : undefined;
        const entries = buildTimeline(db, {
          entityId: resolution.best.entity.id,
          limit: Number(opts.limit ?? "30"),
          kinds,
        });
        return { entityId: resolution.best.entity.id, entries };
      });

      if (!result) {
        process.stderr.write(`entidade não encontrada: ${idOrName}\n`);
        process.exit(1);
        return;
      }

      if (opts.json) {
        process.stdout.write(JSON.stringify(result, null, 2) + "\n");
        return;
      }
      process.stdout.write(`linha do tempo: ${result.entityId}\n\n`);
      for (const entry of result.entries) {
        process.stdout.write(`[${entry.at}] (${entry.kind}) ${entry.summary}\n`);
      }
      if (result.entries.length === 0) {
        process.stdout.write("(sem entradas)\n");
      }
    } catch (err) {
      const brainErr = toBrainError(err);
      process.stderr.write(`brain: [${brainErr.code}] ${brainErr.message}\n`);
      process.exit(1);
    }
  });

program
  .command("project <id>")
  .description("intelligence de um projeto: relacionados, decisões, skills, tools, timeline")
  .option("--json", "saída em JSON")
  .action((id: string, opts: { json?: boolean }) => {
    const config = loadConfigOrExit();
    try {
      const pi = getProjectIntelligence(config, id);
      if (opts.json) {
        process.stdout.write(JSON.stringify(pi, null, 2) + "\n");
        return;
      }
      process.stdout.write(
        `# PROJETO: ${pi.entity.id} (${pi.entity.status ?? "sem status"})\n` +
          `decisões: ${pi.decisions.map((d) => d.id).join(", ") || "-"}\n` +
          `procedimentos: ${pi.procedures.map((p) => p.id).join(", ") || "-"}\n` +
          `projetos relacionados: ${pi.projectRelations.map((r) => `${r.otherProject} [${r.relation}]`).join(", ") || "-"}\n` +
          `skills primary: ${pi.skills.primary.map((s) => s.id).join(", ") || "-"}\n` +
          `memórias: ${pi.memories.length} | timeline: ${pi.timeline.length}\n`,
      );
    } catch (err) {
      const brainErr = toBrainError(err);
      process.stderr.write(`brain: [${brainErr.code}] ${brainErr.message}\n`);
      process.exit(1);
    }
  });

const learn = program.command("learn").description("governança do learning loop");

learn
  .command("list")
  .description("lista observações e candidates de aprendizado")
  .action(() => {
    const config = loadConfigOrExit();
    const result = withDatabase(config, (database) => listCandidates(database));
    if (result.length === 0) {
      process.stdout.write("(nenhuma observação)\n");
      return;
    }
    for (const o of result) {
      process.stdout.write(
        `#${o.id} [${o.status}] x${o.count} (${o.observationType}) ${o.subject?.slice(0, 80)}\n`,
      );
    }
  });

learn
  .command("accept <id>")
  .description("aceita um candidate (promove a aprendizado)")
  .action((idStr: string) => {
    const config = loadConfigOrExit();
    withDatabase(config, (database) => {
      const o = acceptObservation(database, Number(idStr));
      process.stdout.write(`#${o.id} aceito.\n`);
    });
  });

learn
  .command("reject <id>")
  .description("rejeita um candidate")
  .action((idStr: string) => {
    const config = loadConfigOrExit();
    withDatabase(config, (database) => {
      const o = rejectObservation(database, Number(idStr));
      process.stdout.write(`#${o.id} rejeitado.\n`);
    });
  });

program
  .command("goals")
  .description("lista objetivos ativos priorizados (score determinístico)")
  .action(() => {
    const config = loadConfigOrExit();
    const result = withDatabase(config, (db) =>
      listActiveGoalsByPriority(db, 10),
    );
    if (result.length === 0) {
      process.stdout.write("(nenhum objetivo ativo — use o MCP brain_create_goal)\n");
      return;
    }
    for (const g of result) {
      process.stdout.write(
        `${String(g.score).padStart(3)}  ${g.id}  ${g.name}` +
          ` [${g.progressPct !== null ? g.progressPct + "%" : "sem métrica"}]\n` +
          `      ${g.reasons.join("; ")}\n`,
      );
    }
  });

program
  .command("next")
  .description("o que deveríamos fazer agora? (objetivos + observações + iniciativas)")
  .action(() => {
    const config = loadConfigOrExit();
    const na = brainNextActions(config);
    process.stdout.write(
      `OBJETIVOS ATIVOS (${na.goals.length}):\n` +
        na.goals
          .map((g) => `  • ${g.name} — ${g.progressPct ?? "?"}% (score ${g.score})`)
          .join("\n") +
        `\n\nRECOMENDAÇÕES:\n` +
        (na.recommendations.map((r) => `  → [${r.kind}] ${r.title}\n     ${r.reason}`).join("\n") ||
          "  (nenhuma recomendação no momento)") +
        "\n",
    );
  });

program
  .command("propose <initiativeId>")
  .description("gera proposta formatada da iniciativa para aprovação humana")
  .action((initiativeId: string) => {
    const config = loadConfigOrExit();
    try {
      const proposal = withDatabase(config, (database) =>
        formatProposal(database, config, initiativeId),
      );
      process.stdout.write(proposal + "\n");
    } catch (err) {
      const brainErr = toBrainError(err);
      process.stderr.write(`brain: [${brainErr.code}] ${brainErr.message}\n`);
      process.exit(1);
    }
  });

function runDoctor(): void {
  let failures = 0;
  const check = (name: string, ok: boolean, detail: string): void => {
    process.stdout.write(`${ok ? "OK " : "ERR"} ${name}: ${detail}\n`);
    if (!ok) failures++;
  };

  const major = Number(process.versions.node.split(".")[0]);
  check("node", major >= 24, `v${process.versions.node} (>=24 necessário p/ node:sqlite)`);

  let config;
  try {
    config = loadConfig();
    check("config", true, `vault=${config.vaultPath}`);
  } catch (err) {
    check("config", false, err instanceof Error ? err.message : String(err));
    process.exit(1);
    return;
  }

  check("vault", existsSync(config.vaultPath), config.vaultPath);

  if (existsSync(config.dbPath)) {
    try {
      const db = openDatabase(config.dbPath, { createDirs: false });
      applySchema(db);
      const version = getMetadata(db, "schema_version") ?? "?";
      const sizeKb = Math.round(statSync(config.dbPath).size / 1024);
      db.close();
      check("database", true, `${config.dbPath} (${sizeKb} KB, schema v${version})`);
    } catch (err) {
      check("database", false, String(toBrainError(err).message));
    }
  } else {
    process.stdout.write(
      `--  database: ${config.dbPath} ainda não existe (rode 'brain init')\n`,
    );
  }

  if (process.platform === "win32") {
    try {
      const out = execFileSync(
        "powershell.exe",
        ["-NoProfile", "-Command", "(Get-PSDrive C).Free"],
        { encoding: "utf8" },
      );
      const freeGb = Number(out.trim()) / 1024 ** 3;
      check(
        "disk",
        freeGb > 1,
        `${freeGb.toFixed(1)} GB livres em C:${freeGb <= 1 ? " (CRÍTICO < 1GB)" : ""}`,
      );
    } catch {
      process.stdout.write("--  disk: não foi possível verificar\n");
    }
  }

  process.exit(failures > 0 ? 1 : 0);
}

function withDatabase<T>(config: ReturnType<typeof loadConfig>, fn: (db: ReturnType<typeof openDatabase>) => T): T {
  if (!existsSync(config.dbPath)) {
    process.stderr.write("banco inexistente. rode 'brain init' + 'brain index'.\n");
    process.exit(1);
  }
  const db = openDatabase(config.dbPath, { createDirs: false });
  try {
    applySchema(db);
    return fn(db);
  } finally {
    db.close();
  }
}

interface GetCommandOptions {
  json?: boolean;
}

program
  .command("get <id>")
  .description("mostra uma entidade específica (aceita id, alias ou nome)")
  .option("--json", "saída em JSON")
  .action((idOrName: string, opts: GetCommandOptions) => {
    const config = loadConfigOrExit();
    try {
      const result = withDatabase(config, (db) => {
        const resolution = resolveEntity(db, idOrName);
        if (!resolution.best) return null;
        const entity = getEntity(db, resolution.best.entity.id);
        const stats = getEntityStats(db, entity.id);
        const timeline = buildTimeline(db, { entityId: entity.id, limit: 10 });
        return { resolution, entity, stats, timeline };
      });

      if (!result) {
        process.stderr.write(`entidade não encontrada: ${idOrName}\n`);
        process.exit(1);
        return;
      }

      if (opts.json) {
        process.stdout.write(JSON.stringify(result, null, 2) + "\n");
        return;
      }

      const { entity, stats } = result;
      process.stdout.write(
        `${entity.id}\n` +
          `  nome:     ${entity.canonicalName}\n` +
          `  tipo:     ${entity.type}${entity.status ? ` | status: ${entity.status}` : ""}\n` +
          (entity.aliases.length > 0 ? `  aliases:  ${entity.aliases.join(", ")}\n` : "") +
          (entity.originDocumentId ? `  origem:   ${stats.originDocument?.path ?? "?"}\n` : "") +
          `  relações: ${stats.outgoingRelations} saíntes / ${stats.incomingRelations} entrantes\n`,
      );
    } catch (err) {
      const brainErr = toBrainError(err);
      process.stderr.write(`brain: [${brainErr.code}] ${brainErr.message}\n`);
      process.exit(1);
    }
  });

interface RelatedCommandOptions {
  json?: boolean;
  depth?: string;
  dir?: string;
  rel?: string;
  asOf?: string;
}

program
  .command("related <id>")
  .description("entidades relacionadas (grafo, com profundidade opcional)")
  .option("--json", "saída em JSON")
  .option("-d, --depth <n>", "profundidade da travessia (1-5)", "1")
  .option("--dir <dir>", "direção: out | in | both", "both")
  .option("--rel <tipos>", "filtrar tipos de relação (vírgula: USES,PART_OF)")
  .option("--as-of <data>", "data de referência temporal (ISO)")
  .action((idOrName: string, opts: RelatedCommandOptions) => {
    const config = loadConfigOrExit();
    try {
      const result = withDatabase(config, (db) => {
        const resolution = resolveEntity(db, idOrName);
        if (!resolution.best) return null;
        const direction = (["out", "in", "both"].includes(opts.dir ?? "")
          ? opts.dir
          : "both") as Direction;
        const relationTypes = opts.rel
          ? opts.rel.split(",").map((t) => t.trim()).filter(Boolean)
          : undefined;
        if ((opts.depth ? Number(opts.depth) : 1) > 1 || direction !== "both" || relationTypes) {
          const traversal = traverseGraph(db, resolution.best.entity.id, {
            maxDepth: Number(opts.depth ?? "1"),
            direction,
            relationTypes,
            asOf: opts.asOf,
          });
          return { resolution, traversal };
        }
        const edges = relatedEdges(db, resolution.best.entity.id, {
          direction,
          relationTypes,
          asOf: opts.asOf,
        });
        return {
          resolution,
          edges,
          traversal: {
            start: resolution.best.entity.id,
            nodes: [
              { id: resolution.best.entity.id, depth: 0 },
              ...edges.map((e) => ({
                id: e.source === resolution.best!.entity.id ? e.target : e.source,
                depth: 1,
              })),
            ],
            edges,
          },
        };
      });

      if (!result) {
        process.stderr.write(`entidade não encontrada: ${idOrName}\n`);
        process.exit(1);
        return;
      }

      const { resolution, traversal } = result;
      if (!resolution.best || !traversal) {
        process.stderr.write(`entidade não encontrada: ${idOrName}\n`);
        process.exit(1);
        return;
      }

      if (opts.json) {
        process.stdout.write(
          JSON.stringify({ resolvedBy: resolution.best.method, ...traversal }, null, 2) + "\n",
        );
        return;
      }

      process.stdout.write(
        `grafo de ${resolution.best.entity.id} (resolvido por ${resolution.best.method})\n` +
          `nós: ${traversal.nodes.length} | arestas: ${traversal.edges.length}\n\n`,
      );
      for (const edge of traversal.edges) {
        process.stdout.write(
          `  ${edge.source} -[${edge.relationType}]-> ${edge.target}` +
            ` (conf=${edge.confidence.toFixed(2)}${edge.validUntil ? `, até ${edge.validUntil}` : ""})\n`,
        );
      }
    } catch (err) {
      const brainErr = toBrainError(err);
      process.stderr.write(`brain: [${brainErr.code}] ${brainErr.message}\n`);
      process.exit(1);
    }
  });

interface ResolveCommandOptions {
  json?: boolean;
}

program
  .command("resolve <query>")
  .description("mostra como uma consulta é resolvida para entidades")
  .option("--json", "saída em JSON")
  .action((query: string, opts: ResolveCommandOptions) => {
    const config = loadConfigOrExit();
    const result = withDatabase(config, (db) => resolveEntity(db, query));

    if (opts.json) {
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
      return;
    }

    if (!result.best) {
      process.stdout.write(`"${query}" → nenhuma entidade encontrada\n`);
      return;
    }
    process.stdout.write(
      `"${query}" → ${result.best.entity.id} via ${result.best.method} (conf=${result.best.confidence})\n`,
    );
    for (const c of result.candidates.slice(0, 5)) {
      process.stdout.write(`  candidato: ${c.entity.id} (${c.method}, conf=${c.confidence})\n`);
    }
  });

interface SearchCommandOptions {
  json?: boolean;
  limit?: string;
  type?: string;
  tag?: string;
  offset?: string;
}

program
  .command("search <query>")
  .description("busca lexical no índice (FTS5, ranking bm25, snippets)")
  .option("--json", "saída em JSON")
  .option("-l, --limit <n>", "máximo de resultados", "10")
  .option("-o, --offset <n>", "pular primeiros N resultados", "0")
  .option("-t, --type <tipos>", "filtrar por tipo (vírgula: project,knowledge)")
  .option("--tag <tag>", "filtrar por tag")
  .action((query: string, opts: SearchCommandOptions) => {
    const config = loadConfigOrExit();
    if (!existsSync(config.dbPath)) {
      process.stderr.write("banco inexistente. rode 'brain init' + 'brain index'.\n");
      process.exit(1);
      return;
    }
    const limit = Math.min(
      Math.max(1, Number(opts.limit ?? "10") || config.search.defaultLimit),
      config.search.maxLimit,
    );
    try {
      const result = searchDocuments({
        dbPath: config.dbPath,
        query,
        limit,
        offset: Number(opts.offset ?? "0") || 0,
        filters: {
          ...(opts.type
            ? { type: opts.type.split(",").map((t) => t.trim()).filter(Boolean) }
            : {}),
          ...(opts.tag ? { tag: opts.tag } : {}),
        },
      });

      if (opts.json) {
        process.stdout.write(JSON.stringify(result, null, 2) + "\n");
        return;
      }

      process.stdout.write(
        `busca: "${query}" [estratégia ${result.strategy}] — ${result.total} resultado(s)\n\n`,
      );
      if (result.hits.length === 0) {
        process.stdout.write("(nenhum resultado)\n");
        return;
      }
      for (const hit of result.hits) {
        process.stdout.write(
          `▸ ${hit.title}${hit.type ? ` (${hit.type})` : ""}\n` +
            `  ${hit.path}\n` +
            `  score ${hit.score.toFixed(3)}${hit.entities.length > 0 ? ` · entidades: ${hit.entities.map((e) => e.id).join(", ")}` : ""}\n` +
            `  ${hit.snippet.replaceAll("\n", " ")}\n\n`,
        );
      }
    } catch (err) {
      const brainErr = toBrainError(err);
      process.stderr.write(`brain: [${brainErr.code}] ${brainErr.message}\n`);
      process.exit(1);
    }
  });

program.command("stats").description("mostra contagens do índice").action(printStats);

program
  .command("audit")
  .description("auditoria read-only do vault: duplicatas, vazios, órfãos, links quebrados e sem classificação")
  .action(() => {
    const config = loadConfigOrExit();
    const report = auditVault(config);
    process.stdout.write(auditExplanation(report) + "\n");
    if (!report.ok) {
      process.exit(1);
    }
  });

program
  .command("graph")
  .description("gerenciamento de Graphs: list, status, recover")
  .option("--list", "lista runs da sessão atual")
  .option("--status <runId>", "status de um run específico")
  .option("--recover", "recupera runs stale (stale → BLOCKED)")
  .action((opts: { list?: boolean; status?: string; recover?: boolean }) => {
    const config = loadConfigOrExit();
    const db = openDatabase(config.dbPath);
    try {
      applySchema(db);
      if (opts.list) {
        const runs = db.prepare("SELECT id, status, goal FROM graph_runs ORDER BY updated_at DESC LIMIT 20").all() as Array<{ id: string; status: string; goal: string }>;
        const output = runs.length ? runs.map((r) => `- ${r.id} [${r.status}] "${r.goal.slice(0, 80)}"`).join("\n") : "nenhum run nesta sessão";
        process.stdout.write(output + "\n");
      } else if (opts.status) {
        const run = db.prepare("SELECT id, status, goal, result_json FROM graph_runs WHERE id = ?").get(opts.status) as Record<string, unknown> | undefined;
        if (!run) { process.stderr.write(`run not found: ${opts.status}\n`); process.exit(1); return; }
        const nodes = db.prepare("SELECT title, status, error, retry_count FROM graph_nodes WHERE run_id = ? ORDER BY ordinal ASC").all(opts.status) as Array<{ title: string; status: string; error: string; retry_count: number }>;
        const per = nodes.map((n) => `  ${n.title} [${n.status}]${n.error ? ` — ${n.error.slice(0, 140)}` : ""}`).join("\n") || "(sem nós)";
        process.stdout.write(`Run: ${run.status ?? "?"}\n${per}\n`);
      } else if (opts.recover) {
        const recovered = recoverStaleRuns(config);
        if (!recovered.length) { process.stdout.write("nenhum run stale\n"); return; }
        const lines = recovered.map((r) => `- ${r.runId}: ${r.reason}`).join("\n");
        process.stdout.write(lines + "\n");
      } else {
        process.stdout.write("Use --list, --status <id>, ou --recover\n");
      }
    } finally { db.close(); }
  });

program
  .command("personal-context <phone>")
  .description("audita contexto pessoal sem exibir conteúdo íntimo")
  .action((phone: string) => {
    if (!isAna(phone)) throw new BrainError("VALIDATION_ERROR", "personal context restricted to Ana");
    const config = loadConfigOrExit();
    const db = openDatabase(config.dbPath);
    try {
      const context = compilePersonalContext(db, phone);
      if (!context) throw new BrainError("NOT_FOUND", "personal contact not found");
      const personalRows = db.prepare("SELECT COUNT(*) AS n FROM memories WHERE category='PERSONAL' AND source_id='src.ana' AND project IS NULL").get() as { n: number };
      process.stdout.write(JSON.stringify({
        personId: context.personId,
        conversationId: context.conversationId,
        hasLastMessage: Boolean(context.lastMessage),
        topicCount: context.currentTopics.length,
        knownFacts: context.knownFacts.length,
        personalMemoryCount: Number(personalRows.n),
        sources: context.sources,
        privacyScope: "PERSONAL/RELATIONSHIP",
        commercialContextIncluded: false,
        communicationStyle: context.communicationStyle,
        confidence: context.confidence,
      }, null, 2) + "\n");
    } finally { db.close(); }
  });

program
  .command("ingest-personal-archive <archive>")
  .description("ingere export WhatsApp de Ana com deduplicação e escopo PERSONAL")
  .action((archive: string) => {
    const config = loadConfigOrExit();
    const db = openDatabase(config.dbPath);
    try {
      process.stdout.write(JSON.stringify(ingestWhatsAppArchive(db, {
        archivePath: archive,
        sourceId: "ana",
        contextScope: "PERSONAL",
        contactPhone: "15981142057",
        contactName: "Ana",
        confidenceBase: 0.9,
      }), null, 2) + "\n");
    } finally { db.close(); }
  });

program
  .command("health")
  .description("alias de doctor")
  .action(runDoctor);

program
  .command("doctor")
  .description("verifica saúde do ambiente: node, vault, banco, disco")
  .action(runDoctor);

try {
  await program.parseAsync(process.argv);
} catch (err) {
  const brainErr = toBrainError(err);
  process.stderr.write(`brain: [${brainErr.code}] ${brainErr.message}\n`);
  if (brainErr.details) log.debug("error details", brainErr.details);
  process.exit(1);
}
