import axios from 'axios';
import { attemptHostRediscoveryOnce } from './host-rediscovery';

let authRedirectInProgress = false;

/** Request ceiling for the shared client, matching the KDS REST poll (10 s):
 * a half-open connection fails visibly instead of hanging the till. */
export const API_REQUEST_TIMEOUT_MS = 10_000;
/** Longer ceiling for requests that await a physical print dispatch or a
 * printer scan: the backend CUPS dispatch alone allows 20 s, and printer
 * detection caps at 10 s, so the 10 s default would cut off their reply. */
export const LONG_API_REQUEST_TIMEOUT_MS = 30_000;

/** Last known reachability of the backend, from real request outcomes. */
let apiReachable = typeof navigator === 'undefined' ? true : navigator.onLine !== false;

function reportApiReachability(reachable: boolean): void {
  if (reachable === apiReachable || typeof window === 'undefined') return;
  apiReachable = reachable;
  window.dispatchEvent(new Event(reachable ? 'flo:api-online' : 'flo:api-offline'));
}

/** True when a request failure is worth retrying: no response arrived
 * (transport/timeout/offline) or the server itself failed (5xx). A 4xx
 * answer is definitive — retrying it cannot help. */
export function isTransientRequestError(error: unknown): boolean {
  const response = (error as { response?: { status?: unknown } } | null)?.response;
  if (!response) return true;
  const status = Number(response.status);
  return Number.isInteger(status) && status >= 500;
}

export type ClientFailureOperation =
  | 'order.create'
  | 'payment.create'
  | 'order.append'
  | 'bill.generate';
export type ClientFailurePhase =
  | 'transport'
  | 'recovery'
  | 'retry_storage'
  | 'retry_cleanup'
  | 'retry_state_update'
  | 'held_cleanup';
export type NetworkFailureClass =
  | 'timeout'
  | 'dns'
  | 'connection_refused'
  | 'offline'
  | 'unreachable'
  | 'invalid_response'
  | 'unknown';

export function createOperationReference(): string | null {
  const cryptoApi = globalThis.crypto;
  if (!cryptoApi) return null;
  if (typeof cryptoApi.randomUUID === 'function') return cryptoApi.randomUUID();
  if (typeof cryptoApi.getRandomValues !== 'function') return null;
  const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function operationHeaders(correlationId: string | null | undefined): Record<string, string> {
  return correlationId ? { 'x-operation-id': correlationId } : {};
}

/** Best-effort capture for a frontend-owned failure with a registered safe tuple. */
export async function captureClientOperationFailure(input: {
  operation: ClientFailureOperation;
  phase: ClientFailurePhase;
  correlationId: string | null | undefined;
  failureClass?: NetworkFailureClass;
}): Promise<void> {
  if (!input.correlationId) return;
  const frontendOperation =
    input.operation === 'order.create' ||
    input.operation === 'payment.create' ||
    input.operation === 'order.append';
  const transportPhase = input.phase === 'transport' || input.phase === 'recovery';
  if (transportPhase && !frontendOperation) return;
  if (
    input.phase === 'retry_state_update' &&
    !['order.create', 'payment.create', 'bill.generate'].includes(input.operation)
  )
    return;
  if (
    input.phase === 'held_cleanup' &&
    input.operation !== 'order.create' &&
    input.operation !== 'payment.create'
  )
    return;
  if (
    (input.phase === 'retry_storage' || input.phase === 'retry_cleanup') &&
    !['order.create', 'payment.create', 'order.append'].includes(input.operation)
  )
    return;
  const capturePoint =
    input.phase === 'retry_state_update'
      ? `fc.client.${input.operation}.retry_state_update`
      : `fc.frontend.pos.${input.operation}.${input.phase}`;
  const outcome =
    input.phase === 'retry_storage'
      ? 'not_applied'
      : ['retry_cleanup', 'retry_state_update', 'held_cleanup'].includes(input.phase)
        ? 'applied'
        : 'unknown';
  const captureOutcome = outcome;
  try {
    await api.post('/diagnostics/capture', {
      capture_point: capturePoint,
      outcome: captureOutcome,
      operation_id: input.correlationId,
      ...(input.phase === 'transport'
        ? { facts: { failure_class: input.failureClass || 'unknown' } }
        : {}),
    });
  } catch {
    // Diagnostics must never interrupt or retry a financial request.
  }
}

// Base URL derived from window.location.origin so LAN clients connect to host IP.
const api = axios.create({
  baseURL: typeof window !== 'undefined' ? `${window.location.origin}/api` : '/api',
  timeout: API_REQUEST_TIMEOUT_MS,
  headers: {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  },
});

// Attach JWT token to every request
api.interceptors.request.use((config) => {
  if (typeof window !== 'undefined') {
    const token = localStorage.getItem('token');
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
  }
  return config;
});

// Handle 401 responses
api.interceptors.response.use(
  (response) => {
    reportApiReachability(true);
    return response;
  },
  (error) => {
    // No response arrived at all: the backend is unreachable from here.
    // Before declaring failure, try re-discovery (F-030): the host IP may
    // have moved and flo.local / a cached pairing host may answer.
    if (!error.response) {
      reportApiReachability(false);
      if (typeof window !== 'undefined') attemptHostRediscoveryOnce();
    }
    if (error.response?.status === 401 && typeof window !== 'undefined') {
      // KDS routes render inline login; avoid redirecting away to /auth/login.
      const isKdsPath = window.location.pathname.startsWith('/kds');
      localStorage.removeItem('token');
      if (isKdsPath) return Promise.reject(error);
      // Don't redirect when already on the login page — let the login handler show the error
      if (!window.location.pathname.includes('/auth/login') && !authRedirectInProgress) {
        authRedirectInProgress = true;
        localStorage.removeItem('tenant');
        window.location.assign('/auth/login');
      }
    }
    if (
      error.response?.status === 403 &&
      error.response?.data?.code === 'permission_denied' &&
      typeof window !== 'undefined'
    ) {
      window.dispatchEvent(new Event('flo:authorization-denied'));
    }
    return Promise.reject(error);
  },
);

export default api;
