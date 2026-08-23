import { redactSecrets, redactDeep } from "./redact.ts";

export interface ToolExecutorContext {
  taskId?: number;
  initiativeId?: string;
  agentId: string;
  signal?: AbortSignal;
}

export interface ExecutorOutput {
  output: string;
  summary: string;
  artifacts?: string[];
}

export type HandlerFn = (
  input: Record<string, unknown>,
  ctx: ToolExecutorContext,
) => Promise<ExecutorOutput>;

export class LocalExecutor {
  private handlers = new Map<string, HandlerFn>();

  register(toolId: string, handler: HandlerFn): void {
    this.handlers.set(toolId, handler);
  }

  canExecute(toolId: string): boolean {
    return this.handlers.has(toolId);
  }

  async execute(
    toolId: string,
    input: Record<string, unknown>,
    ctx: ToolExecutorContext,
  ): Promise<ExecutorOutput> {
    const handler = this.handlers.get(toolId);
    if (!handler) throw new Error(`no local executor for ${toolId}`);
    return handler(input, ctx);
  }
}

export function makeRedactingWrapper(executor: LocalExecutor): LocalExecutor {
  const wrapped = new LocalExecutor();
  const original = executor["handlers"];
  for (const [key, fn] of original.entries()) {
    wrapped.register(key, async (input, ctx) => {
      const result = await fn(redactDeep(input) as Record<string, unknown>, ctx);
      return {
        output: redactSecrets(result.output),
        summary: redactSecrets(result.summary),
        artifacts: result.artifacts,
      };
    });
  }
  return wrapped;
}
