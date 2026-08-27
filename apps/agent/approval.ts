/**
 * Approval gate for the agent server.
 * Sessions register their approval closure; the frontend interaction is:
 *   agent returns { type: 'approval_requested', approval: { toolId, input } }
 *   → UI asks the user → POST /approve with approved=true/false
 * This returns a resolver so the tool can await the user decision.
 */

const pending = new Map<string, { resolve: (v: boolean) => void; toolId: string; input: Record<string, unknown> }>();

export function createToolRequestApproval(sessionKey: string): (toolId: string, input: Record<string, unknown>) => Promise<boolean> {
  return (toolId, input) => {
    return new Promise<boolean>((resolve) => {
      pending.set(sessionKey + ":" + toolId + ":" + Date.now(), { resolve, toolId, input });
    });
  };
}

/** Resolve an approval for a session+tool. */
export function resolveApproval(sessionKey: string, toolId: string, input: Record<string, unknown>, approved: boolean): void {
  for (const [key, entry] of pending) {
    if (key.startsWith(sessionKey + ":" + toolId)) {
      entry.resolve(approved);
      pending.delete(key);
    }
  }
}

export function pendingCount(): number {
  return pending.size;
}