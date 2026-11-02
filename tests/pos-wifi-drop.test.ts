/**
 * Delivery 2 (assignment 037): the POS survives a Wi-Fi drop.
 *
 * Pins the contracts behind F-003, F-011, F-012, F-014 and F-028:
 * - F-003: the shared API client times out at the KDS poll ceiling (10 s),
 *   and requests that await a physical print dispatch keep a longer ceiling.
 * - F-011: the in-progress cart persists as a draft (pos-settings pattern)
 *   and restores after a reload, including waived/opted-in charge decisions.
 * - F-012: a transient catalog failure is retryable, and the retry schedule
 *   follows the KDS enabled-check (12 tries, 5 s apart).
 * - F-014: the offline indicator is driven by real request outcomes: a
 *   transport failure (or 5xx) is transient, a 4xx answer is definitive.
 * - F-028: a stored postpaid attempt for a different cart than the one in
 *   front of the cashier is stale and must be surfaced; the helpers never
 *   touch the attempt's idempotency key, so duplicate prevention is unchanged.
 *
 * The React retry loop itself (usePosCatalog) and the mount surfacing
 * (usePosOrderSubmission) are exercised through these same helpers and
 * constants; the hook wiring is covered by lint, tsc and build:frontend.
 *
 * Run: npm run test:pos-wifi-drop
 */

const path = require('node:path');

const Module = require('module');
const {
  assertOrThrow,
  assertEqualOrThrow,
  assertIncludesOrThrow,
  getResults,
} = require('./helpers/test-setup');

const ROOT = path.join(__dirname, '..');
const frontendRequire = Module.createRequire(path.join(ROOT, 'frontend/package.json'));
const moduleApi = require('module') as {
  _resolveFilename: (...args: any[]) => string;
  _load: (...args: any[]) => any;
};
const originalResolveFilename = moduleApi._resolveFilename;
const zustandPath = frontendRequire.resolve('zustand');
moduleApi._resolveFilename = function (request: string, parent: any, isMain: boolean, options?: any) {
  let resolvedRequest = request;
  if (request === 'zustand') resolvedRequest = zustandPath;
  else if (request.startsWith('@/')) resolvedRequest = path.resolve(ROOT, 'frontend/src', request.slice(2));
  else if (request.startsWith('@print/')) resolvedRequest = path.resolve(ROOT, 'shared/print', request.slice(7));
  else if (request.startsWith('@shared/')) resolvedRequest = path.resolve(ROOT, 'shared', request.slice(8));
  else if (request === '@countries') resolvedRequest = path.resolve(ROOT, 'main/countries.ts');
  return originalResolveFilename.call(this, resolvedRequest, parent, isMain, options);
};

class MemoryStorage {
  values = new Map();

  getItem(key: string) {
    return this.values.has(key) ? this.values.get(key) : null;
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }

  removeItem(key: string) {
    this.values.delete(key);
  }
}

// The cart store resolves its draft storage lazily, so installing the fake
// localStorage before any cart mutation routes persistence through it.
const draftStorage = new MemoryStorage();
(globalThis as any).localStorage = draftStorage;

const apiModule = require('../frontend/src/lib/api');
const api = apiModule.default;
const {
  API_REQUEST_TIMEOUT_MS,
  LONG_API_REQUEST_TIMEOUT_MS,
  isTransientRequestError,
} = apiModule;
const {
  CART_DRAFT_STORAGE_KEY,
  parseCartDraft,
  serializeCartDraft,
} = require('../frontend/src/lib/cart-draft');
const { useCartStore } = require('../frontend/src/store/cart');
const {
  describePostpaidAttempt,
  isStalePostpaidAttempt,
} = require('../frontend/src/lib/pos/order-attempts');
const {
  POS_CATALOG_RETRY_ATTEMPTS,
  POS_CATALOG_RETRY_DELAY_MS,
} = require('../frontend/src/hooks/usePosCatalog');

function product(overrides: Record<string, unknown> = {}) {
  return {
    id: 'prod-1',
    category_id: null,
    name: 'Americano',
    sku: null,
    barcode: null,
    sale_unit: 'each',
    allow_fractional_quantity: false,
    weight_precision: 3,
    description: null,
    price: 3,
    cost_price: null,
    tax_type: 'none',
    tax_rate: 0,
    track_inventory: true,
    stock_quantity: 10,
    low_stock_threshold: null,
    is_active: true,
    available_online: false,
    has_image: false,
    updated_at: '',
    tags: null,
    variants: null,
    modifiers: null,
    sort_order: 0,
    ...overrides,
  };
}

function draftSource(overrides: Record<string, unknown> = {}) {
  return {
    items: [],
    orderType: 'dine_in',
    tableId: null,
    heldOrderId: null,
    customerId: null,
    customer: null,
    customerSource: null,
    guestCount: 1,
    deliveryAddress: '',
    expectedPaymentMethod: '',
    expectedPaymentMethodId: null,
    deliveryNote: '',
    onlinePlatform: '',
    externalOrderId: '',
    orderNotes: '',
    waivedChargeIds: new Set<string>(),
    optedInChargeIds: new Set<string>(),
    ...overrides,
  };
}

async function main() {
  const cart = () => useCartStore.getState();

  // ── F-003: request timeout ──────────────────────────────────────────────
  assertEqualOrThrow(
    API_REQUEST_TIMEOUT_MS,
    10_000,
    'shared API client timeout matches the KDS poll ceiling (10 s)',
  );
  assertEqualOrThrow(
    api.defaults.timeout,
    10_000,
    'the created axios instance carries the 10 s timeout',
  );
  assertEqualOrThrow(
    LONG_API_REQUEST_TIMEOUT_MS,
    30_000,
    'print dispatch keeps a longer ceiling (backend CUPS dispatch allows 20 s)',
  );
  assertOrThrow(
    LONG_API_REQUEST_TIMEOUT_MS > API_REQUEST_TIMEOUT_MS,
    'the print ceiling is strictly longer than the shared default',
  );

  // ── F-012/F-014: transient failures are retryable, definitive ones are not ──
  assertOrThrow(
    isTransientRequestError({ code: 'ECONNABORTED' }),
    'a timeout with no response is transient',
  );
  assertOrThrow(
    isTransientRequestError({ code: 'ECONNREFUSED' }),
    'a refused connection with no response is transient',
  );
  assertOrThrow(
    isTransientRequestError({ response: { status: 500 } }),
    'a 500 is transient',
  );
  assertOrThrow(
    isTransientRequestError({ response: { status: 503 } }),
    'a 503 is transient',
  );
  assertOrThrow(
    !isTransientRequestError({ response: { status: 400 } }),
    'a 400 is definitive and must fail fast',
  );
  assertOrThrow(
    !isTransientRequestError({ response: { status: 401 } }),
    'a 401 is definitive and must fail fast',
  );
  assertOrThrow(
    !isTransientRequestError({ response: { status: 404 } }),
    'a 404 is definitive and must fail fast',
  );

  // ── F-012: catalog retry schedule follows the KDS enabled-check ────────
  assertEqualOrThrow(
    POS_CATALOG_RETRY_ATTEMPTS,
    12,
    'catalog load retries 12 times like the KDS enabled-check',
  );
  assertEqualOrThrow(
    POS_CATALOG_RETRY_DELAY_MS,
    5000,
    'catalog load retries every 5 s like the KDS enabled-check',
  );

  // ── F-011: cart draft serialize/parse ───────────────────────────────────
  const filled = draftSource({
    items: [
      {
        id: 'line-1',
        product: product(),
        quantity: 2,
        addons: [],
        special_instructions: '',
        variant: null,
      },
    ],
    tableId: 't-7',
    orderNotes: 'no sugar',
    waivedChargeIds: new Set(['service_charge']),
    optedInChargeIds: new Set(['optional_packing']),
  });
  const serialized = serializeCartDraft(filled);
  assertEqualOrThrow(serialized.items.length, 1, 'draft keeps the cart lines');
  assertEqualOrThrow(serialized.tableId, 't-7', 'draft keeps the table');
  assertEqualOrThrow(serialized.orderNotes, 'no sugar', 'draft keeps the order notes');
  assertEqualOrThrow(
    JSON.stringify(serialized.waivedChargeIds),
    JSON.stringify(['service_charge']),
    'charge decisions persist as plain arrays, not Sets',
  );
  assertOrThrow(
    !('addItem' in serialized) && !('subtotal' in serialized),
    'only draft fields persist, never actions or derived values',
  );
  const roundTripped = parseCartDraft(JSON.parse(JSON.stringify(serialized)));
  assertOrThrow(roundTripped !== null, 'a serialized draft parses back');
  assertEqualOrThrow(roundTripped!.items.length, 1, 'round trip keeps the lines');
  assertEqualOrThrow(roundTripped!.tableId, 't-7', 'round trip keeps the table');
  assertEqualOrThrow(
    JSON.stringify(roundTripped!.waivedChargeIds),
    JSON.stringify(['service_charge']),
    'round trip keeps the waived charges',
  );
  assertEqualOrThrow(
    JSON.stringify(roundTripped!.optedInChargeIds),
    JSON.stringify(['optional_packing']),
    'round trip keeps the opted-in charges',
  );

  // Damaged drafts restore nothing rather than a half cart.
  assertEqualOrThrow(parseCartDraft(null), null, 'null is not a draft');
  assertEqualOrThrow(parseCartDraft('nope'), null, 'a string is not a draft');
  assertEqualOrThrow(parseCartDraft({}), null, 'a draft without items is not a draft');
  assertEqualOrThrow(
    parseCartDraft({ items: 'nope' }),
    null,
    'a draft with non-array items is not a draft',
  );
  const damaged = parseCartDraft({
    items: [
      { id: 'bad-1', quantity: 1, addons: [] },
      { id: 'bad-2', product: { name: 'No id' }, quantity: 1, addons: [] },
      { id: 'bad-3', product: product(), quantity: 0, addons: [] },
      { id: 'good-1', product: product({ id: 'prod-2' }), quantity: 1, addons: [] },
    ],
    orderType: 'bogus',
    guestCount: -4,
  });
  assertOrThrow(damaged !== null, 'a draft with some bad lines still parses');
  assertEqualOrThrow(damaged!.items.length, 1, 'lines without a product or quantity are dropped');
  assertEqualOrThrow(damaged!.orderType, 'dine_in', 'an unknown order type falls back to dine-in');
  assertEqualOrThrow(damaged!.guestCount, 1, 'an invalid guest count falls back to 1');

  // ── F-011: the live store persists and restores the draft ──────────────
  cart().clearCart();
  cart().addItem(product(), 2);
  cart().setTableId('t-7');
  cart().toggleWaiveCharge('service_charge');
  const storedRaw = draftStorage.getItem(CART_DRAFT_STORAGE_KEY);
  assertOrThrow(storedRaw !== null, 'adding to the cart writes the draft to storage');
  const stored = JSON.parse(storedRaw!);
  assertEqualOrThrow(stored.state.items.length, 1, 'stored draft holds the cart line');
  assertEqualOrThrow(stored.state.tableId, 't-7', 'stored draft holds the table');
  assertEqualOrThrow(
    JSON.stringify(stored.state.waivedChargeIds),
    JSON.stringify(['service_charge']),
    'stored draft holds the waived charge',
  );
  // Simulate a reload: wipe the live cart (which persists the empty draft),
  // put the saved draft back, and rehydrate.
  cart().clearCart();
  assertEqualOrThrow(cart().items.length, 0, 'clearCart empties the live cart');
  draftStorage.setItem(CART_DRAFT_STORAGE_KEY, storedRaw!);
  await useCartStore.persist.rehydrate();
  assertEqualOrThrow(cart().items.length, 1, 'rehydration restores the cart lines');
  assertEqualOrThrow(cart().items[0].quantity, 2, 'rehydration restores the quantity');
  assertEqualOrThrow(cart().tableId, 't-7', 'rehydration restores the table');
  assertOrThrow(
    cart().waivedChargeIds.has('service_charge'),
    'rehydration restores the waived charge as a Set',
  );
  cart().clearCart();
  const clearedRaw = draftStorage.getItem(CART_DRAFT_STORAGE_KEY);
  assertEqualOrThrow(
    JSON.parse(clearedRaw!).state.items.length,
    0,
    'placing/clearing the order clears the persisted draft',
  );

  // ── F-028: stale postpaid attempts ─────────────────────────────────────
  const fingerprint = JSON.stringify({
    table_id: 't-7',
    customer_id: null,
    type: 'dine_in',
    guest_count: 2,
    items: [
      { product_id: 'prod-1', quantity: 1 },
      { product_id: 'prod-2', quantity: 3 },
    ],
  });
  const staleAttempt = {
    userId: 'user-1',
    fingerprint,
    idempotencyKey: 'key-abc',
    operationId: 'op-1',
  };
  const described = describePostpaidAttempt(staleAttempt);
  assertEqualOrThrow(described.itemCount, 2, 'stale attempt reports its item count');
  assertEqualOrThrow(described.tableId, 't-7', 'stale attempt reports its table');
  assertEqualOrThrow(described.orderNumber, null, 'an unconfirmed attempt has no order number');
  const confirmedAttempt = {
    ...staleAttempt,
    order: { order_number: '1042' },
  };
  assertEqualOrThrow(
    describePostpaidAttempt(confirmedAttempt).orderNumber,
    '1042',
    'a confirmed attempt reports its order number',
  );
  assertEqualOrThrow(
    describePostpaidAttempt({ ...staleAttempt, fingerprint: '{broken' }).itemCount,
    null,
    'an unparsable fingerprint reports no item count instead of throwing',
  );
  assertOrThrow(
    !isStalePostpaidAttempt(staleAttempt, fingerprint),
    'an attempt for the current cart is the live retry, not stale',
  );
  assertOrThrow(
    isStalePostpaidAttempt(staleAttempt, JSON.stringify({ table_id: 't-9', items: [] })),
    'an attempt for a different cart is stale',
  );
  assertOrThrow(
    isStalePostpaidAttempt(staleAttempt, ''),
    'an attempt is stale against an empty cart',
  );
  const before = JSON.stringify(staleAttempt);
  describePostpaidAttempt(staleAttempt);
  isStalePostpaidAttempt(staleAttempt, 'other');
  assertEqualOrThrow(
    JSON.stringify(staleAttempt),
    before,
    'describing or classifying an attempt never mutates it (the key stays intact)',
  );
  assertIncludesOrThrow(
    JSON.stringify(staleAttempt),
    'key-abc',
    'the idempotency key survives the stale-attempt helpers untouched',
  );

  const results = getResults();
  console.log(`\npos-wifi-drop: ${results.passed} passed, ${results.failed} failed`);
  if (results.failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
