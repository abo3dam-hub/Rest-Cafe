'use client';

/**
 * New-order sound engine.
 *
 * Browsers refuse audible playback before the user has interacted with the
 * page, so the chime is generated with WebAudio and the shared AudioContext
 * is created/resumed on the first pointer or keyboard gesture anywhere in
 * the app. playNewOrderChime() is safe to call at any time: while the
 * context is locked (or audio is unavailable entirely) it silently no-ops
 * and callers fall back to the visual alert.
 */

export type AudioMode = 'webaudio' | 'element' | 'none';

const NOTE_A_HZ = 880;
const NOTE_B_HZ = 1318.5;
const NOTE_SECONDS = 0.18;
const CHIME_SECONDS = NOTE_SECONDS * 2 + 0.06;

let sharedContext: AudioContext | null = null;
let unlockRegistered = false;
let wavDataUri: string | null = null;
let fallbackElement: HTMLAudioElement | null = null;

function webAudioConstructor(): typeof AudioContext | null {
  if (typeof window === 'undefined') return null;
  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  return Ctor ?? null;
}

/** Which playback path this browser offers: generated WebAudio, an <audio> element, or none. */
export function getAudioMode(): AudioMode {
  if (typeof window === 'undefined') return 'none';
  if (webAudioConstructor()) return 'webaudio';
  if (typeof window.Audio === 'function') return 'element';
  return 'none';
}

function ensureContext(): AudioContext | null {
  const Ctor = webAudioConstructor();
  if (!Ctor) return null;
  if (!sharedContext) {
    try {
      sharedContext = new Ctor();
    } catch {
      return null;
    }
  }
  return sharedContext;
}

/** True once the shared context exists and is actually allowed to produce sound. */
export function isAudioPrimed(): boolean {
  return sharedContext !== null && sharedContext.state === 'running';
}

/**
 * Create/resume the shared AudioContext. Must be called from (or shortly
 * after) a user gesture for the resume to stick; otherwise it resolves
 * quietly and isAudioPrimed() stays false.
 */
export function primeAudio(): boolean {
  const ctx = ensureContext();
  if (!ctx) return false;
  if (ctx.state === 'suspended') {
    void ctx.resume().catch(() => {});
  }
  return isAudioPrimed();
}

function registerUnlockOnce(): void {
  if (unlockRegistered || typeof window === 'undefined') return;
  unlockRegistered = true;
  const unlock = () => {
    if (primeAudio()) {
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    }
  };
  window.addEventListener('pointerdown', unlock);
  window.addEventListener('keydown', unlock);
}

// Arm the one-time unlock as soon as the module is first used in a browser.
registerUnlockOnce();

function playTone(ctx: AudioContext, frequency: number, startAt: number, duration: number): void {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.value = frequency;
  // Gentle envelope: quick soft attack, smooth decay — pleasant, not alarming.
  gain.gain.setValueAtTime(0.0001, startAt);
  gain.gain.exponentialRampToValueAtTime(0.22, startAt + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, startAt + duration);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(startAt);
  osc.stop(startAt + duration + 0.02);
}

/** Renders the same two-tone chime to a tiny mono WAV data URI (fallback path). */
function buildWavDataUri(): string {
  const sampleRate = 22050;
  const totalSamples = Math.floor(sampleRate * CHIME_SECONDS);
  const pcm = new Int16Array(totalSamples);
  for (let i = 0; i < totalSamples; i++) {
    const t = i / sampleRate;
    const isSecond = t >= NOTE_SECONDS;
    const local = isSecond ? t - NOTE_SECONDS : t;
    const freq = isSecond ? NOTE_B_HZ : NOTE_A_HZ;
    const envelope = Math.min(1, local / 0.02) * Math.exp(-local * 9);
    pcm[i] = Math.round(Math.sin(2 * Math.PI * freq * t) * envelope * 0.22 * 32767);
  }
  const bytes = new Uint8Array(44 + pcm.length * 2);
  const view = new DataView(bytes.buffer);
  const writeAscii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + pcm.length * 2, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(36, 'data');
  view.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) view.setInt16(44 + i * 2, pcm[i], true);
  let binary = '';
  const chunk = 8192;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return `data:audio/wav;base64,${btoa(binary)}`;
}

function playViaElement(): void {
  try {
    if (!wavDataUri) wavDataUri = buildWavDataUri();
    if (!fallbackElement) fallbackElement = new Audio(wavDataUri);
    fallbackElement.currentTime = 0;
    // Without a prior gesture this promise usually rejects — that is the
    // expected locked state, so it is swallowed and the visual alert rules.
    void fallbackElement.play().catch(() => {});
  } catch {
    // No audio path at all — visual-only mode.
  }
}

/**
 * Play the new-order chime. No-ops silently when audio is still locked by
 * the browser's autoplay policy or unavailable on this device.
 */
export function playNewOrderChime(): void {
  if (typeof window === 'undefined') return;
  const ctx = ensureContext();
  if (ctx) {
    if (!isAudioPrimed()) {
      // A stray resume attempt costs nothing; without a gesture it will
      // simply stay suspended and we skip this chime.
      void ctx.resume().catch(() => {});
      if (!isAudioPrimed()) return;
    }
    const start = ctx.currentTime + 0.01;
    playTone(ctx, NOTE_A_HZ, start, NOTE_SECONDS + 0.04);
    playTone(ctx, NOTE_B_HZ, start + NOTE_SECONDS, NOTE_SECONDS + 0.08);
    return;
  }
  if (getAudioMode() === 'element') playViaElement();
}

/* --- Seen-order persistence (F-029) --- */

/** The surfaces whose new-order alerts keep a persisted seen set. */
export type OrderAlertSurface = 'kds' | 'pos';

/** The seen set is capped so a long-lived board never grows the stored array without bound. */
export const SEEN_ORDER_IDS_CAP = 500;

/** localStorage key for the order ids a surface has already seen. */
export function seenOrderIdsStorageKey(surface: OrderAlertSurface): string {
  return `flocafe:order-alert:${surface}:seen-ids`;
}

export interface SeenOrderIdsStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

function resolveSeenOrderIdsStorage(): SeenOrderIdsStorage | null {
  try {
    const candidate = (globalThis as { localStorage?: unknown }).localStorage as
      | SeenOrderIdsStorage
      | undefined;
    if (
      candidate &&
      typeof candidate.getItem === 'function' &&
      typeof candidate.setItem === 'function'
    ) {
      return candidate;
    }
  } catch {
    // No usable storage: the caller treats this as "never persisted".
  }
  return null;
}

/**
 * The order ids a surface had already seen when it last rendered, or null
 * when the surface never persisted a set (a brand-new board). A damaged
 * stored value reads as never-persisted, so the first snapshot seeds
 * silently instead of chiming for the whole board.
 */
export function loadSeenOrderIds(
  surface: OrderAlertSurface,
  storage: SeenOrderIdsStorage | null = resolveSeenOrderIdsStorage(),
): Set<number> | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(seenOrderIdsStorageKey(surface));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    const ids = parsed.filter(
      (entry): entry is number => typeof entry === 'number' && Number.isSafeInteger(entry),
    );
    if (ids.length === 0) return null;
    return new Set(ids.slice(0, SEEN_ORDER_IDS_CAP));
  } catch {
    return null;
  }
}

/** Persists the seen set, keeping only the most recent ids (snapshot order). */
export function saveSeenOrderIds(
  surface: OrderAlertSurface,
  ids: Iterable<number>,
  storage: SeenOrderIdsStorage | null = resolveSeenOrderIdsStorage(),
): void {
  if (!storage) return;
  try {
    const list = Array.from(new Set(ids)).slice(-SEEN_ORDER_IDS_CAP);
    storage.setItem(seenOrderIdsStorageKey(surface), JSON.stringify(list));
  } catch {
    // A denied write only loses the catch-up signal; live alerts still work.
  }
}

/**
 * Splits a snapshot into the orders that are new since the seen set and
 * the updated set (previous ids pruned to the snapshot, plus the fresh
 * ones). Pruning keeps the stored set from growing with orders that left
 * the board.
 */
export function diffNewOrders<T extends { id: number }>(
  orders: readonly T[],
  seen: ReadonlySet<number>,
): { fresh: T[]; nextSeen: Set<number> } {
  const snapshotIds = new Set(orders.map((order) => order.id));
  const fresh = orders.filter((order) => !seen.has(order.id));
  const nextSeen = new Set<number>();
  for (const id of seen) if (snapshotIds.has(id)) nextSeen.add(id);
  for (const order of fresh) nextSeen.add(order.id);
  return { fresh, nextSeen };
}
