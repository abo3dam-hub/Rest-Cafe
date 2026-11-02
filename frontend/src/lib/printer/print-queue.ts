/**
 * Frontend pending-print queue (F-009, WebUSB and unreachable-backend leg).
 *
 * When a KOT or receipt print fails in the renderer — the backend request
 * never answered (timeout, dropped Wi-Fi), or the WebUSB dispatch itself
 * failed — the job is stored here (localStorage, same pattern as the cart
 * draft) and the POS retries it while the till is open. A failure the
 * backend itself answered (502) is already queued server-side in
 * `print_jobs`, so the renderer only queues what the backend could not
 * have seen.
 *
 * A retry re-runs the same print functions, which re-resolve the transport
 * and re-read the order, so a job retried after a printer was configured
 * goes through the backend, and the F-004 marker keeps a retried ticket
 * from duplicating. Printing stays post-commit and non-fatal: the queue
 * only ever re-runs a print that was already requested.
 *
 * Browser-print failures are deliberately not queued: the dialog's outcome
 * is unknowable and a timer-driven retry would only open another popup.
 * The toast at failure time stays the signal for those.
 */

/** localStorage key for pending print jobs. */
export const PENDING_PRINT_JOBS_STORAGE_KEY = 'flocafe:pending-print-jobs';

export type PendingPrintJobKind = 'kot' | 'receipt';

export interface PendingPrintJob {
  id: string;
  kind: PendingPrintJobKind;
  orderId: number;
  billId?: number;
  /** KOT: only these item ids are candidates (absent = all unprinted pending items). */
  itemIds?: number[];
  stationName?: string;
  isReprint?: boolean;
  attempts: number;
  /** Epoch ms: the job is due for a retry at or after this time. */
  nextRetryAt: number;
  createdAt: number;
  lastError?: string;
  /** True once the attempt cap is reached; the drain leaves it alone. */
  exhausted?: boolean;
}

/** A job stops being retried after this many failed attempts; the row stays as the record. */
export const PENDING_PRINT_JOB_MAX_ATTEMPTS = 5;

/** Backoff between attempts: 30s, 2m, 5m, 10m, then 15m. */
export function pendingPrintJobRetryDelayMs(attempts: number): number {
  const delays = [30_000, 120_000, 300_000, 600_000, 900_000];
  return delays[Math.min(Math.max(attempts - 1, 0), delays.length - 1)];
}

export interface PendingPrintJobStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
}

function createMemoryPrintJobStorage(): PendingPrintJobStorage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
  };
}

let memoryPrintJobStorage: PendingPrintJobStorage | null = null;

/** localStorage when the renderer offers it, else one shared in-memory store
 * (tests, SSR prerender, restricted renderers). The factory never throws. */
export function createPendingPrintJobStorage(): PendingPrintJobStorage {
  try {
    const candidate = (globalThis as { localStorage?: unknown }).localStorage as
      | PendingPrintJobStorage
      | undefined;
    if (
      candidate &&
      typeof candidate.getItem === 'function' &&
      typeof candidate.setItem === 'function' &&
      typeof candidate.removeItem === 'function'
    ) {
      candidate.getItem(PENDING_PRINT_JOBS_STORAGE_KEY);
      return candidate;
    }
  } catch {
    // A denied probe means the renderer storage is unusable; fall through.
  }
  memoryPrintJobStorage ??= createMemoryPrintJobStorage();
  return memoryPrintJobStorage;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function asNumberArray(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const ids = value.filter(
    (entry): entry is number => typeof entry === 'number' && Number.isSafeInteger(entry),
  );
  return ids.length > 0 ? ids : undefined;
}

/** Read a stored job back, or null when it is not a usable job. Damaged rows are dropped. */
export function parsePendingPrintJob(value: unknown): PendingPrintJob | null {
  if (!isRecord(value)) return null;
  if (value.kind !== 'kot' && value.kind !== 'receipt') return null;
  if (typeof value.orderId !== 'number' || !Number.isSafeInteger(value.orderId)) return null;
  const orderId = value.orderId;
  if (value.kind === 'receipt') {
    if (typeof value.billId !== 'number' || !Number.isSafeInteger(value.billId)) return null;
  }
  if (
    typeof value.attempts !== 'number' ||
    typeof value.nextRetryAt !== 'number' ||
    typeof value.createdAt !== 'number'
  ) {
    return null;
  }
  const attempts = value.attempts;
  const nextRetryAt = value.nextRetryAt;
  const createdAt = value.createdAt;
  if (!Number.isFinite(attempts) || attempts < 0) return null;
  if (!Number.isFinite(nextRetryAt) || !Number.isFinite(createdAt)) return null;
  return {
    id: typeof value.id === 'string' && value.id ? value.id : '',
    kind: value.kind,
    orderId,
    ...(value.kind === 'receipt' ? { billId: Number(value.billId) } : {}),
    ...(asNumberArray(value.itemIds) ? { itemIds: asNumberArray(value.itemIds) } : {}),
    ...(typeof value.stationName === 'string' && value.stationName
      ? { stationName: value.stationName }
      : {}),
    ...(typeof value.isReprint === 'boolean' ? { isReprint: value.isReprint } : {}),
    attempts: Math.floor(attempts),
    nextRetryAt,
    createdAt,
    ...(typeof value.lastError === 'string' ? { lastError: value.lastError } : {}),
    ...(value.exhausted === true ? { exhausted: true } : {}),
  };
}

export function loadPendingPrintJobs(
  storage: PendingPrintJobStorage = createPendingPrintJobStorage(),
): PendingPrintJob[] {
  try {
    const raw = storage.getItem(PENDING_PRINT_JOBS_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const jobs: PendingPrintJob[] = [];
    for (const entry of parsed) {
      const job = parsePendingPrintJob(entry);
      if (job && job.id) jobs.push(job);
    }
    return jobs;
  } catch {
    return [];
  }
}

export function savePendingPrintJobs(
  jobs: PendingPrintJob[],
  storage: PendingPrintJobStorage = createPendingPrintJobStorage(),
): void {
  try {
    storage.setItem(PENDING_PRINT_JOBS_STORAGE_KEY, JSON.stringify(jobs));
  } catch {
    // A denied write must never break the sale; the job is lost with the toast as the signal.
  }
}

function pendingPrintJobKey(
  job: Pick<PendingPrintJob, 'kind' | 'orderId' | 'billId' | 'itemIds'>,
): string {
  return JSON.stringify([
    job.kind,
    job.orderId,
    job.billId ?? null,
    job.itemIds ? [...job.itemIds].sort((a, b) => a - b) : null,
  ]);
}

export type NewPendingPrintJob = Omit<
  PendingPrintJob,
  'id' | 'attempts' | 'nextRetryAt' | 'createdAt'
>;

/**
 * Queues a failed print for automatic retry. An identical job that is
 * already queued (and not exhausted) is not duplicated. Returns the job
 * and whether it was newly created.
 */
export function enqueuePendingPrintJob(
  input: NewPendingPrintJob,
  nowMs: number = Date.now(),
  storage: PendingPrintJobStorage = createPendingPrintJobStorage(),
): { job: PendingPrintJob; created: boolean } {
  const jobs = loadPendingPrintJobs(storage);
  const key = pendingPrintJobKey(input);
  const existing = jobs.find((job) => !job.exhausted && pendingPrintJobKey(job) === key);
  if (existing) return { job: existing, created: false };
  const job: PendingPrintJob = {
    ...input,
    id: `${nowMs}-${Math.floor(Math.random() * 1_000_000)}`,
    attempts: 0,
    nextRetryAt: nowMs + pendingPrintJobRetryDelayMs(1),
    createdAt: nowMs,
  };
  jobs.push(job);
  savePendingPrintJobs(jobs, storage);
  return { job, created: true };
}

export function removePendingPrintJob(
  id: string,
  storage: PendingPrintJobStorage = createPendingPrintJobStorage(),
): void {
  savePendingPrintJobs(
    loadPendingPrintJobs(storage).filter((job) => job.id !== id),
    storage,
  );
}

/** Jobs due for a retry now: not exhausted and past their next-retry time, oldest first. */
export function duePendingPrintJobs(
  nowMs: number = Date.now(),
  storage: PendingPrintJobStorage = createPendingPrintJobStorage(),
): PendingPrintJob[] {
  return loadPendingPrintJobs(storage)
    .filter((job) => !job.exhausted && job.nextRetryAt <= nowMs)
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}

/**
 * Records a failed retry attempt. The job goes back in the queue with its
 * next retry time pushed out by the backoff, until the attempt cap is
 * reached, after which it is marked exhausted and the drain leaves it
 * alone (the operator's manual reprint still works).
 */
export function markPendingPrintJobFailed(
  id: string,
  error: string,
  nowMs: number = Date.now(),
  storage: PendingPrintJobStorage = createPendingPrintJobStorage(),
): void {
  const jobs = loadPendingPrintJobs(storage);
  const job = jobs.find((entry) => entry.id === id);
  if (!job) return;
  job.attempts += 1;
  job.lastError = error;
  if (job.attempts >= PENDING_PRINT_JOB_MAX_ATTEMPTS) {
    job.exhausted = true;
  } else {
    job.nextRetryAt = nowMs + pendingPrintJobRetryDelayMs(job.attempts);
  }
  savePendingPrintJobs(jobs, storage);
}
