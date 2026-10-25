import { Router, Request, Response } from 'express';
import * as os from 'os';
import { rateLimit } from '../middleware/security';
import { requirePermission } from '../services/authorization';
import { getDatabase } from '../db';

const router = Router();

const ALLOWED_CATEGORIES = new Set(['general', 'bug', 'feature', 'account', 'printer', 'tax']);

/** Rate limit for the unauthenticated pre-login support endpoints (no session to key off yet). */
function preLoginRateLimit(max: number) {
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    max,
    message: 'Too many requests. Please try again later.',
    bypassPrivateIp: false,
  });
}
type SupportUser = { name?: string; email?: string; role?: string };
type AuthenticatedRequest = Request & { user?: { userId?: string; role?: string } };

const BLANK_PROFILE = {
  contact_name: '',
  contact_email: '',
  contact_phone: '',
  restaurant_name: '',
  country: '',
  timezone: '',
  submitted_by_role: '',
};

function isAuthenticatedRequest(req: Request): boolean {
  return !!(req as AuthenticatedRequest).user?.userId;
}

function supportProfile(req: Request) {
  const db = getDatabase();
  const rows = db.prepare('SELECT key, value FROM settings').all() as Array<{
    key: string;
    value: string;
  }>;
  const settings = Object.fromEntries(rows.map((row) => [row.key, row.value]));
  const authUser = (req as AuthenticatedRequest).user;
  const userId = String(authUser?.userId || '');
  const currentUser = userId
    ? (db
        .prepare('SELECT name, email, role FROM users WHERE id = ? AND is_active = 1')
        .get(userId) as SupportUser | undefined)
    : null;
  const owner = db
    .prepare(
      "SELECT name, email, role FROM users WHERE role = 'owner' AND is_active = 1 ORDER BY created_at ASC LIMIT 1",
    )
    .get() as SupportUser | undefined;
  const contact = currentUser || owner || {};
  return {
    contact_name: String(contact.name || owner?.name || '').trim(),
    contact_email: String(settings.email || owner?.email || contact.email || '').trim(),
    contact_phone: String(settings.business_phone || settings.phone || '').trim(),
    restaurant_name: String(settings.business_name || '').trim(),
    country: String(settings.country || '').trim(),
    timezone: String(settings.timezone || '').trim(),
    submitted_by_role: String(contact.role || authUser?.role || '').trim(),
  };
}

/** Pre-login routes are reachable by any unauthenticated LAN client; never disclose owner/business PII there. */
function resolveProfile(req: Request) {
  return isAuthenticatedRequest(req) ? supportProfile(req) : BLANK_PROFILE;
}

/** Shared with the diagnostics screen so both surfaces classify a category identically. */
export function resolveCategory(value: unknown): string {
  return ALLOWED_CATEGORIES.has(String(value || '')) ? String(value) : 'general';
}

// Shared with the diagnostics screen so both report the same system state,
// rather than the screen carrying a second implementation.
export function buildSystemDiagnostics(req: Request, category: string) {
  const db = getDatabase();
  const schemaVersion = db.pragma('user_version', { simple: true }) as number;
  const profile = resolveProfile(req);
  return {
    category,
    restaurant_name: profile.restaurant_name,
    country: profile.country,
    timezone: profile.timezone,
    app_version: require('../../package.json').version,
    platform: process.platform,
    arch: process.arch,
    device_name: os.hostname(),
    schema_version: schemaVersion,
    submitted_by_role: profile.submitted_by_role,
  };
}

function profileHandler(req: Request, res: Response) {
  const profile = resolveProfile(req);
  res.json({
    ...profile,
    app_version: require('../../package.json').version,
    platform: process.platform,
  });
}

router.get('/profile', requirePermission('support.use'), profileHandler);
router.get(
  '/diagnostics-preview',
  requirePermission('support.use'),
  (req: Request, res: Response) => {
    res.json(buildSystemDiagnostics(req, resolveCategory(req.query.category)));
  },
);

// Unauthenticated (login-screen) variants, exempted in main/server.ts;
// rate-limited here (private IPs included) since there is no user to key off.
router.get('/pre-login/profile', preLoginRateLimit(30), profileHandler);

export const supportTicketRoutes = router;
