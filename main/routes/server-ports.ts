/** Live LAN ports for the three servers, with port-bump state (F-006).
 *
 * The POS window follows a bumped main port, but a KDS tablet, Server App
 * phone, or bookmarked URL using the default port fails with no
 * operator-facing notice. This route is the single source the app's
 * persistent port-bump notice and the pairing tabs read: the port each
 * service actually bound, the port it first tried, and whether it moved.
 */
import { Router, Request, Response } from 'express';
import { getDefaultServerPort, getLatestPortBump, getServerPort } from '../server-state';
import { getDefaultKdsPort, getKdsPort } from '../kds-server';
import { getDefaultServerAppPort, getServerAppPort } from '../server-app-state';
import { asyncHandler } from '../middleware/async-handler';
import type { PortBumpRecord, ServerServiceId } from '../server-state';

export interface ServerPortStatus {
  service: ServerServiceId;
  requested_port: number;
  port: number;
  port_bumped: boolean;
  last_bump: PortBumpRecord | null;
}

export interface ServerPortsStatus {
  api: ServerPortStatus;
  kds: ServerPortStatus;
  server_app: ServerPortStatus;
}

function buildServiceStatus(
  service: ServerServiceId,
  requestedPort: number,
  actualPort: number,
): ServerPortStatus {
  return {
    service,
    requested_port: requestedPort,
    port: actualPort,
    port_bumped: actualPort !== requestedPort,
    last_bump: getLatestPortBump(service),
  };
}

/** Pure read of the live ports; exported so suites can assert the bump
 * wiring without standing up HTTP. */
export function buildServerPortsStatus(): ServerPortsStatus {
  return {
    api: buildServiceStatus('api', getDefaultServerPort(), getServerPort()),
    kds: buildServiceStatus('kds', getDefaultKdsPort(), getKdsPort()),
    server_app: buildServiceStatus('server-app', getDefaultServerAppPort(), getServerAppPort()),
  };
}

const router = Router();

router.get(
  '/',
  asyncHandler(async (_req: Request, res: Response) => {
    res.json(buildServerPortsStatus());
  }),
);

export const serverPortsRoutes = router;
