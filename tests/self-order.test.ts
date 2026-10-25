/** Customer self-ordering: per-table QR tokens, sanitized cart, staff-pipeline order. */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-self-order-'));

Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') {
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  }
  return originalLoad.apply(this, arguments as any);
};

async function getFreeTcpPort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const address = probe.address();
  assert(address && typeof address !== 'string');
  const port = address.port;
  await new Promise<void>((resolve, reject) =>
    probe.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

async function requestJson(
  baseUrl: string,
  pathName: string,
  options: {
    method?: string;
    body?: unknown;
    token?: string;
    headers?: Record<string, string>;
  } = {},
) {
  const response = await fetch(`${baseUrl}${pathName}`, {
    method: options.method || 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      ...(options.headers || {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  let parsed: any = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* keep raw text */
  }
  return { status: response.status, body: parsed };
}

async function main() {
  console.log('Integration Test: Customer self-ordering');
  console.log('='.repeat(52));

  process.env.PORT = String(await getFreeTcpPort());
  process.env.KDS_PORT = String(await getFreeTcpPort());
  process.env.SERVER_APP_PORT = String(await getFreeTcpPort());

  const bcrypt = require('bcryptjs');
  const { initDatabase, getDatabase, closeDatabase, now } = await import('../main/db');
  const { startServer, stopServer, getServerPort } = await import('../main/server');
  const { startServerApp, stopServerApp, getServerAppPort } = await import('../main/server-app');
  const selfOrder = await import('../main/services/self-order');

  initDatabase();
  const db = getDatabase();
  const setSetting = (key: string, value: string) =>
    db
      .prepare(
        'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      )
      .run(key, value);

  const passwordHash = bcrypt.hashSync('OwnerPass123!', 10);
  db.prepare(
    `INSERT INTO users (id, name, email, password, role, is_active, created_at, updated_at)
     VALUES ('self-order-owner', 'Owner', 'owner@self-order.test', ?, 'owner', 1, ?, ?)`,
  ).run(passwordHash, now(), now());

  db.prepare("INSERT INTO tables (id, number) VALUES ('table-1', '7')").run();
  db.prepare("INSERT INTO tables (id, number) VALUES ('table-2', '8')").run();
  db.prepare("INSERT INTO categories (id, name) VALUES ('cat-1', 'Pizza')").run();
  db.prepare(
    "INSERT INTO products (id, category_id, name, price, is_active) VALUES ('prod-1', 'cat-1', 'Margherita', 25000, 1)",
  ).run();
  db.prepare(
    "INSERT INTO product_variants (id, product_id, name, price, is_active) VALUES ('var-1', 'prod-1', 'Large', 32000, 1)",
  ).run();
  db.prepare("INSERT INTO addon_groups (id, name) VALUES ('grp-1', 'Extras')").run();
  db.prepare(
    "INSERT INTO addon_group_product (product_id, addon_group_id) VALUES ('prod-1', 'grp-1')",
  ).run();
  db.prepare(
    "INSERT INTO addons (id, addon_group_id, name, price, is_active) VALUES ('addon-1', 'grp-1', 'Extra cheese', 3000, 1)",
  ).run();

  await startServer();
  await startServerApp();
  const mainBaseUrl = `http://127.0.0.1:${getServerPort()}`;
  const appBaseUrl = `http://127.0.0.1:${getServerAppPort()}`;

  try {
    const token = selfOrder.getSelfOrderToken('table-1');
    assert.ok(token.length >= 32, 'token is issued for a table');
    assert.equal(selfOrder.getSelfOrderToken('table-1'), token, 'token is stable until rotated');
    assert.notEqual(selfOrder.getSelfOrderToken('table-2'), token, 'tokens differ per table');

    // 1. Disabled feature: everything 404s, even with a valid token.
    const disabledInfo = await requestJson(appBaseUrl, `/api/self-order/info?t=${token}`);
    assert.equal(disabledInfo.status, 404, 'info is hidden while self-ordering is disabled');

    selfOrder.setSelfOrderEnabled(true);
    assert.equal(selfOrder.isSelfOrderEnabled(), true);

    // 2. Token gate.
    const noToken = await requestJson(appBaseUrl, '/api/self-order/info');
    assert.equal(noToken.status, 401, 'info requires a token');
    const badToken = await requestJson(appBaseUrl, '/api/self-order/info?t=not-a-real-token-value');
    assert.equal(badToken.status, 401, 'info rejects a bogus token');

    const info = await requestJson(appBaseUrl, `/api/self-order/info?t=${token}`);
    assert.equal(info.status, 200, 'info succeeds with the table token');
    assert.equal(info.body.table.number, '7', 'info names the token table');
    assert.equal(info.body.currency, 'SYP', 'info carries the generic currency');

    // 3. Menu reads flow through the staff pipeline shapes.
    const products = await requestJson(appBaseUrl, `/api/self-order/products?t=${token}`);
    assert.equal(products.status, 200, 'products succeed');
    const margherita = products.body.products.find((p: any) => p.id === 'prod-1');
    assert.ok(margherita, 'seeded product is on the customer menu');
    assert.equal(margherita.price, 25000, 'menu price comes from the database');

    // 4. Cheating payloads are rebuilt from database truth.
    const cheat = await requestJson(appBaseUrl, `/api/self-order/orders?t=${token}`, {
      method: 'POST',
      headers: { 'Idempotency-Key': 'self-order-test-cheat-1' },
      body: {
        table_id: 'table-2',
        type: 'takeaway',
        items: [
          {
            product_id: 'prod-1',
            variant_id: 'var-1',
            quantity: 2,
            price_override: { price: 1, reason: 'cheat' },
            addons: [{ id: 'addon-1', name: 'Free', price: 0.01, quantity: 1 }],
          },
        ],
      },
    });
    assert.equal(
      cheat.status,
      201,
      `order is created (got ${cheat.status}: ${JSON.stringify(cheat.body)})`,
    );
    const order = cheat.body.order;
    assert.equal(
      order.table_id,
      'table-1',
      'order lands on the token table, not the payload table',
    );
    assert.equal(order.type, 'dine_in', 'order type is forced to dine_in');
    // 2 x (variant 32000 + add-on at database price 3000) = 70000.
    assert.equal(order.total, 70000, 'total is priced from the database, payload prices ignored');
    const orderRow = db.prepare('SELECT * FROM orders WHERE id = ?').get(order.id) as any;
    assert.equal(orderRow.online_platform, 'self_order', 'order is marked as a self-order');
    assert.equal(orderRow.status, 'pending', 'order starts pending for the kitchen');

    // 5. Idempotent retry (same key, same cart) replays the original order.
    const retry = await requestJson(appBaseUrl, `/api/self-order/orders?t=${token}`, {
      method: 'POST',
      headers: { 'Idempotency-Key': 'self-order-test-cheat-1' },
      body: {
        items: [
          {
            product_id: 'prod-1',
            variant_id: 'var-1',
            quantity: 2,
            addons: [{ id: 'addon-1', quantity: 1 }],
          },
        ],
      },
    });
    assert.equal(retry.body.order.id, order.id, 'idempotency key replays the original order');
    const orderCount = db
      .prepare("SELECT COUNT(*) AS c FROM orders WHERE table_id = 'table-1'")
      .get() as any;
    assert.equal(orderCount.c, 1, 'retry did not create a second order');

    // 6. Unknown products are refused before anything is written.
    const unknown = await requestJson(appBaseUrl, `/api/self-order/orders?t=${token}`, {
      method: 'POST',
      body: { items: [{ product_id: 'prod-nope', quantity: 1 }] },
    });
    assert.equal(unknown.status, 400, 'unknown product is rejected');

    // 7. Owner admin: list, regenerate (old token dies), disable.
    const login = await requestJson(mainBaseUrl, '/api/auth/login', {
      method: 'POST',
      body: { email: 'owner@self-order.test', password: 'OwnerPass123!' },
    });
    assert.equal(login.status, 200, 'owner can log in');
    const ownerToken = login.body.access_token as string;
    assert.ok(ownerToken, 'login returns a token');

    const admin = await requestJson(mainBaseUrl, '/api/self-order-admin', { token: ownerToken });
    assert.equal(admin.status, 200, 'admin list succeeds');
    assert.equal(admin.body.enabled, true, 'admin reports the enabled flag');
    const entry = admin.body.tables.find((entry: any) => entry.id === 'table-1');
    assert.ok(entry?.url.includes(token), 'admin URL carries the current token');
    assert.ok(entry?.qr_data_url?.startsWith('data:image/'), 'admin entry carries a QR image');

    const regenerated = await requestJson(
      mainBaseUrl,
      '/api/self-order-admin/tables/table-1/regenerate',
      { method: 'POST', token: ownerToken },
    );
    assert.equal(regenerated.status, 200, 'regenerate succeeds');
    assert.ok(!regenerated.body.url.includes(token), 'regenerated URL carries a new token');
    const oldTokenInfo = await requestJson(appBaseUrl, `/api/self-order/info?t=${token}`);
    assert.equal(oldTokenInfo.status, 401, 'old token stops working after regeneration');

    const disable = await requestJson(mainBaseUrl, '/api/self-order-admin', {
      method: 'PUT',
      token: ownerToken,
      body: { enabled: false },
    });
    assert.equal(disable.status, 200, 'disable succeeds');
    const disabledAgain = await requestJson(
      appBaseUrl,
      `/api/self-order/info?t=${selfOrder.getSelfOrderToken('table-1')}`,
    );
    assert.equal(disabledAgain.status, 404, 'info hides again once disabled');

    console.log('\nAll self-order tests passed.');
  } finally {
    await stopServerApp().catch(() => undefined);
    await stopServer().catch(() => undefined);
    closeDatabase();
    Module._load = originalLoad;
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
