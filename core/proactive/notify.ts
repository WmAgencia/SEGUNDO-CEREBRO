import type { BrainConfig } from "../config/loader.ts";
import { resolveEntity } from "../entities/resolver.ts";
import { getEntityStats } from "../entities/entity.ts";
import { searchMemories } from "../memory/memory-engine.ts";
import { buildContextPackage } from "../context/context-package.ts";
import { brainNextActions } from "../goals/proactive.ts";
import { unifiedQuery } from "../unified.ts";
import { redactSecrets } from "../exec/redact.ts";
import * as evolution from "../comms/evolution-api.ts";

const OPERATIONS_GROUP = () => process.env.SECOND_BRAIN_OPERATIONS_GROUP ?? "120363427273069174@g.us";

export async function notify(
  config: BrainConfig,
  message: string,
): Promise<boolean> {
  try {
    const result = await evolution.sendMessage(OPERATIONS_GROUP(), message);
    return result.messageId !== "unknown";
  } catch {
    return false;
  }
}

export function brainQuery(config: BrainConfig, query: string) {
  return unifiedQuery(config, { query, depth: 2 });
}

export { resolveEntity, getEntityStats, searchMemories, buildContextPackage, redactSecrets };
