/** Owner controls for customer self-ordering: enable switch and per-table QR codes. */
import { Router, Request, Response } from 'express';
import QRCode from 'qrcode';
import { getDatabase, isServerAppEnabled } from '../db';
import { getLocalIP } from '../server-state';
import { getServerAppPort } from '../server-app-state';
import { requirePermission } from '../services/authorization';
import { asyncHandler } from '../middleware/async-handler';
import {
  getSelfOrderToken,
  isSelfOrderEnabled,
  rotateSelfOrderToken,
  setSelfOrderEnabled,
} from '../services/self-order';

const router = Router();

function tableUrl(token: string): string {
  return `http://${getLocalIP()}:${getServerAppPort()}/self-order?t=${token}`;
}

async function tableEntry(table: { id: string; number: string }) {
  const token = getSelfOrderToken(table.id);
  const url = tableUrl(token);
  let qr_data_url: string | null = null;
  try {
    qr_data_url = await QRCode.toDataURL(url, { errorCorrectionLevel: 'M', width: 256 });
  } catch {
    qr_data_url = null;
  }
  return { id: table.id, number: table.number, url, qr_data_url };
}

router.get(
  '/',
  requirePermission('settings.view'),
  asyncHandler(async (_req: Request, res: Response) => {
    const db = getDatabase();
    const tables = db.prepare('SELECT id, number FROM tables ORDER BY number').all() as {
      id: string;
      number: string;
    }[];
    res.json({
      enabled: isSelfOrderEnabled(),
      server_app_enabled: isServerAppEnabled(),
      tables: await Promise.all(tables.map(tableEntry)),
    });
  }),
);

router.put(
  '/',
  requirePermission('settings.manage'),
  asyncHandler(async (req: Request, res: Response) => {
    if (typeof req.body?.enabled !== 'boolean') {
      return res.status(400).json({ error: 'enabled must be a boolean' });
    }
    setSelfOrderEnabled(req.body.enabled);
    res.json({ enabled: req.body.enabled });
  }),
);

router.post(
  '/tables/:id/regenerate',
  requirePermission('settings.manage'),
  asyncHandler(async (req: Request, res: Response) => {
    const db = getDatabase();
    const table = db.prepare('SELECT id, number FROM tables WHERE id = ?').get(req.params.id) as
      | { id: string; number: string }
      | undefined;
    if (!table) return res.status(404).json({ error: 'Table not found' });
    rotateSelfOrderToken(table.id);
    res.json(await tableEntry(table));
  }),
);

export const selfOrderAdminRoutes = router;
