// ─── MCP Tool Result Type ────────────────────────────────────────────

export interface ToolResult {
  [key: string]: unknown;
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

export function ok(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

export function fail(message: string): ToolResult {
  return { content: [{ type: "text", text: `ERROR: ${message}` }], isError: true };
}

export function formatError(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === "TimeoutError") return `Timeout: ${err.message}`;
    if (err.message.includes("Target closed")) return "Browser page was closed unexpectedly.";
    if (err.message.includes("Target crashed")) return "Browser page crashed.";
    if (err.message.includes("net::ERR_")) return `Network error: ${err.message}`;
    return err.message;
  }
  return String(err);
}

// ─── Logger ──────────────────────────────────────────────────────────

type LogLevel = "debug" | "info" | "warn" | "error";

const LOG_LEVELS: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

const currentLevel: LogLevel = (process.env.LOG_LEVEL as LogLevel) ?? "info";

function shouldLog(level: LogLevel): boolean {
  return LOG_LEVELS[level] >= LOG_LEVELS[currentLevel];
}

function timestamp(): string {
  return new Date().toISOString();
}

export const log = {
  debug(msg: string, data?: Record<string, unknown>) {
    if (shouldLog("debug"))
      console.error(`${timestamp()} [DEBUG] ${msg}`, data ? JSON.stringify(data) : "");
  },
  info(msg: string, data?: Record<string, unknown>) {
    if (shouldLog("info"))
      console.error(`${timestamp()} [INFO] ${msg}`, data ? JSON.stringify(data) : "");
  },
  warn(msg: string, data?: Record<string, unknown>) {
    if (shouldLog("warn"))
      console.error(`${timestamp()} [WARN] ${msg}`, data ? JSON.stringify(data) : "");
  },
  error(msg: string, data?: Record<string, unknown>) {
    if (shouldLog("error"))
      console.error(`${timestamp()} [ERROR] ${msg}`, data ? JSON.stringify(data) : "");
  },
};

// ─── Async Mutex ─────────────────────────────────────────────────────

export class Mutex {
  private locked = false;
  private queue: (() => void)[] = [];

  async acquire(): Promise<() => void> {
    return new Promise((resolve) => {
      const tryAcquire = () => {
        if (!this.locked) {
          this.locked = true;
          resolve(() => this.release());
        } else {
          this.queue.push(tryAcquire);
        }
      };
      tryAcquire();
    });
  }

  private release(): void {
    this.locked = false;
    const next = this.queue.shift();
    if (next) next();
  }
}

// ─── Input Validation ────────────────────────────────────────────────

export function validateNonEmpty(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ValidationError(`"${field}" is required and must be a non-empty string.`);
  }
  return value.trim();
}

export function validateUrl(value: unknown, field: string): URL {
  const str = validateNonEmpty(value, field);
  try {
    const url = new URL(str);
    if (!["http:", "https:"].includes(url.protocol)) {
      throw new ValidationError(`"${field}" must use http or https protocol, got "${url.protocol}".`);
    }
    return url;
  } catch (err) {
    if (err instanceof ValidationError) throw err;
    throw new ValidationError(`"${field}" is not a valid URL: "${str}".`);
  }
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}
