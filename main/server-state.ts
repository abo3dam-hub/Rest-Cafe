import os from 'os';

const DEFAULT_PORT = parseInt(process.env.PORT || '3001', 10);
let activePort = DEFAULT_PORT;

/** The port the main API server first tried to bind (before any bump). */
export function getDefaultServerPort(): number {
  return DEFAULT_PORT;
}

export function getServerPort(): number {
  return activePort;
}

export function setServerPort(port: number): void {
  activePort = port;
}

/** One of the three LAN servers whose port the operator pairs devices against. */
export type ServerServiceId = 'api' | 'kds' | 'server-app';

/** A port bump the operator was never told about (F-006): the service could
 * not bind its default port and moved. Kept in memory for this run only;
 * a restart re-derives it from the live ports. */
export interface PortBumpRecord {
  service: ServerServiceId;
  requestedPort: number;
  actualPort: number;
  reason: string;
  at: string;
}

const portBumps: PortBumpRecord[] = [];

/** Record that a service moved from `fromPort` to `toPort` (EADDRINUSE/EACCES).
 * Called from the listen-error path of each server; never throws. */
export function recordPortBump(
  service: ServerServiceId,
  fromPort: number,
  toPort: number,
  reason: string,
): void {
  try {
    portBumps.push({
      service,
      requestedPort: fromPort,
      actualPort: toPort,
      reason,
      at: new Date().toISOString(),
    });
  } catch {
    // Port-bump history is advisory; losing a record must never break startup.
  }
}

/** Bumps recorded so far this run, oldest first. */
export function getPortBumps(): PortBumpRecord[] {
  return [...portBumps];
}

/** Latest bump for one service, if it moved. */
export function getLatestPortBump(service: ServerServiceId): PortBumpRecord | null {
  for (let i = portBumps.length - 1; i >= 0; i--) {
    if (portBumps[i].service === service) return portBumps[i];
  }
  return null;
}

/** Helper to check if an IPv4 address is active and valid (excludes loopback & 169.254.x.x link-local APIPA). */
function isValidLocalIPv4(alias: os.NetworkInterfaceInfo): boolean {
  const isIPv4 = alias.family === 'IPv4' || (alias.family as string | number) === 4;
  if (!isIPv4 || alias.internal) return false;
  const ip = alias.address;
  if (ip.startsWith('169.254.') || ip.startsWith('127.') || ip === '0.0.0.0') {
    return false;
  }
  return true;
}

const VIRTUAL_ADAPTER_NAME =
  /^(vethernet|wsl|docker|br-|veth|vmnet|vboxnet|vmware|virtualbox|hyper-v|tailscale|utun|tun|tap|zt|zerotier|ham|lo)/i;
const PHYSICAL_ADAPTER_NAME = /^(en\d|eth|wlan|wlp|enp|eno|ens|wi-?fi|ethernet|wireless)/i;

/** Scores an interface address for LAN pairing; higher is better, physical LAN adapters win over virtual or tunnel adapters. */
export function rankLocalIPv4(interfaceName: string, address: string): number {
  let score = 0;
  if (VIRTUAL_ADAPTER_NAME.test(interfaceName)) score -= 100;
  else if (PHYSICAL_ADAPTER_NAME.test(interfaceName)) score += 50;

  const octets = address.split('.').map(Number);
  const [a, b] = octets;
  if (a === 172 && b === 17) score -= 100;
  else if (a === 192 && b === 168) score += 20;
  else if (a === 10) score += 15;
  else if (a === 172 && b >= 16 && b <= 31) score += 10;
  else if (a === 100 && b >= 64 && b <= 127) score -= 100;
  return score;
}

function listLocalIPv4(): string[] {
  const candidates: Array<{ address: string; score: number; order: number }> = [];
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const alias of interfaces[name] ?? []) {
      if (isValidLocalIPv4(alias)) {
        candidates.push({
          address: alias.address,
          score: rankLocalIPv4(name, alias.address),
          order: candidates.length,
        });
      }
    }
  }
  return candidates.sort((x, y) => y.score - x.score || x.order - y.order).map((c) => c.address);
}

/** Returns the best-ranked valid non-loopback IPv4 address on the machine. */
export function getLocalIP(): string {
  return listLocalIPv4()[0] ?? '127.0.0.1';
}

/** Returns all valid non-loopback IPv4 addresses on the machine, best-ranked first. */
export function getAllLocalIPs(): string[] {
  const ips = listLocalIPv4();
  return ips.length > 0 ? ips : ['127.0.0.1'];
}
