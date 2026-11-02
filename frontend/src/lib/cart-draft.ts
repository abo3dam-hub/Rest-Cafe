import type { Addon, CartItem, Customer, Product, ProductVariant } from './types';
import { normalizeCartItems } from './cart-identity';

/** localStorage key for the in-progress POS cart draft. */
export const CART_DRAFT_STORAGE_KEY = 'pos-cart-draft';

export type CartDraftOrderType = 'dine_in' | 'takeaway' | 'delivery' | 'online';

const ORDER_TYPES: readonly CartDraftOrderType[] = [
  'dine_in',
  'takeaway',
  'delivery',
  'online',
];

/** The cart draft as persisted: JSON-safe, charge decisions as plain arrays. */
export interface CartDraftState {
  items: CartItem[];
  orderType: CartDraftOrderType;
  tableId: string | null;
  heldOrderId: string | null;
  customerId: number | string | null;
  customer: Customer | null;
  customerSource: 'explicit' | 'reservation' | null;
  guestCount: number;
  deliveryAddress: string;
  expectedPaymentMethod: string;
  expectedPaymentMethodId: number | null;
  deliveryNote: string;
  onlinePlatform: string;
  externalOrderId: string;
  orderNotes: string;
  waivedChargeIds: string[];
  optedInChargeIds: string[];
}

/** The live cart fields a draft is built from (Sets, not arrays). */
export interface CartDraftSource {
  items: CartItem[];
  orderType: CartDraftOrderType;
  tableId: string | null;
  heldOrderId: string | null;
  customerId: number | string | null;
  customer: Customer | null;
  customerSource: 'explicit' | 'reservation' | null;
  guestCount: number;
  deliveryAddress: string;
  expectedPaymentMethod: string;
  expectedPaymentMethodId: number | null;
  deliveryNote: string;
  onlinePlatform: string;
  externalOrderId: string;
  orderNotes: string;
  waivedChargeIds: Set<string>;
  optedInChargeIds: Set<string>;
}

/** A draft is a device-local convenience, never money state: a reload, a 401
 * navigation, or a crash restores the rang-up cart, and placing the order
 * clears it. Held orders stay server-side and are untouched by this. */
export function serializeCartDraft(state: CartDraftSource): CartDraftState {
  return {
    items: state.items,
    orderType: state.orderType,
    tableId: state.tableId,
    heldOrderId: state.heldOrderId,
    customerId: state.customerId,
    customer: state.customer,
    customerSource: state.customerSource,
    guestCount: state.guestCount,
    deliveryAddress: state.deliveryAddress,
    expectedPaymentMethod: state.expectedPaymentMethod,
    expectedPaymentMethodId: state.expectedPaymentMethodId,
    deliveryNote: state.deliveryNote,
    onlinePlatform: state.onlinePlatform,
    externalOrderId: state.externalOrderId,
    orderNotes: state.orderNotes,
    waivedChargeIds: Array.from(state.waivedChargeIds),
    optedInChargeIds: Array.from(state.optedInChargeIds),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}

function sanitizeDraftItem(raw: unknown): CartItem | null {
  if (!isRecord(raw)) return null;
  const product = raw.product;
  if (!isRecord(product)) return null;
  const productId = (product as Record<string, unknown>).id;
  if (typeof productId !== 'string' && typeof productId !== 'number') return null;
  const quantity = Number(raw.quantity);
  if (!Number.isFinite(quantity) || quantity <= 0) return null;
  const addons = Array.isArray(raw.addons)
    ? (raw.addons.filter((entry) => isRecord(entry)) as unknown as Addon[])
    : [];
  const priceOverride = isRecord(raw.price_override)
    ? {
        price: Number(raw.price_override.price),
        reason: asString(raw.price_override.reason),
      }
    : null;
  return {
    id: asString(raw.id),
    product: product as unknown as Product,
    quantity,
    addons,
    special_instructions: asString(raw.special_instructions),
    variant: isRecord(raw.variant) ? (raw.variant as unknown as ProductVariant) : null,
    ...(priceOverride && Number.isFinite(priceOverride.price)
      ? { price_override: priceOverride }
      : {}),
  };
}

/** Read a persisted draft back, or null when it is not a usable cart. A
 * damaged draft restores nothing rather than a half cart: the cashier
 * re-rings it instead of selling from corrupted lines. */
export function parseCartDraft(value: unknown): CartDraftState | null {
  if (!isRecord(value)) return null;
  if (!Array.isArray(value.items)) return null;
  const items: CartItem[] = [];
  for (const raw of value.items) {
    const item = sanitizeDraftItem(raw);
    if (item) items.push(item);
  }
  const orderType =
    typeof value.orderType === 'string' &&
    (ORDER_TYPES as readonly string[]).includes(value.orderType)
      ? (value.orderType as CartDraftOrderType)
      : 'dine_in';
  const guestCount = Number(value.guestCount);
  const expectedPaymentMethodId = Number(value.expectedPaymentMethodId);
  return {
    items: normalizeCartItems(items),
    orderType,
    tableId: typeof value.tableId === 'string' ? value.tableId : null,
    heldOrderId: typeof value.heldOrderId === 'string' ? value.heldOrderId : null,
    customerId:
      typeof value.customerId === 'string' || typeof value.customerId === 'number'
        ? value.customerId
        : null,
    customer:
      isRecord(value.customer) && value.customer.id !== undefined
        ? (value.customer as unknown as Customer)
        : null,
    customerSource:
      value.customerSource === 'explicit' || value.customerSource === 'reservation'
        ? value.customerSource
        : null,
    guestCount: Number.isFinite(guestCount) && guestCount >= 1 ? Math.floor(guestCount) : 1,
    deliveryAddress: asString(value.deliveryAddress),
    expectedPaymentMethod: asString(value.expectedPaymentMethod),
    expectedPaymentMethodId: Number.isFinite(expectedPaymentMethodId)
      ? expectedPaymentMethodId
      : null,
    deliveryNote: asString(value.deliveryNote),
    onlinePlatform: asString(value.onlinePlatform),
    externalOrderId: asString(value.externalOrderId),
    orderNotes: asString(value.orderNotes),
    waivedChargeIds: asStringArray(value.waivedChargeIds),
    optedInChargeIds: asStringArray(value.optedInChargeIds),
  };
}

export interface CartDraftStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
}

function createMemoryDraftStorage(): CartDraftStorage {
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

let memoryDraftStorage: CartDraftStorage | null = null;

/** localStorage when the renderer offers it, else one shared in-memory store
 * (tests, SSR prerender, restricted renderers). The factory never throws, so
 * a storage-denied renderer keeps a working in-memory cart. */
export function createCartDraftStorage(): CartDraftStorage {
  try {
    const candidate = (globalThis as { localStorage?: unknown }).localStorage as
      | CartDraftStorage
      | undefined;
    if (
      candidate &&
      typeof candidate.getItem === 'function' &&
      typeof candidate.setItem === 'function' &&
      typeof candidate.removeItem === 'function'
    ) {
      candidate.getItem(CART_DRAFT_STORAGE_KEY);
      return candidate;
    }
  } catch {
    // A denied probe means the renderer storage is unusable; fall through.
  }
  memoryDraftStorage ??= createMemoryDraftStorage();
  return memoryDraftStorage;
}
