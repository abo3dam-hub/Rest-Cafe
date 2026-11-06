/** Aggregated LAN links for every device-facing interface, in one payload.
 *
 * The per-interface info routes (`/api/pos-info`, `/api/kds-info`,
 * `/api/server-app-info`) already expose live ports and QR codes, but each
 * lives inside its own settings tab. This route is the single source the
 * «Interface Links» settings tab reads: every interface's live URL built
 * from the port its server actually bound, a QR for that URL, and whether
 * the interface is enabled — so a disabled interface never presents a
 * dead link as if it worked.
 */
import { Router, Request, Response } from 'express';
import QRCode from 'qrcode';
import { getLocalIP, getServerPort, getDefaultServerPort } from '../server-state';
import { getDefaultKdsPort, getKdsPort } from '../kds-server';
import { getDefaultServerAppPort, getServerAppPort } from '../server-app-state';
import { isKdsEnabled, isServerAppEnabled } from '../db';
import { isSelfOrderEnabled } from '../services/self-order';
import { asyncHandler } from '../middleware/async-handler';

export interface InterfaceLink {
  id: 'main' | 'kitchen' | 'waiter' | 'customer_display';
  url: string;
  qr_data_url: string | null;
  port: number;
  requested_port: number;
  port_bumped: boolean;
  enabled: boolean;
}

export interface InterfaceLinksStatus {
  ip: string;
  interfaces: InterfaceLink[];
  self_order: {
    enabled: boolean;
    server_app_enabled: boolean;
  };
}

async function buildLink(
  id: InterfaceLink['id'],
  url: string,
  port: number,
  requestedPort: number,
  enabled: boolean,
): Promise<InterfaceLink> {
  let qrDataUrl: string | null = null;
  if (enabled) {
    try {
      qrDataUrl = await QRCode.toDataURL(url, { errorCorrectionLevel: 'M', width: 256 });
    } catch {
      qrDataUrl = null;
    }
  }
  return {
    id,
    url,
    qr_data_url: qrDataUrl,
    port,
    requested_port: requestedPort,
    port_bumped: port !== requestedPort,
    enabled,
  };
}

/** Pure read of the live interface links; exported so suites can assert the
 * aggregation without standing up HTTP. */
export async function buildInterfaceLinks(): Promise<InterfaceLinksStatus> {
  const ip = getLocalIP();
  const mainPort = getServerPort();
  const kdsPort = getKdsPort();
  const serverAppPort = getServerAppPort();
  const serverAppEnabled = isServerAppEnabled();

  const interfaces = await Promise.all([
    buildLink('main', `http://${ip}:${mainPort}/`, mainPort, getDefaultServerPort(), true),
    buildLink('kitchen', `http://${ip}:${kdsPort}/`, kdsPort, getDefaultKdsPort(), isKdsEnabled()),
    buildLink(
      'waiter',
      `http://${ip}:${serverAppPort}/`,
      serverAppPort,
      getDefaultServerAppPort(),
      serverAppEnabled,
    ),
    buildLink(
      'customer_display',
      `http://${ip}:${mainPort}/customer-display/`,
      mainPort,
      getDefaultServerPort(),
      true,
    ),
  ]);

  return {
    ip,
    interfaces,
    self_order: {
      enabled: isSelfOrderEnabled(),
      server_app_enabled: serverAppEnabled,
    },
  };
}

const router = Router();

router.get(
  '/',
  asyncHandler(async (_req: Request, res: Response) => {
    res.json(await buildInterfaceLinks());
  }),
);

export const interfaceLinksRoutes = router;
