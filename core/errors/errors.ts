export type ErrorCode =
  | "CONFIG_ERROR"
  | "NOT_FOUND"
  | "VALIDATION_ERROR"
  | "STORAGE_ERROR"
  | "INDEXER_ERROR"
  | "PERMISSION_ERROR";

export class BrainError extends Error {
  readonly code: ErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(
    code: ErrorCode,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "BrainError";
    this.code = code;
    this.details = details;
  }

  toJSON(): Record<string, unknown> {
    return {
      error: this.name,
      code: this.code,
      message: this.message,
      details: this.details,
    };
  }
}

export class ConfigError extends BrainError {
  constructor(message: string, details?: Record<string, unknown>) {
    super("CONFIG_ERROR", message, details);
    this.name = "ConfigError";
  }
}

export class NotFoundError extends BrainError {
  constructor(message: string, details?: Record<string, unknown>) {
    super("NOT_FOUND", message, details);
    this.name = "NotFoundError";
  }
}

export class ValidationError extends BrainError {
  constructor(message: string, details?: Record<string, unknown>) {
    super("VALIDATION_ERROR", message, details);
    this.name = "ValidationError";
  }
}

export class StorageError extends BrainError {
  constructor(message: string, details?: Record<string, unknown>) {
    super("STORAGE_ERROR", message, details);
    this.name = "StorageError";
  }
}

export function toBrainError(err: unknown): BrainError {
  if (err instanceof BrainError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new BrainError("STORAGE_ERROR", message);
}
