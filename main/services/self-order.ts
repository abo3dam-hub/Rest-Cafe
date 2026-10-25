/**
 * Customer self-ordering (QR per table). The token is an HMAC of the table id
 * and a per-table salt under a store secret, both kept in settings — rotating
 * a table's QR code is just a new salt, no migration. Orders run through the
 * normal orders API under a short-lived owner JWT minted per request, and
 * add-on prices are rebuilt from the database because the orders pipeline
 * trusts payload add-on prices, which a customer's phone must not control.
 */
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import jwt from 'jsonwebtoken';
import type { Database } from 'better-sqlite3';
import { getDatabase, getSettingValue, upsertSettings } from '../db';
import { getJWTSecret } from '../security/jwt-secret';

export const SELF_ORDER_PLATFORM = 'self_order';

const SECRET_SETTING = 'self_order_secret';
const ENABLED_SETTING = 'self_order_enabled';
const saltSettingKey = (tableId: string) => `self_order_salt_${tableId}`;

export function isSelfOrderEnabled(): boolean {
  return getSettingValue(ENABLED_SETTING) === 'true';
}

export function setSelfOrderEnabled(enabled: boolean): void {
  upsertSettings({ [ENABLED_SETTING]: enabled ? 'true' : 'false' });
}

function getOrCreateSecret(): string {
  const existing = getSettingValue(SECRET_SETTING);
  if (existing && existing.length >= 32) return existing;
  const secret = randomBytes(32).toString('hex');
  upsertSettings({ [SECRET_SETTING]: secret });
  return secret;
}

function getOrCreateSalt(tableId: string): string {
  const key = saltSettingKey(tableId);
  const existing = getSettingValue(key);
  if (existing && existing.length >= 16) return existing;
  const salt = randomBytes(16).toString('hex');
  upsertSettings({ [key]: salt });
  return salt;
}

function tokenFor(tableId: string, salt: string, secret: string): string {
  return createHmac('sha256', secret).update(`${tableId}:${salt}`).digest('base64url');
}

/** The table's current self-order token, creating the secret/salt on first use. */
export function getSelfOrderToken(tableId: string): string {
  return tokenFor(tableId, getOrCreateSalt(tableId), getOrCreateSecret());
}

/** Issues a fresh token for a table (the old QR code stops working). */
export function rotateSelfOrderToken(tableId: string): string {
  const salt = randomBytes(16).toString('hex');
  upsertSettings({ [saltSettingKey(tableId)]: salt });
  return tokenFor(tableId, salt, getOrCreateSecret());
}

export interface SelfOrderTable {
  id: string;
  number: string;
}

/** Resolves a presented token to its table, or null when it matches none. */
export function resolveSelfOrderTable(token: unknown): SelfOrderTable | null {
  if (typeof token !== 'string' || token.length < 16 || token.length > 128) return null;
  const secret = getSettingValue(SECRET_SETTING);
  if (!secret) return null;
  const db = getDatabase();
  const tables = db.prepare('SELECT id, number FROM tables').all() as SelfOrderTable[];
  const presented = Buffer.from(token);
  for (const table of tables) {
    const salt = getSettingValue(saltSettingKey(table.id));
    if (!salt) continue;
    const expected = Buffer.from(tokenFor(table.id, salt, secret));
    if (expected.length === presented.length && timingSafeEqual(expected, presented)) {
      return { id: table.id, number: table.number };
    }
  }
  return null;
}

/**
 * Short-lived owner JWT for the server app's loopback forwards, so a
 * self-order runs the exact staff pipeline and is audit-attributed to the
 * owner. Minted per request; never sent to the customer's device.
 */
export function mintSelfOrderActorToken(): string | null {
  const db = getDatabase();
  const owner = db
    .prepare(
      "SELECT id, email, role FROM users WHERE role = 'owner' AND is_active = 1 ORDER BY created_at ASC LIMIT 1",
    )
    .get() as { id: string; email: string; role: string } | undefined;
  if (!owner) return null;
  return jwt.sign(
    {
      userId: owner.id,
      email: owner.email,
      role: owner.role,
      jti: randomUUID(),
      self_order_actor: true,
    },
    getJWTSecret(),
    { expiresIn: '120s' },
  );
}

export interface SanitizedOrderItem {
  product_id: string;
  variant_id: string | null;
  quantity: number;
  addons: { id: string; name: string; price: number; quantity: number }[] | null;
  special_instructions: string | null;
}

const MAX_ITEMS = 50;
const MAX_ADDONS_PER_ITEM = 20;

/**
 * Validates a customer cart and rebuilds it from database truth: every id
 * must exist and be active, add-on names/prices come from the database, and
 * price overrides or discounts are dropped by construction.
 */
export function sanitizeSelfOrderItems(
  db: Database,
  raw: unknown,
): { items: SanitizedOrderItem[] } | { error: string } {
  if (!Array.isArray(raw) || raw.length === 0) return { error: 'Your cart is empty' };
  if (raw.length > MAX_ITEMS) return { error: 'Too many items in one order' };

  const productStmt = db.prepare(
    'SELECT id, allow_fractional_quantity FROM products WHERE id = ? AND is_active = 1 AND deleted_at IS NULL',
  );
  const variantStmt = db.prepare(
    'SELECT id FROM product_variants WHERE id = ? AND product_id = ? AND is_active = 1',
  );
  const addonStmt = db.prepare('SELECT id, name, price FROM addons WHERE id = ? AND is_active = 1');

  const items: SanitizedOrderItem[] = [];
  for (const entry of raw) {
    const line = (entry ?? {}) as Record<string, unknown>;
    const productId = typeof line.product_id === 'string' ? line.product_id : '';
    const product = productStmt.get(productId) as
      | { id: string; allow_fractional_quantity: number }
      | undefined;
    if (!product) return { error: 'One of the items is no longer available' };

    const rawQty = typeof line.quantity === 'number' ? line.quantity : NaN;
    if (!Number.isFinite(rawQty) || rawQty <= 0 || rawQty > 500) {
      return { error: 'Invalid quantity for one of the items' };
    }
    const quantity = product.allow_fractional_quantity
      ? Math.round(rawQty * 1000) / 1000
      : Math.floor(rawQty);
    if (quantity <= 0) return { error: 'Invalid quantity for one of the items' };

    let variantId: string | null = null;
    if (typeof line.variant_id === 'string' && line.variant_id) {
      const variant = variantStmt.get(line.variant_id, productId) as { id: string } | undefined;
      if (!variant) return { error: 'One of the chosen options is no longer available' };
      variantId = variant.id;
    }

    let addons: SanitizedOrderItem['addons'] = null;
    if (Array.isArray(line.addons) && line.addons.length > 0) {
      if (line.addons.length > MAX_ADDONS_PER_ITEM)
        return { error: 'Too many add-ons on one item' };
      addons = [];
      for (const rawAddon of line.addons) {
        const addonLine = (rawAddon ?? {}) as Record<string, unknown>;
        const addonId = typeof addonLine.id === 'string' ? addonLine.id : '';
        const addon = addonStmt.get(addonId) as
          | { id: string; name: string; price: number }
          | undefined;
        if (!addon) return { error: 'One of the chosen add-ons is no longer available' };
        const rawAddonQty = typeof addonLine.quantity === 'number' ? addonLine.quantity : 1;
        const addonQty = Math.min(10, Math.max(1, Math.floor(rawAddonQty) || 1));
        addons.push({ id: addon.id, name: addon.name, price: addon.price, quantity: addonQty });
      }
    }

    const notes =
      typeof line.special_instructions === 'string'
        ? line.special_instructions.trim().slice(0, 200) || null
        : null;

    items.push({
      product_id: product.id,
      variant_id: variantId,
      quantity,
      addons,
      special_instructions: notes,
    });
  }
  return { items };
}
