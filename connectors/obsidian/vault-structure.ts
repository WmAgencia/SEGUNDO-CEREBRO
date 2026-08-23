import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createLogger } from "../../core/logger/logger.ts";

const log = createLogger("vault");

export const VAULT_FOLDERS = [
  "00 - Inbox",
  "01 - Projects",
  "02 - Areas",
  "03 - Knowledge",
  "04 - Ideas",
  "05 - Decisions",
  "06 - Procedures",
  "07 - Entities",
  "08 - Research",
  "09 - Daily",
  "99 - Archive",
] as const;

export const SYSTEM_DIR = "_system";

export const BRAINIGNORE_CONTENT = [
  "# Second Brain OS - arquivos que NUNCA sao indexados",
  ".env",
  ".env.*",
  "**/secrets/**",
  "**/credentials/**",
  "**/*.pem",
  "**/*.key",
  ".obsidian/",
  ".trash/",
].join("\n");

const SYSTEM_README = `# _system

Diretório interno do Second Brain OS.

- schemas/: tipos de entidade e relação aceitos pelo índice
- templates/: modelos de nota compatíveis com o schema
- indexes/: saídas geradas (nunca indexadas)

O conteúdo aqui não é conhecimento humano; é infraestrutura do cérebro.
`;

const ENTITY_TEMPLATE = `---
id:
type:
title:
status: active
created_at: %DATE%
updated_at: %DATE%
tags: []
aliases: []
---

# {{title}}

## Resumo

## Notas

## Relações

`;

export interface InitResult {
  createdFolders: string[];
  createdFiles: string[];
  skipped: string[];
}

function ensureDir(fullPath: string, result: InitResult): void {
  if (!existsSync(fullPath)) {
    mkdirSync(fullPath, { recursive: true });
    result.createdFolders.push(path.basename(fullPath));
  } else {
    result.skipped.push(path.basename(fullPath) + "/");
  }
}

function ensureFile(
  fullPath: string,
  content: string,
  result: InitResult,
  basePath: string,
): void {
  if (!existsSync(fullPath)) {
    writeFileSync(fullPath, content, "utf8");
    result.createdFiles.push(path.relative(basePath, fullPath));
  } else {
    result.skipped.push(path.basename(fullPath));
  }
}

export function bootstrapVaultStructure(vaultPath: string): InitResult {
  const result: InitResult = { createdFolders: [], createdFiles: [], skipped: [] };

  for (const folder of VAULT_FOLDERS) {
    ensureDir(path.join(vaultPath, folder), result);
  }

  const systemDir = path.join(vaultPath, SYSTEM_DIR);
  ensureDir(systemDir, result);
  for (const sub of ["schemas", "templates", "indexes"]) {
    ensureDir(path.join(systemDir, sub), result);
  }

  ensureFile(path.join(systemDir, "README.md"), SYSTEM_README, result, vaultPath);
  ensureFile(
    path.join(systemDir, "templates", "entity-template.md"),
    ENTITY_TEMPLATE.replaceAll("%DATE%", new Date().toISOString().slice(0, 10)),
    result,
    vaultPath,
  );
  ensureFile(path.join(vaultPath, ".brainignore"), BRAINIGNORE_CONTENT, result, vaultPath);

  log.info("vault structure ensured", {
    createdFolders: result.createdFolders.length,
    createdFiles: result.createdFiles.length,
  });
  return result;
}
