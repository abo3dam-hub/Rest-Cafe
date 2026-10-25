/** Returns catalog of companion apps and download QR codes for settings display. */
import { Router, Request, Response } from 'express';
import QRCode from 'qrcode';
import { asyncHandler } from '../middleware/async-handler';

const router = Router();

type AppEntry = {
  id: string;
  name: string;
  tagline: string;
  iosUrl: string | null;
  androidUrl: string | null;
  landingUrl?: string | null;
};

const MORE_APPS: AppEntry[] = [];

async function toAppResponse(app: AppEntry) {
  const primaryUrl = app.iosUrl || app.androidUrl || app.landingUrl || null;
  let qrDataUrl: string | null = null;
  if (primaryUrl) {
    try {
      qrDataUrl = await QRCode.toDataURL(primaryUrl, { errorCorrectionLevel: 'M', width: 256 });
    } catch (err) {
      console.warn(`[MoreApps] QR generation failed for ${app.id}:`, err);
    }
  }
  return {
    id: app.id,
    name: app.name,
    tagline: app.tagline,
    ios_url: app.iosUrl,
    android_url: app.androidUrl,
    landing_url: app.landingUrl || null,
    qr_data_url: qrDataUrl,
    available: Boolean(primaryUrl),
  };
}

router.get(
  '/',
  asyncHandler(async (_req: Request, res: Response) => {
    try {
      const apps = await Promise.all(MORE_APPS.map(toAppResponse));
      res.json({ apps });
    } catch (error: any) {
      console.error('[API] Internal error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }),
);

export const moreAppsRoutes = router;
