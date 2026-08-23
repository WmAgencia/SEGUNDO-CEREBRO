import type { BrainConfig } from "../config/loader.ts";
import { resolveEntity } from "../entities/resolver.ts";
import { getEntityStats } from "../entities/entity.ts";
import { searchMemories } from "../memory/memory-engine.ts";
import { buildContextPackage } from "../context/context-package.ts";
import { brainNextActions } from "../goals/proactive.ts";
import { unifiedQuery } from "../unified.ts";
import { redactSecrets } from "../exec/redact.ts";
import * as evolution from "../comms/evolution-api.ts";

const WHATSAPP_NUMBER = () => process.env.OWNER_WHATSAPP ?? "5515981817336";

export async function notify(
  config: BrainConfig,
  message: string,
): Promise<boolean> {
  try {
    const result = await evolution.sendMessage(WHATSAPP_NUMBER(), message);
    return result.messageId !== "unknown";
  } catch {
    return false;
  }
}

export function brainQuery(config: BrainConfig, query: string) {
  return unifiedQuery(config, { query, depth: 2 });
}

export { resolveEntity, getEntityStats, searchMemories, buildContextPackage, redactSecrets };
