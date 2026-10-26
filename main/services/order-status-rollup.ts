import { getDatabase, now } from '../db';

type Database = ReturnType<typeof getDatabase>;

// Item states that have left the kitchen lifecycle; they never hold an
// order's derived status back.
const TERMINAL_ITEM_STATUSES = ['voided', 'void_adjustment', 'cancelled', 'refunded'];

// Kitchen progression for orders.status; the rollup only ever advances.
const ORDER_STATUS_RANK: Record<string, number> = {
  pending: 0,
  preparing: 1,
  ready: 2,
  served: 3,
};

export function syncOrderStatusFromItems(db: Database, orderId: number | string): void {
  const order = db.prepare('SELECT status FROM orders WHERE id = ?').get(orderId) as
    | { status: string }
    | undefined;
  if (!order) return;
  // Settled and cancelled orders are final; kitchen progress never reopens them.
  if (order.status === 'completed' || order.status === 'cancelled') return;
  const currentRank = ORDER_STATUS_RANK[order.status];
  if (currentRank === undefined) return;

  const placeholders = TERMINAL_ITEM_STATUSES.map(() => '?').join(', ');
  const rows = db
    .prepare(`SELECT status FROM order_items WHERE order_id = ? AND status NOT IN (${placeholders})`)
    .all(orderId, ...TERMINAL_ITEM_STATUSES) as { status: string }[];
  if (rows.length === 0) return;

  const statuses = rows.map((row) => row.status);
  let derived: string;
  if (statuses.every((s) => s === 'served' || s === 'completed')) {
    derived = 'served';
  } else if (statuses.every((s) => s === 'ready' || s === 'served' || s === 'completed')) {
    derived = 'ready';
  } else if (
    statuses.some((s) => s === 'preparing' || s === 'ready' || s === 'served' || s === 'completed')
  ) {
    derived = 'preparing';
  } else {
    derived = 'pending';
  }

  if (ORDER_STATUS_RANK[derived] > currentRank) {
    db.prepare('UPDATE orders SET status = ?, updated_at = ? WHERE id = ?').run(
      derived,
      now(),
      orderId,
    );
  }
}
