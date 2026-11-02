/**
 * Delivery 4 (assignment 037): tablet host re-discovery (F-030).
 *
 * Pins the client-side fallback that runs when a tablet's stored host
 * address stops answering:
 * - `flo.local` on the same port is tried first, then cached pairing hosts
 * - loopback origins never rediscover (the server is down, not moved)
 * - any HTTP answer — even a 503 — proves the host is there; only a
 *   transport failure counts as unreachable
 * - the first reachable candidate wins; a dead candidate never aborts the
 *   search; no candidate means null, not a redirect
 * - the redirect wrapper is single-flight and bounded per session, so a
 *   genuinely down host cannot ping-pong the browser
 *
 * The React wiring (api.ts interceptor) is covered by lint, tsc and
 * build:frontend; this suite pins the helpers it calls.
 *
 * Run: npm run test:host-rediscovery
 */

const { assertOrThrow, assertEqualOrThrow, getResults } = require('./helpers/test-setup');

const {
  REDISCOVERY_REDIRECTS_SESSION_KEY,
  buildRediscoveryCandidates,
  cacheHostCandidates,
  getCachedHostCandidates,
  probeHostOrigin,
  attemptHostRediscovery,
  attemptHostRediscoveryOnce,
} = require('../frontend/src/lib/host-rediscovery');

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => (map.has(key) ? map.get(key)! : null),
    setItem: (key: string, value: string) => {
      map.set(key, String(value));
    },
    removeItem: (key: string) => {
      map.delete(key);
    },
  };
}

function installBrowserStubs(origin: string) {
  const assigned: string[] = [];
  (globalThis as any).window = {
    location: {
      origin,
      pathname: '/pos',
      search: '',
      assign: (url: string) => {
        assigned.push(url);
      },
    },
  };
  (globalThis as any).localStorage = memoryStorage();
  (globalThis as any).sessionStorage = memoryStorage();
  return { assigned };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function main(): Promise<void> {
  installBrowserStubs('http://192.168.1.10:3001');

  // 1. Candidates: flo.local first on the same port, then cached hosts.
  assertEqualOrThrow(
    JSON.stringify(buildRediscoveryCandidates('http://192.168.1.10:3001')),
    JSON.stringify(['http://flo.local:3001']),
    'flo.local on the same port is the first candidate',
  );
  cacheHostCandidates(['http://192.168.1.20:3001', 'http://192.168.1.30:3002']);
  assertEqualOrThrow(
    JSON.stringify(buildRediscoveryCandidates('http://192.168.1.10:3001')),
    JSON.stringify([
      'http://flo.local:3001',
      'http://192.168.1.20:3001',
      'http://192.168.1.30:3002',
    ]),
    'cached pairing hosts follow flo.local, in cached order',
  );
  assertEqualOrThrow(
    JSON.stringify(buildRediscoveryCandidates('http://flo.local:3001')),
    JSON.stringify(['http://192.168.1.20:3001', 'http://192.168.1.30:3002']),
    'the current origin is never its own candidate',
  );

  // 2. Loopback origins never rediscover: the server is down, not moved.
  assertEqualOrThrow(
    JSON.stringify(buildRediscoveryCandidates('http://localhost:3001')),
    JSON.stringify([]),
    'localhost has no re-discovery candidates',
  );
  assertEqualOrThrow(
    JSON.stringify(buildRediscoveryCandidates('http://127.0.0.1:3001')),
    JSON.stringify([]),
    '127.0.0.1 has no re-discovery candidates',
  );
  assertEqualOrThrow(
    JSON.stringify(buildRediscoveryCandidates('not a url')),
    JSON.stringify([]),
    'an unparseable origin has no candidates',
  );

  // 3. The candidate cache keeps valid origins, drops junk, caps at 8.
  (globalThis as any).localStorage = memoryStorage();
  cacheHostCandidates(['notaurl', 'ftp://example.com', 'http://10.0.0.5:3001']);
  assertEqualOrThrow(
    JSON.stringify(getCachedHostCandidates()),
    JSON.stringify(['http://10.0.0.5:3001']),
    'only http(s) origins survive the cache',
  );
  cacheHostCandidates(Array.from({ length: 12 }, (_, i) => `http://10.0.0.${i + 1}:3001`));
  assertEqualOrThrow(
    getCachedHostCandidates().length,
    8,
    'the candidate cache caps at eight origins',
  );
  assertOrThrow(
    !getCachedHostCandidates().includes('http://10.0.0.9:3001'),
    'the ninth origin is capped out of the cache',
  );

  // 4. Probing: any HTTP answer proves the host is there; only a
  //    transport failure (or an aborted probe) counts as unreachable.
  const okFetch = () => Promise.resolve({ ok: true, status: 200 });
  assertOrThrow(
    await probeHostOrigin('http://flo.local:3001', okFetch as any, 1000),
    'a 200 answer proves the host is reachable',
  );
  const sickFetch = () => Promise.resolve({ ok: false, status: 503 });
  assertOrThrow(
    await probeHostOrigin('http://flo.local:3001', sickFetch as any, 1000),
    'even a 503 proves the host is there (a database flag is not a missing host)',
  );
  const deadFetch = () => Promise.reject(new Error('connection refused'));
  assertOrThrow(
    !(await probeHostOrigin('http://flo.local:3001', deadFetch as any, 1000)),
    'a refused connection is unreachable',
  );
  const hangingFetch = (_url: string, init?: { signal?: AbortSignal }) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    });
  assertOrThrow(
    !(await probeHostOrigin('http://flo.local:3001', hangingFetch as any, 20)),
    'a probe that never answers times out as unreachable',
  );

  // 5. Re-discovery returns the first reachable candidate and skips dead ones.
  (globalThis as any).localStorage = memoryStorage();
  cacheHostCandidates(['http://192.168.1.20:3001']);
  const probeByOrigin = async (origin: string) => origin !== 'http://flo.local:3001';
  assertEqualOrThrow(
    await attemptHostRediscovery('http://192.168.1.10:3001', probeByOrigin),
    'http://192.168.1.20:3001',
    'a dead flo.local falls through to the cached host',
  );
  assertEqualOrThrow(
    await attemptHostRediscovery('http://192.168.1.10:3001', async () => false),
    null,
    'no reachable candidate means null, not a redirect',
  );
  const throwingProbe = async (origin: string) => {
    if (origin === 'http://flo.local:3001') throw new Error('dns exploded');
    return true;
  };
  assertEqualOrThrow(
    await attemptHostRediscovery('http://192.168.1.10:3001', throwingProbe),
    'http://192.168.1.20:3001',
    'a throwing probe is a dead candidate, not a failed re-discovery',
  );

  // 6. The redirect wrapper navigates to the first reachable host and is
  //    bounded per session so a down host cannot ping-pong the browser.
  const stubs = installBrowserStubs('http://192.168.1.10:3001');
  (globalThis as any).fetch = (url: string) =>
    url.startsWith('http://flo.local:3001/')
      ? Promise.resolve({ ok: true, status: 200 })
      : Promise.reject(new Error('unreachable'));
  for (let round = 0; round < 3; round++) {
    attemptHostRediscoveryOnce();
    await delay(50);
  }
  assertEqualOrThrow(
    stubs.assigned.length,
    3,
    'three re-discovery redirects happen inside the per-session budget',
  );
  assertOrThrow(
    stubs.assigned.every((url) => url === 'http://flo.local:3001/pos'),
    'each redirect keeps the tablet on the same page at the new host',
  );
  attemptHostRediscoveryOnce();
  await delay(50);
  assertEqualOrThrow(
    stubs.assigned.length,
    3,
    'a fourth redirect in the same session is refused (loop guard)',
  );
  assertEqualOrThrow(
    (globalThis as any).sessionStorage.getItem(REDISCOVERY_REDIRECTS_SESSION_KEY),
    '3',
    'the session redirect budget is recorded',
  );

  // 7. No redirect when there is nothing to rediscover to.
  const loopbackStubs = installBrowserStubs('http://localhost:3001');
  (globalThis as any).fetch = () => Promise.reject(new Error('unreachable'));
  attemptHostRediscoveryOnce();
  await delay(50);
  assertEqualOrThrow(
    loopbackStubs.assigned.length,
    0,
    'a loopback origin never redirects (the server is down, not moved)',
  );

  const results = getResults();
  console.log(`\nhost-rediscovery: ${results.passed} passed, ${results.failed} failed`);
  if (results.failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
