interface RetryLogger {
  warn: (...args: unknown[]) => void;
}

export interface DatabaseOpenRetryOptions {
  maxAttempts?: number;
  delaysMs?: number[];
  sleep?: (ms: number) => Promise<void>;
  reset?: () => void;
  logger?: RetryLogger;
}

const TRANSIENT_CODES = new Set(['SQLITE_BUSY', 'SQLITE_IOERR', 'SQLITE_LOCKED']);
const TRANSIENT_MESSAGE_PARTS = [
  'disk i/o error',
  'database is locked',
  'database table is locked',
  'resource busy or locked',
  'device or resource busy',
];

function errorCodes(error: unknown): string[] {
  if (!error || typeof error !== 'object') return [];
  const record = error as Record<string, unknown>;
  return [record.code, record.errno].filter((value): value is string => typeof value === 'string');
}

export function isTransientDatabaseOpenError(error: unknown): boolean {
  if (errorCodes(error).some((code) => TRANSIENT_CODES.has(code))) return true;
  const message =
    error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return TRANSIENT_MESSAGE_PARTS.some((part) => message.includes(part));
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Retries only short-lived database handover faults; real corruption still fails fast. */
export async function openDatabaseWithRetry(
  open: () => void,
  options: DatabaseOpenRetryOptions = {},
): Promise<number> {
  const maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? 6));
  const delays = options.delaysMs ?? [400, 800, 1_200, 2_000, 3_000];
  const sleep = options.sleep ?? defaultSleep;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      open();
      return attempt;
    } catch (error) {
      if (!isTransientDatabaseOpenError(error) || attempt === maxAttempts) throw error;
      const delay = delays[Math.min(attempt - 1, delays.length - 1)] ?? 0;
      options.logger?.warn(
        `[DB] Transient database open failure (attempt ${attempt}/${maxAttempts}); retrying in ${delay}ms:`,
        error instanceof Error ? error.message : String(error),
      );
      try {
        options.reset?.();
      } catch {
        // A partial handle that cannot close must not mask the original open error.
      }
      await sleep(delay);
    }
  }
  throw new Error('Database open retry exhausted');
}
