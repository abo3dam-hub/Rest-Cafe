/**
 * Client-side host re-discovery (F-030).
 *
 * A tablet bookmarks the host's LAN address. If DHCP reassigns the host IP,
 * the bookmarked origin stops answering while the page is still open. Before
 * declaring failure, the client re-discovers the host: it probes
 * `flo.local` on the same port (the stable mDNS name, which does not move
 * with DHCP) and then the pairing host candidates cached from the last
 * successful pairing-info fetch. Pairing itself is unchanged.
 *
 * The pure helpers (candidate building, probing) are covered by
 * tests/host-rediscovery.test.ts; the redirect wrapper is thin by design.
 */

export const HOST_CANDIDATES_STORAGE_KEY = 'flo:host-candidates';
export const REDISCOVERY_REDIRECTS_SESSION_KEY = 'flo:rediscovery-redirects';
export const HOST_PROBE_TIMEOUT_MS = 3000;
const MAX_CACHED_CANDIDATES = 8;
const MAX_REDISCOVERY_REDIRECTS_PER_SESSION = 3;

function isHttpOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Origins the pairing-info endpoints returned (`ips_data[].url`), kept so a
 * tablet that was once paired can try them again after the host address
 * moves. Best effort: storage may be unavailable and entries go stale. */
export function cacheHostCandidates(origins: string[]): void {
  if (typeof window === 'undefined' || typeof localStorage === 'undefined') return;
  try {
    const previous = getCachedHostCandidates();
    const merged: string[] = [];
    for (const origin of [...origins, ...previous]) {
      if (isHttpOrigin(origin) && !merged.includes(origin)) merged.push(origin);
      if (merged.length >= MAX_CACHED_CANDIDATES) break;
    }
    localStorage.setItem(HOST_CANDIDATES_STORAGE_KEY, JSON.stringify(merged));
  } catch {
    // Storage unavailable: re-discovery just has fewer candidates.
  }
}

export function getCachedHostCandidates(): string[] {
  if (typeof window === 'undefined' || typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(HOST_CANDIDATES_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is string => typeof entry === 'string' && isHttpOrigin(entry),
    );
  } catch {
    return [];
  }
}

/**
 * Ordered re-discovery candidates for `currentOrigin`: `flo.local` on the
 * same port first, then cached pairing hosts. Empty when the current origin
 * is loopback (the host's own window: a failure there means the server is
 * down, not moved) or unparseable.
 */
export function buildRediscoveryCandidates(currentOrigin: string): string[] {
  let current: URL;
  try {
    current = new URL(currentOrigin);
  } catch {
    return [];
  }
  const hostname = current.hostname.toLowerCase();
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') return [];
  const candidates: string[] = [];
  const port = current.port || (current.protocol === 'https:' ? '443' : '3001');
  const mdnsOrigin = `${current.protocol}//flo.local:${port}`;
  if (mdnsOrigin !== currentOrigin) candidates.push(mdnsOrigin);
  for (const cached of getCachedHostCandidates()) {
    if (cached !== currentOrigin && !candidates.includes(cached)) candidates.push(cached);
  }
  return candidates;
}

/** True when the origin answers `/api/health` at all — even a 503 proves
 * the host is there (a database flag is not a missing host). */
export async function probeHostOrigin(
  origin: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs: number = HOST_PROBE_TIMEOUT_MS,
): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      await fetchImpl(`${origin}/api/health`, { signal: controller.signal, cache: 'no-store' });
      return true;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return false;
  }
}

/** First reachable re-discovery candidate for `currentOrigin`, or null when
 * none answers. Never throws. */
export async function attemptHostRediscovery(
  currentOrigin: string,
  probe: (origin: string) => Promise<boolean> = probeHostOrigin,
): Promise<string | null> {
  for (const candidate of buildRediscoveryCandidates(currentOrigin)) {
    try {
      if (await probe(candidate)) return candidate;
    } catch {
      // A failing probe is a dead candidate, not a failed re-discovery.
    }
  }
  return null;
}

let rediscoveryInFlight: Promise<string | null> | null = null;

/**
 * Single-flight re-discovery triggered when the API becomes unreachable:
 * probe the candidates and, when one answers, navigate the tablet to it
 * (same path). Bounded to a few redirects per session so a host that is
 * genuinely down cannot ping-pong the browser between dead origins.
 */
export function attemptHostRediscoveryOnce(): void {
  if (typeof window === 'undefined') return;
  if (rediscoveryInFlight) return;
  const currentOrigin = window.location.origin;
  if (buildRediscoveryCandidates(currentOrigin).length === 0) return;
  let redirects = 0;
  try {
    redirects = Number(sessionStorage.getItem(REDISCOVERY_REDIRECTS_SESSION_KEY) ?? '0') || 0;
  } catch {
    redirects = 0;
  }
  if (redirects >= MAX_REDISCOVERY_REDIRECTS_PER_SESSION) return;
  rediscoveryInFlight = attemptHostRediscovery(currentOrigin)
    .then((found) => {
      if (!found || found === currentOrigin) return null;
      try {
        sessionStorage.setItem(REDISCOVERY_REDIRECTS_SESSION_KEY, String(redirects + 1));
      } catch {
        // Storage unavailable: the redirect still happens.
      }
      window.location.assign(`${found}${window.location.pathname}${window.location.search}`);
      return found;
    })
    .catch(() => null)
    .finally(() => {
      rediscoveryInFlight = null;
    });
  void rediscoveryInFlight;
}
