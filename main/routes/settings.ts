import { Router, Request, Response, RequestHandler } from 'express';
import expressRateLimit from 'express-rate-limit';
import { getDatabase, getSettingValue, now } from '../db';
import {
  requireAnyPermission,
  requirePermission,
  resolveEffectivePermissions,
} from '../services/authorization';
import {
  CUSTOMER_DISPLAY_KEY,
  parseCustomerDisplayConfig,
  readStoredCustomerDisplayConfig,
} from '../services/customer-display-config';
import {
  createDisplayToken,
  hasReachedTokenLimit,
  listDisplayTokens,
  normalizeTokenLabel,
  revokeDisplayToken,
} from '../services/customer-display-tokens';
import { resolveTaxIdFormat, validateTaxRegistrationNumber } from '../services/tax';
import {
  OFFLINE_MODE_SETTING,
  isOfflineMode,
  notifyOfflineModeEnabled,
} from '../services/offline-mode';
import {
  getCountryByCode,
  getCurrencyFractionDigits,
  getCurrencySymbol,
  isValidTimeZone,
  isLocalePreferenceKey,
  isLocalePreferenceSupported,
  resolveStoredLocalePreference,
  type LocalePreferenceKey,
} from '../countries';
import { normalizeOptionalPhone } from '../lib/phone';
import { isPosCategorySort, isPosItemSort, readPosSortSettings } from '../lib/pos-sort';
import {
  CORE_BILL_TEMPLATES,
  isAvailableBillTemplate,
  listInstalledPrintTemplates,
  upgradeBillTemplateValue,
} from '../services/print-templates';
import { listMerchantPrintTemplates } from '../services/merchant-print-templates';
import { isSyntacticallyValidCurrencyCode } from '../../shared/print/currency';
import { parseReceiptLogoData } from '../../shared/print/image-raster';
import {
  BILL_LANGUAGE_POLICY_KEY,
  KOT_LANGUAGE_POLICY_KEY,
  Z_REPORT_LANGUAGE_POLICY_KEY,
  LANGUAGE_POLICY_SETTING_KEYS,
  defaultLanguagePolicySettingJson,
  validateLanguagePolicySetting,
} from '../lib/print-language-settings';
import { isThemeMode } from '../title-bar-theme';
import {
  ChargeValidationError,
  CUSTOM_CHARGES_SETTING_KEY,
  getChargeDefinitions,
  normalizeChargeDefinitions,
} from '../services/charges';

const router = Router();
const configuredSettingsReadLimit = Number.parseInt(
  process.env.FLO_SETTINGS_READ_RATE_LIMIT_MAX || '',
  10,
);
const settingsReadRateLimit = expressRateLimit({
  windowMs: 60 * 1000,
  limit:
    Number.isFinite(configuredSettingsReadLimit) && configuredSettingsReadLimit > 0
      ? configuredSettingsReadLimit
      : 120,
  standardHeaders: true,
  legacyHeaders: false,
});
const configuredSettingsWriteLimit = Number.parseInt(
  process.env.FLO_SETTINGS_WRITE_RATE_LIMIT_MAX || '',
  10,
);
const settingsWriteRateLimit = expressRateLimit({
  windowMs: 60 * 1000,
  limit:
    Number.isFinite(configuredSettingsWriteLimit) && configuredSettingsWriteLimit > 0
      ? configuredSettingsWriteLimit
      : 60,
  standardHeaders: true,
  legacyHeaders: false,
});

// ── Helpers ────────────────────────────────────────────────────────────────

function getAllSettings(db: ReturnType<typeof getDatabase>): Record<string, string> {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const s: Record<string, string> = {};
  for (const row of rows) s[(row as any).key] = (row as any).value;
  return s;
}

function upsertSettings(db: ReturnType<typeof getDatabase>, entries: Record<string, any>): void {
  const stmt = db.prepare(`
    INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `);
  db.transaction(() => {
    for (const [key, val] of Object.entries(entries)) {
      if (val !== undefined) stmt.run(key, val === null ? '' : String(val), now());
    }
  })();
}

function validBusinessLocation(timezone: unknown, currency: unknown, country: unknown): boolean {
  // Rest&Cafe: country is optional (no country profiles); '' means unset.
  if (timezone !== undefined && !isValidTimeZone(timezone)) return false;
  if (currency !== undefined && !isSyntacticallyValidCurrencyCode(currency)) return false;
  if (
    country !== undefined &&
    country !== '' &&
    (typeof country !== 'string' || !/^[A-Z]{2}$/.test(country))
  )
    return false;
  return true;
}

const SENSITIVE_SETTING_KEYS = new Set([
  'mobile_pairing_code',
  'jwt_secret',
  'cloud_api_key',
  'cloud_device_secret',
  'cloud_deletion_status_token',
  'cloud_last_error',
]);

function isGoogleDriveSettingKey(key: string): boolean {
  return key.startsWith('google_drive_');
}

const OPTIONAL_SETTING_DEFAULTS: Record<string, string> = {
  bill_template: 'classic',
  bill_footer_message: '',
  bill_show_logo: 'false',
  receipt_logo: '',
  receipt_logo_raster: '',
  printer_trim_decimals: 'false',
  split_checks_enabled: 'true',
  card_transaction_id_required: 'false',
  // Print language policies (#441) — inherit store language, no second
  // language. Defaults preserve pre-policy behavior for existing tenants.
  [BILL_LANGUAGE_POLICY_KEY]: defaultLanguagePolicySettingJson(),
  [KOT_LANGUAGE_POLICY_KEY]: defaultLanguagePolicySettingJson(),
  // Iran locale display preferences (Batch G, Refs #241) — display-only.
  currency_display: 'rial',
  number_digits: 'locale',
  calendar: 'locale',
  // Returns 'system' if not yet explicitly saved by the user.
  theme_mode: 'system',
  // Orders screen layout (#639): master/detail split view is the default.
  orders_layout: 'split',
  // POS catalog ordering: 'saved' keeps the stored sort_order.
  pos_category_sort: 'saved',
  pos_item_sort: 'saved',
};

/** Single authority for the orders_layout enum; both write transports gate on it. */
export function isOrdersLayout(value: unknown): value is 'split' | 'cards' {
  return value === 'split' || value === 'cards';
}

function maskSetting(key: string, value: string): string {
  if (key === 'cloud_last_error') return value ? 'Cloud service request failed' : '';
  if (key === 'mobile_pairing_code') return value ? '****' : '';
  if (!SENSITIVE_SETTING_KEYS.has(key)) return value;
  return value ? `****${value.slice(-4)}` : '';
}

function publicSettingsShape(settings: Record<string, string>): Record<string, string> {
  const publicSettings: Record<string, string> = {};
  for (const [key, value] of Object.entries(settings)) {
    if (isGoogleDriveSettingKey(key)) continue;
    publicSettings[key] = maskSetting(key, value);
  }
  return publicSettings;
}

function boolFlag(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string') {
    return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase()) ? 'true' : 'false';
  }
  return value ? 'true' : 'false';
}

function deriveCurrencySymbol(currency: string, country: string): string {
  return getCurrencySymbol(currency || '', getCountryByCode(country)?.locale) || currency || '';
}

function businessShape(s: Record<string, string>) {
  return {
    business_name: s.business_name || '',
    // Regional fields degrade to empty rather than throw — Settings must
    // never fail to load for an authenticated user (should be unreachable
    // post-setup; see docs/reference/product-invariants.md).
    timezone: s.timezone || '',
    business_day_start_time: s.business_day_start_time || '00:00',
    currency: s.currency || '',
    // The owner's currency unit (symbol override, e.g. "SP"); '' = CLDR default.
    currency_symbol: s.currency_symbol || '',
    country: s.country || '',
    language: s.language || 'ar',
    tax_registration_number: s.tax_registration_number || '',
    state_code: s.state_code || '',
    business_address: s.business_address || '',
    business_phone: s.business_phone || '',
    instagram_handle: s.instagram_handle || '',
    billing_type: s.billing_type || 'postpaid',
    tables_required: s.tables_required !== 'false',
    tax_registered: s.tax_registered === 'true' || s.tax_registered === '1',
    bill_show_name: s.bill_show_name !== 'false',
    bill_show_address: s.bill_show_address !== 'false',
    bill_show_phone: s.bill_show_phone !== 'false',
    bill_show_tax_id: s.bill_show_tax_id === 'true',
    bill_show_tax_breakdown: s.bill_show_tax_breakdown !== 'false',
    bill_show_customer_name: s.bill_show_customer_name !== 'false',
    bill_show_customer_phone: s.bill_show_customer_phone !== 'false',
    bill_delivery_show_customer_phone_always:
      s.bill_delivery_show_customer_phone_always !== 'false',
    bill_show_table_number: s.bill_show_table_number !== 'false',
    bill_show_logo: s.bill_show_logo === 'true',
    receipt_logo: s.receipt_logo || '',
    receipt_logo_raster: s.receipt_logo_raster || '',
    bill_footer_message: s.bill_footer_message || '',
    bill_template: s.bill_template || 'classic',
    currency_display: resolveStoredLocalePreference(
      'currency_display',
      s.currency_display,
      s.country || '',
    ),
    number_digits: resolveStoredLocalePreference('number_digits', s.number_digits, s.country || ''),
    calendar: resolveStoredLocalePreference('calendar', s.calendar, s.country || ''),
    // Non-blocking informational tax format description for the UI.
    tax_id_format: resolveTaxIdFormat(s.country || ''),
  };
}

function taxShape(s: Record<string, string>) {
  return {
    tax_registered: s.tax_registered === 'true',
    tax_registration_number: s.tax_registration_number || '',
    state_code: s.state_code || '',
    tax_scheme: s.tax_scheme || 'regular',
    country: s.country || '',
    tax_id_format: resolveTaxIdFormat(s.country || ''),
  };
}

// ── Specific routes (must come BEFORE /:key wildcard) ─────────────────────

const requireBusinessSettingsRead: RequestHandler = (req, res, next) => {
  const userId = String((req as Request & { user?: { userId?: string } }).user?.userId || '');
  if (!userId) {
    return res
      .status(401)
      .json({ error: 'Authentication required', code: 'authentication_required' });
  }
  const effective = resolveEffectivePermissions(userId);
  if (
    !effective ||
    !['settings.view', 'bills.read', 'bills.print', 'bills.generate'].some((permissionId) =>
      effective.permissionIds.has(permissionId as any),
    )
  ) {
    return res.status(403).json({
      error: 'Insufficient permissions',
      code: 'permission_denied',
      permission: 'settings.view',
    });
  }
  next();
};

router.get('/business', requireBusinessSettingsRead, (req: Request, res: Response) => {
  try {
    const s = getAllSettings(getDatabase());
    res.json(businessShape(s));
  } catch (error: any) {
    console.error('[API] Internal error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.put('/business', requirePermission('settings.manage'), (req: Request, res: Response) => {
  try {
    const {
      business_name,
      timezone,
      business_day_start_time,
      currency,
      country,
      language,
      tax_registration_number,
      state_code,
      business_address,
      business_phone,
      instagram_handle,
      billing_type,
      tables_required,
      tax_registered,
      bill_show_name,
      bill_show_address,
      bill_show_phone,
      bill_show_tax_id,
      bill_show_tax_breakdown,
      bill_show_customer_name,
      bill_show_customer_phone,
      bill_show_table_number,
      bill_delivery_show_customer_phone_always,
      receipt_logo,
      receipt_logo_raster,
      bill_show_logo,
      currency_display,
      number_digits,
      calendar,
      currency_symbol,
    } = req.body;
    const normalizedCurrency =
      typeof currency === 'string' ? currency.trim().toUpperCase() : currency;
    const normalizedInstagramHandle =
      instagram_handle !== undefined
        ? String(instagram_handle || '')
            .trim()
            .slice(0, 100)
        : undefined;

    let normalizedReceiptLogo: string | undefined = undefined;
    if (receipt_logo !== undefined) {
      if (typeof receipt_logo !== 'string') {
        return res.status(400).json({ error: 'receipt_logo must be a string' });
      }
      if (receipt_logo.length > 250_000) {
        return res.status(400).json({ error: 'receipt_logo exceeds maximum size (250 KB)' });
      }
      if (receipt_logo.length > 0 && !receipt_logo.startsWith('data:image/')) {
        return res.status(400).json({ error: 'receipt_logo must be a valid data URI' });
      }
      normalizedReceiptLogo = receipt_logo;
    }

    let normalizedReceiptLogoRaster: string | undefined = undefined;
    if (receipt_logo_raster !== undefined) {
      if (typeof receipt_logo_raster !== 'string') {
        return res.status(400).json({ error: 'receipt_logo_raster must be a string' });
      }
      if (receipt_logo_raster.length > 250_000) {
        return res.status(400).json({ error: 'receipt_logo_raster exceeds maximum size (250 KB)' });
      }
      if (receipt_logo_raster.length > 0 && !parseReceiptLogoData(receipt_logo_raster)) {
        return res
          .status(400)
          .json({ error: 'receipt_logo_raster must contain valid raster data' });
      }
      normalizedReceiptLogoRaster = receipt_logo_raster;
    }

    if (!validBusinessLocation(timezone, normalizedCurrency, country)) {
      return res.status(400).json({ error: 'Invalid timezone, currency, or country' });
    }

    if (business_day_start_time !== undefined) {
      if (
        typeof business_day_start_time !== 'string' ||
        !/^(?:0\d|1[01]):[0-5]\d$/.test(business_day_start_time.trim())
      ) {
        return res.status(400).json({
          error: 'Invalid business_day_start_time format (must be HH:mm between 00:00 and 11:59)',
        });
      }
    }

    const db = getDatabase();
    const currentSettings = getAllSettings(db);
    if (normalizedCurrency !== undefined && normalizedCurrency !== currentSettings.currency) {
      return res.status(409).json({
        error: 'currency_change_requires_reset',
        current_currency: currentSettings.currency || '',
        requested_currency: normalizedCurrency,
      });
    }
    const effectiveCountry = country || currentSettings.country || '';
    // The currency unit (symbol) is the owner's own setting in Rest&Cafe —
    // never derived from a country. '' clears it back to the CLDR symbol.
    const normalizedCurrencySymbol =
      currency_symbol !== undefined
        ? String(currency_symbol || '')
            .trim()
            .slice(0, 12)
        : undefined;

    // Validate locale preferences against country options, normalizing unsupported legacy values.
    const localeUpdates: Record<string, string> = {};
    for (const { key, submitted } of [
      { key: 'currency_display', submitted: currency_display },
      { key: 'number_digits', submitted: number_digits },
      { key: 'calendar', submitted: calendar },
    ] as Array<{ key: LocalePreferenceKey; submitted: unknown }>) {
      if (submitted !== undefined) {
        if (
          typeof submitted !== 'string' ||
          !isLocalePreferenceSupported(key, submitted, effectiveCountry)
        ) {
          return res.status(400).json({ error: `Invalid ${key} for country ${effectiveCountry}` });
        }
        localeUpdates[key] = submitted;
      } else {
        localeUpdates[key] = resolveStoredLocalePreference(
          key,
          currentSettings[key],
          effectiveCountry,
        );
      }
    }

    if (tax_registration_number) {
      const { valid, format } = validateTaxRegistrationNumber(
        effectiveCountry,
        tax_registration_number,
      );
      if (!valid && format) {
        return res.status(400).json({
          error: `Tax ID does not match the expected ${effectiveCountry} format: ${format.description}`,
          tax_id_format: format,
        });
      }
    }

    let normalizedPhone: string | undefined = undefined;
    if (business_phone !== undefined) {
      const phoneRes = normalizeOptionalPhone(business_phone, effectiveCountry || 'SY');
      if (!phoneRes.valid) {
        return res.status(400).json({ error: phoneRes.error || 'Invalid business phone number' });
      }
      normalizedPhone = phoneRes.e164 || '';
    }

    upsertSettings(db, {
      business_name,
      timezone,
      business_day_start_time:
        business_day_start_time !== undefined ? business_day_start_time.trim() : undefined,
      currency: normalizedCurrency,
      country,
      language,
      currency_symbol: normalizedCurrencySymbol,
      tax_registration_number,
      state_code,
      business_address,
      business_phone: normalizedPhone !== undefined ? normalizedPhone : undefined,
      instagram_handle: normalizedInstagramHandle,
      billing_type,
      tables_required,
      tax_registered,
      bill_show_name,
      bill_show_address,
      bill_show_phone,
      bill_show_tax_id,
      bill_show_tax_breakdown,
      bill_show_customer_name,
      bill_show_customer_phone,
      bill_show_table_number,
      bill_delivery_show_customer_phone_always,
      bill_show_logo: boolFlag(bill_show_logo),
      receipt_logo: normalizedReceiptLogo,
      receipt_logo_raster: normalizedReceiptLogoRaster,
      ...localeUpdates,
    });

    res.json(businessShape(getAllSettings(db)));
  } catch (error: any) {
    console.error('[API] Internal error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/tax', requirePermission('settings.view'), (req: Request, res: Response) => {
  try {
    const s = getAllSettings(getDatabase());
    res.json(taxShape(s));
  } catch (error: any) {
    console.error('[API] Internal error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.put('/tax', requirePermission('tax-configuration.manage'), (req: Request, res: Response) => {
  try {
    const { tax_registered, tax_registration_number, state_code, tax_scheme, country } = req.body;

    if (!validBusinessLocation(undefined, undefined, country)) {
      return res.status(400).json({ error: 'Invalid country' });
    }

    const db = getDatabase();
    const currentSettings = getAllSettings(db);
    const effectiveCountry = country || currentSettings.country || '';
    if (tax_registration_number) {
      const { valid, format } = validateTaxRegistrationNumber(
        effectiveCountry,
        tax_registration_number,
      );
      if (!valid && format) {
        return res.status(400).json({
          error: `Tax ID does not match the expected ${effectiveCountry} format: ${format.description}`,
          tax_id_format: format,
        });
      }
    }
    upsertSettings(db, {
      tax_registered,
      tax_registration_number,
      state_code,
      tax_scheme,
      country,
      currency_symbol:
        country !== undefined
          ? deriveCurrencySymbol(
              currentSettings.currency || '',
              country || currentSettings.country || '',
            )
          : undefined,
    });
    res.json(taxShape(getAllSettings(db)));
  } catch (error: any) {
    console.error('[API] Internal error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/loyalty', requirePermission('settings.view'), (req: Request, res: Response) => {
  try {
    const s = getAllSettings(getDatabase());
    res.json({
      loyalty_enabled: s.loyalty_enabled === 'true' || s.loyalty_enabled === '1',
      global_cashback_percent: parseFloat(s.global_cashback_percent || '0'),
    });
  } catch (error: any) {
    console.error('[API] Internal error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.put('/loyalty', requirePermission('settings.manage'), (req: Request, res: Response) => {
  try {
    const { loyalty_enabled, global_cashback_percent } = req.body;

    let finalGlobalCb: number | undefined = undefined;
    if (global_cashback_percent !== undefined) {
      if (
        typeof global_cashback_percent !== 'number' ||
        !Number.isFinite(global_cashback_percent) ||
        global_cashback_percent < 0 ||
        global_cashback_percent > 100
      ) {
        return res
          .status(400)
          .json({ error: 'Global cashback percent must be a number between 0 and 100' });
      }
      finalGlobalCb = global_cashback_percent;
    }

    const db = getDatabase();
    upsertSettings(db, {
      loyalty_enabled,
      ...(finalGlobalCb !== undefined && { global_cashback_percent: String(finalGlobalCb) }),
    });
    const s = getAllSettings(db);
    res.json({
      loyalty_enabled: s.loyalty_enabled === 'true' || s.loyalty_enabled === '1',
      global_cashback_percent: parseFloat(s.global_cashback_percent || '0'),
    });
  } catch (error: any) {
    console.error('[API] Internal error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── Discount settings ──────────────────────────────────────────────────────

router.get('/discount', requirePermission('settings.view'), (req: Request, res: Response) => {
  try {
    const s = getAllSettings(getDatabase());
    res.json({
      discount_max_percentage: parseFloat(s.discount_max_percentage || '25'),
      discount_max_amount: parseFloat(s.discount_max_amount || '0'),
      discount_mode: s.discount_mode || 'percentage',
      discount_requires_approval:
        s.discount_requires_approval === 'true' || s.discount_requires_approval === '1',
    });
  } catch (error: any) {
    console.error('[API] Internal error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.put('/discount', requirePermission('settings.manage'), (req: Request, res: Response) => {
  try {
    const {
      discount_max_percentage,
      discount_max_amount,
      discount_mode,
      discount_requires_approval,
    } = req.body;

    // Validate inputs
    if (discount_max_percentage !== undefined) {
      const val = parseFloat(discount_max_percentage);
      if (isNaN(val) || val < 1 || val > 100) {
        return res
          .status(400)
          .json({ error: 'discount_max_percentage must be a number between 1 and 100' });
      }
    }
    if (discount_max_amount !== undefined) {
      const val = parseFloat(discount_max_amount);
      if (isNaN(val) || val < 0 || val > 999999) {
        return res
          .status(400)
          .json({ error: 'discount_max_amount must be a number between 0 and 999999' });
      }
    }
    if (
      discount_mode !== undefined &&
      !['percentage', 'flat', 'both', 'none'].includes(discount_mode)
    ) {
      return res
        .status(400)
        .json({ error: 'discount_mode must be "percentage", "flat", "both", or "none"' });
    }

    const db = getDatabase();
    upsertSettings(db, {
      discount_max_percentage,
      discount_max_amount,
      discount_mode,
      discount_requires_approval:
        discount_requires_approval === true || discount_requires_approval === 'true'
          ? 'true'
          : 'false',
    });
    const s = getAllSettings(db);
    res.json({
      discount_max_percentage: parseFloat(s.discount_max_percentage || '25'),
      discount_max_amount: parseFloat(s.discount_max_amount || '0'),
      discount_mode: s.discount_mode || 'percentage',
      discount_requires_approval:
        s.discount_requires_approval === 'true' || s.discount_requires_approval === '1',
    });
  } catch (error: any) {
    console.error('[API] Internal error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── KDS settings (must come BEFORE /:key wildcard) ─────────────────────────

// Mirrors KDS default view for the dashboard settings page.
router.get('/kds', requirePermission('settings.view'), (_req: Request, res: Response) => {
  try {
    const s = getAllSettings(getDatabase());
    res.json({
      kds_default_view: s.kds_default_view === 'kanban' ? 'kanban' : 'tabs',
    });
  } catch (error: any) {
    console.error('[API] Internal error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.put('/kds', requirePermission('settings.manage'), (req: Request, res: Response) => {
  try {
    const { kds_default_view } = req.body;
    if (kds_default_view !== undefined && !['tabs', 'kanban'].includes(kds_default_view)) {
      return res.status(400).json({ error: 'kds_default_view must be "tabs" or "kanban"' });
    }
    if (kds_default_view !== undefined) {
      upsertSettings(getDatabase(), { kds_default_view });
    }
    const s = getAllSettings(getDatabase());
    res.json({
      kds_default_view: s.kds_default_view === 'kanban' ? 'kanban' : 'tabs',
    });
  } catch (error: any) {
    console.error('[API] Internal error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── POS catalog sort (must come BEFORE /:key wildcard) ─────────────────────

// Every role that can ring up orders needs the ordering, not only settings.view.
router.get(
  '/pos-sort',
  settingsReadRateLimit,
  requireAnyPermission('settings.view', 'orders.read', 'orders.create'),
  (_req: Request, res: Response) => {
    try {
      res.json(readPosSortSettings(getAllSettings(getDatabase())));
    } catch (error) {
      console.error('[API] Internal error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

// ─── Customer display settings (must come BEFORE /:key wildcard) ────────────

// The board runs under any role that can see orders, so reads are not limited to settings.view.
router.get(
  '/customer-display',
  settingsReadRateLimit,
  requireAnyPermission('settings.view', 'orders.read', 'orders.create'),
  (_req: Request, res: Response) => {
    try {
      res.json(
        readStoredCustomerDisplayConfig(getAllSettings(getDatabase())[CUSTOMER_DISPLAY_KEY]),
      );
    } catch (error) {
      console.error('[API] Internal error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

router.put(
  '/customer-display',
  settingsWriteRateLimit,
  requirePermission('settings.manage'),
  (req: Request, res: Response) => {
    try {
      const config = parseCustomerDisplayConfig(req.body);
      if (!config) {
        return res.status(400).json({ error: 'Invalid customer display settings' });
      }
      upsertSettings(getDatabase(), { [CUSTOMER_DISPLAY_KEY]: JSON.stringify(config) });
      res.json(config);
    } catch (error) {
      console.error('[API] Internal error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

router.get(
  '/customer-display/tokens',
  settingsReadRateLimit,
  requirePermission('settings.manage'),
  (_req: Request, res: Response) => {
    try {
      res.json({ tokens: listDisplayTokens() });
    } catch (error) {
      console.error('[API] Internal error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

// The plaintext token is returned once, on creation; only its hash is stored.
router.post(
  '/customer-display/tokens',
  settingsWriteRateLimit,
  requirePermission('settings.manage'),
  (req: Request, res: Response) => {
    try {
      const label = normalizeTokenLabel(req.body?.label);
      if (!label) {
        return res.status(400).json({ error: 'A label of 1-60 characters is required' });
      }
      if (hasReachedTokenLimit()) {
        return res.status(409).json({ error: 'customer_display_token_limit' });
      }
      const actor = (req as Request & { user?: { userId?: string } }).user?.userId ?? null;
      res.status(201).json(createDisplayToken(label, actor));
    } catch (error) {
      console.error('[API] Internal error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

router.delete(
  '/customer-display/tokens/:id',
  settingsWriteRateLimit,
  requirePermission('settings.manage'),
  (req: Request, res: Response) => {
    try {
      if (!revokeDisplayToken(String(req.params.id))) {
        return res.status(404).json({ error: 'Display token not found' });
      }
      res.json({ success: true });
    } catch (error) {
      console.error('[API] Internal error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

// ─── Order numbering settings (must come BEFORE /:key wildcard) ─────────────

function orderNumberingShape(s: Record<string, string>) {
  return {
    order_number_prefix: s.order_number_prefix ?? 'ORD',
    order_number_include_date: s.order_number_include_date !== 'false',
    order_number_reset_daily: s.order_number_reset_daily !== 'false',
    invoice_number_prefix: s.invoice_number_prefix ?? 'INV',
    invoice_number_include_period: s.invoice_number_include_period !== 'false',
    invoice_number_reset_period: ['never', 'daily', 'monthly', 'financial_year'].includes(
      s.invoice_number_reset_period,
    )
      ? s.invoice_number_reset_period
      : 'daily',
    invoice_financial_year_start_month: parseBoundedInt(
      s.invoice_financial_year_start_month,
      1,
      12,
      4,
    ),
    invoice_financial_year_start_day: parseBoundedInt(s.invoice_financial_year_start_day, 1, 31, 1),
  };
}

// Alphanumeric only to avoid collisions with automatic hyphen separators.
const ORDER_NUMBER_PREFIX_PATTERN = /^[A-Za-z0-9]{0,12}$/;
const INVOICE_RESET_PERIODS = new Set(['never', 'daily', 'monthly', 'financial_year']);

function parseBoundedInt(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

router.get(
  '/order-numbering',
  requirePermission('settings.view'),
  (req: Request, res: Response) => {
    try {
      const s = getAllSettings(getDatabase());
      res.json(orderNumberingShape(s));
    } catch (error: any) {
      console.error('[API] Internal error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

router.put(
  '/order-numbering',
  requirePermission('settings.manage'),
  (req: Request, res: Response) => {
    try {
      const {
        order_number_prefix,
        order_number_include_date,
        order_number_reset_daily,
        invoice_number_prefix,
        invoice_number_include_period,
        invoice_number_reset_period,
        invoice_financial_year_start_month,
        invoice_financial_year_start_day,
      } = req.body;

      if (
        order_number_prefix !== undefined &&
        !ORDER_NUMBER_PREFIX_PATTERN.test(order_number_prefix)
      ) {
        return res
          .status(400)
          .json({ error: 'order_number_prefix must be up to 12 letters and numbers only' });
      }
      if (
        invoice_number_prefix !== undefined &&
        !ORDER_NUMBER_PREFIX_PATTERN.test(invoice_number_prefix)
      ) {
        return res
          .status(400)
          .json({ error: 'invoice_number_prefix must be up to 12 letters and numbers only' });
      }
      if (
        invoice_number_reset_period !== undefined &&
        !INVOICE_RESET_PERIODS.has(invoice_number_reset_period)
      ) {
        return res.status(400).json({
          error: 'invoice_number_reset_period must be one of never, daily, monthly, financial_year',
        });
      }
      if (
        invoice_financial_year_start_month !== undefined &&
        parseBoundedInt(invoice_financial_year_start_month, 1, 12, NaN) !==
          Number(invoice_financial_year_start_month)
      ) {
        return res.status(400).json({
          error: 'invoice_financial_year_start_month must be a whole number between 1 and 12',
        });
      }
      if (
        invoice_financial_year_start_day !== undefined &&
        parseBoundedInt(invoice_financial_year_start_day, 1, 31, NaN) !==
          Number(invoice_financial_year_start_day)
      ) {
        return res.status(400).json({
          error: 'invoice_financial_year_start_day must be a whole number between 1 and 31',
        });
      }

      const db = getDatabase();
      upsertSettings(db, {
        order_number_prefix,
        order_number_include_date: boolFlag(order_number_include_date),
        order_number_reset_daily: boolFlag(order_number_reset_daily),
        invoice_number_prefix,
        invoice_number_include_period: boolFlag(invoice_number_include_period),
        invoice_number_reset_period,
        invoice_financial_year_start_month,
        invoice_financial_year_start_day,
      });
      res.json(orderNumberingShape(getAllSettings(db)));
    } catch (error: any) {
      console.error('[API] Internal error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

// ── Charges & fees (must come BEFORE /:key wildcard) ───────────────────────

/**
 * Dedicated, validated charges & fees endpoints. `custom_charges` is
 * deliberately unreachable from the generic wildcard route below: a charge
 * definition needs range, enum and order-type validation that the wildcard
 * handler does not perform, and PR #829 shipped exactly that gap.
 */
router.get(
  '/charges',
  settingsReadRateLimit,
  requireAnyPermission('settings.view', 'orders.create', 'bills.discount.apply'),
  (_req: Request, res: Response) => {
    try {
      return res.json({ charges: getChargeDefinitions() });
    } catch (error) {
      console.error('[API] Internal error:', error);
      return res.status(500).json({ error: 'Internal server error' });
    }
  },
);

router.put(
  '/charges',
  settingsWriteRateLimit,
  requirePermission('settings.manage'),
  (req: Request, res: Response) => {
    try {
      const payload = (req.body || {}).charges ?? req.body;
      let definitions;
      try {
        const currencyDecimals = getCurrencyFractionDigits(getSettingValue('currency') || 'USD');
        definitions = normalizeChargeDefinitions(payload, currencyDecimals);
      } catch (error: unknown) {
        if (error instanceof ChargeValidationError) {
          return res.status(400).json({ error: error.message });
        }
        throw error;
      }

      const db = getDatabase();
      db.prepare(`
      INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(CUSTOM_CHARGES_SETTING_KEY, JSON.stringify(definitions), now());

      return res.json({ charges: definitions });
    } catch (error) {
      console.error('[API] Internal error:', error);
      return res.status(500).json({ error: 'Internal server error' });
    }
  },
);

// ── Orders screen layout (must come BEFORE /:key wildcard) ─────────────────

/**
 * The Orders layout is a tenant-wide display preference, so every role that can
 * open Orders has to read it — including roles denied `settings.view`. Writes
 * stay on the generic settings route, which requires `settings.manage`.
 */
router.get(
  '/orders_layout',
  settingsReadRateLimit,
  requireAnyPermission('settings.view', 'orders.read', 'orders.create'),
  (_req: Request, res: Response) => {
    try {
      const setting = getDatabase()
        .prepare('SELECT * FROM settings WHERE key = ?')
        .get('orders_layout');
      if (setting) return res.json({ setting });
      return res.json({
        setting: {
          key: 'orders_layout',
          value: OPTIONAL_SETTING_DEFAULTS.orders_layout,
          updated_at: null,
        },
      });
    } catch (error) {
      console.error('[API] Internal error:', error);
      return res.status(500).json({ error: 'Internal server error' });
    }
  },
);

router.get('/offline-mode', requirePermission('settings.view'), (_req: Request, res: Response) => {
  res.json({ offline_mode: isOfflineMode() });
});

router.put(
  '/offline-mode',
  settingsWriteRateLimit,
  requirePermission('offline-mode.manage'),
  (req: Request, res: Response) => {
    try {
      const value = req.body?.offline_mode;
      if (typeof value !== 'boolean') {
        return res.status(400).json({ error: 'offline_mode must be a boolean' });
      }
      getDatabase()
        .prepare(
          `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        )
        .run(OFFLINE_MODE_SETTING, value ? 'true' : 'false', now());
      if (value) {
        notifyOfflineModeEnabled();
      }
      res.json({ offline_mode: isOfflineMode() });
    } catch (error: unknown) {
      console.error('[API] Offline mode update failed:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

router.get(
  '/card_transaction_id_required',
  settingsReadRateLimit,
  requireAnyPermission('settings.view', 'payments.take', 'orders.create', 'bills.read'),
  (_req: Request, res: Response) => {
    try {
      const setting = getDatabase()
        .prepare('SELECT * FROM settings WHERE key = ?')
        .get('card_transaction_id_required');
      if (setting) return res.json({ setting });
      return res.json({
        setting: {
          key: 'card_transaction_id_required',
          value: OPTIONAL_SETTING_DEFAULTS.card_transaction_id_required,
          updated_at: null,
        },
      });
    } catch (error) {
      console.error('[API] Internal error:', error);
      return res.status(500).json({ error: 'Internal server error' });
    }
  },
);

// ── Generic key-value routes (wildcard — must be last) ─────────────────────

// Only non-sensitive keys may be updated via the wildcard route.
// Sensitive keys (cloud_*, tax_registration_number, etc.) must use their explicit routes above.
const ALLOWED_WILDCARD_KEYS = new Set([
  'business_name',
  'timezone',
  'currency',
  'country',
  'state_code',
  'business_address',
  'business_phone',
  'billing_type',
  'tables_required',
  'tax_registered',
  'bill_show_name',
  'bill_show_address',
  'bill_show_phone',
  'bill_show_tax_id',
  'bill_show_tax_breakdown',
  'bill_show_customer_name',
  'bill_show_customer_phone',
  'bill_show_table_number',
  'tax_scheme',
  'taxes_enabled',
  'loyalty_enabled',
  'language',
  'kds_default_view',
  'printer_method',
  'paper_size',
  'bill_template',
  'bill_footer_message',
  'printer_trim_decimals',
  'cash_drawer_pulse_enabled',
  'cash_drawer_pulse_methods',
  'telemetry_enabled',
  'diagnostics_consent',
  'diagnostics_transmission_enabled',
  'kds_enabled',
  'require_kitchen_delivered_before_settlement',
  'server_app_enabled',
  'kot_printing_enabled',
  'server_app_bill_printing_enabled',
  'split_checks_enabled',
  'card_transaction_id_required',
  BILL_LANGUAGE_POLICY_KEY,
  KOT_LANGUAGE_POLICY_KEY,
  Z_REPORT_LANGUAGE_POLICY_KEY,
  'currency_display',
  'number_digits',
  'calendar',
  'theme_mode',
  'orders_layout',
  'pos_category_sort',
  'pos_item_sort',
  'require_open_shift',
]);

/**
 * Settings whose payload needs schema validation the wildcard route cannot do.
 * Listed as an explicit deny so widening ALLOWED_WILDCARD_KEYS can never
 * quietly reopen the unvalidated path.
 */
const DEDICATED_SETTING_KEYS = new Set<string>([CUSTOM_CHARGES_SETTING_KEY]);

function isAllowedWildcardKey(key: string): boolean {
  // Explicit deny: `custom_charges` is a validated JSON document owned by the
  // dedicated /charges routes, not a scalar the wildcard can write.
  if (DEDICATED_SETTING_KEYS.has(key)) return false;
  return ALLOWED_WILDCARD_KEYS.has(key) || /^tax_plugin_request:[A-Z]{2}$/.test(key);
}

router.get('/', requirePermission('settings.view'), (req: Request, res: Response) => {
  try {
    const s = getAllSettings(getDatabase());
    res.json({ settings: publicSettingsShape(s) });
  } catch (error: any) {
    console.error('[API] Internal error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get(
  '/bill-templates',
  requirePermission('print-templates.view'),
  (_req: Request, res: Response) => {
    try {
      const plugins = listInstalledPrintTemplates().map((template) => {
        let storedWidths: string[] = [];
        try {
          const parsed = JSON.parse(template.paper_widths_json);
          storedWidths = Array.isArray(parsed)
            ? parsed.filter((width) => typeof width === 'string')
            : [];
        } catch {
          /* Ignore malformed rows; install validation owns the contract. */
        }
        const paperColumns = storedWidths
          .map((width) => /^cols-(\d+)$/.exec(width)?.[1])
          .filter((width): width is string => !!width)
          .map((width) => Number(width));
        return {
          id: template.template_id,
          displayName: template.display_name,
          country: template.country,
          jurisdiction: template.jurisdiction,
          paperColumns,
          status: template.status,
          packId: template.pack_id,
          packVersionId: template.pack_version_id,
        };
      });
      // Active merchant print templates for receipt formatting.
      const merchant = listMerchantPrintTemplates().map((template) => ({
        id: template.id,
        displayName: template.name,
        origin: template.origin,
        derivedFrom: template.derived_from ? JSON.parse(template.derived_from) : null,
        documentType: template.document_type,
        schemaVersion: template.schema_version,
        status: template.status,
        updatedAt: template.updated_at,
      }));
      res.json({ core: [...CORE_BILL_TEMPLATES], plugins, merchant });
    } catch (error: any) {
      console.error('[API] Internal error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

const PRINTING_BOOLEAN_KEYS = [
  'printer_trim_decimals',
  'bill_show_name',
  'bill_show_address',
  'bill_show_phone',
  'bill_show_tax_id',
  'bill_show_tax_breakdown',
  'bill_show_customer_name',
  'bill_show_customer_phone',
  'bill_show_table_number',
  'bill_delivery_show_customer_phone_always',
] as const;

const OPTIONAL_PRINTING_BOOLEAN_KEYS = ['bill_show_logo'] as const;

const PRINTING_BATCH_KEYS = new Set<string>([
  ...PRINTING_BOOLEAN_KEYS,
  ...OPTIONAL_PRINTING_BOOLEAN_KEYS,
  BILL_LANGUAGE_POLICY_KEY,
  KOT_LANGUAGE_POLICY_KEY,
  Z_REPORT_LANGUAGE_POLICY_KEY,
  'cash_drawer_pulse_enabled',
  'cash_drawer_pulse_methods',
]);

router.put(
  '/printing',
  settingsWriteRateLimit,
  requirePermission('printers.manage'),
  (req: Request, res: Response) => {
    try {
      const payload = req.body;
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        return res.status(400).json({ error: 'Printing settings payload must be an object' });
      }

      const values = payload as Record<string, unknown>;
      const unknownKey = Object.keys(values).find((key) => !PRINTING_BATCH_KEYS.has(key));
      if (unknownKey) {
        return res.status(400).json({ error: `Unknown printing setting: ${unknownKey}` });
      }

      for (const key of PRINTING_BOOLEAN_KEYS) {
        if (typeof values[key] !== 'boolean') {
          return res.status(400).json({ error: `${key} must be a boolean` });
        }
      }
      for (const key of OPTIONAL_PRINTING_BOOLEAN_KEYS) {
        if (values[key] !== undefined && typeof values[key] !== 'boolean') {
          return res.status(400).json({ error: `${key} must be a boolean` });
        }
      }

      const billLanguagePolicy = validateLanguagePolicySetting(
        BILL_LANGUAGE_POLICY_KEY,
        values[BILL_LANGUAGE_POLICY_KEY],
      );
      if (!billLanguagePolicy.ok) {
        return res.status(400).json({ error: billLanguagePolicy.error });
      }
      const kotLanguagePolicy = validateLanguagePolicySetting(
        KOT_LANGUAGE_POLICY_KEY,
        values[KOT_LANGUAGE_POLICY_KEY],
      );
      if (!kotLanguagePolicy.ok) {
        return res.status(400).json({ error: kotLanguagePolicy.error });
      }
      const hasZReportLanguagePolicy = Object.prototype.hasOwnProperty.call(
        values,
        Z_REPORT_LANGUAGE_POLICY_KEY,
      );
      const zReportLanguagePolicy = hasZReportLanguagePolicy
        ? validateLanguagePolicySetting(
            Z_REPORT_LANGUAGE_POLICY_KEY,
            values[Z_REPORT_LANGUAGE_POLICY_KEY],
          )
        : null;
      if (zReportLanguagePolicy && !zReportLanguagePolicy.ok) {
        return res.status(400).json({ error: zReportLanguagePolicy.error });
      }

      const hasCashDrawerEnabled = Object.prototype.hasOwnProperty.call(
        values,
        'cash_drawer_pulse_enabled',
      );
      const hasCashDrawerMethods = Object.prototype.hasOwnProperty.call(
        values,
        'cash_drawer_pulse_methods',
      );
      if (hasCashDrawerEnabled !== hasCashDrawerMethods) {
        return res.status(400).json({ error: 'Cash drawer settings must be provided together' });
      }
      if (hasCashDrawerEnabled && typeof values.cash_drawer_pulse_enabled !== 'boolean') {
        return res.status(400).json({ error: 'cash_drawer_pulse_enabled must be a boolean' });
      }
      if (
        hasCashDrawerMethods &&
        (!Array.isArray(values.cash_drawer_pulse_methods) ||
          values.cash_drawer_pulse_methods.some(
            (method) => typeof method !== 'string' || method.trim().length === 0,
          ))
      ) {
        return res
          .status(400)
          .json({ error: 'cash_drawer_pulse_methods must be a non-empty string array' });
      }

      const entries: Record<string, string> = {
        printer_trim_decimals: values.printer_trim_decimals ? 'true' : 'false',
        [BILL_LANGUAGE_POLICY_KEY]: billLanguagePolicy.stored,
        [KOT_LANGUAGE_POLICY_KEY]: kotLanguagePolicy.stored,
      };
      if (zReportLanguagePolicy?.ok) {
        entries[Z_REPORT_LANGUAGE_POLICY_KEY] = zReportLanguagePolicy.stored;
      }
      for (const key of PRINTING_BOOLEAN_KEYS.slice(1)) {
        entries[key] = values[key] ? 'true' : 'false';
      }
      for (const key of OPTIONAL_PRINTING_BOOLEAN_KEYS) {
        if (values[key] !== undefined) {
          entries[key] = values[key] ? 'true' : 'false';
        }
      }
      if (hasCashDrawerEnabled) {
        entries.cash_drawer_pulse_enabled = values.cash_drawer_pulse_enabled ? 'true' : 'false';
        entries.cash_drawer_pulse_methods = JSON.stringify(values.cash_drawer_pulse_methods);
      }

      upsertSettings(getDatabase(), entries);
      res.json({ settings: entries });
    } catch (error: any) {
      console.error('[API] Internal error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

router.get(
  '/:key',
  settingsReadRateLimit,
  requirePermission('settings.view'),
  (req: Request, res: Response) => {
    try {
      if (
        SENSITIVE_SETTING_KEYS.has(req.params.key as string) ||
        isGoogleDriveSettingKey(req.params.key as string)
      ) {
        return res
          .status(403)
          .json({ error: 'This setting is sensitive and cannot be read directly' });
      }
      const key = String(req.params.key);
      const db = getDatabase();
      const setting = db.prepare('SELECT * FROM settings WHERE key = ?').get(key);
      if (!setting) {
        const defaultValue = OPTIONAL_SETTING_DEFAULTS[key];
        if (defaultValue !== undefined) {
          return res.json({ setting: { key, value: defaultValue, updated_at: null } });
        }
        return res.status(404).json({ error: 'Setting not found' });
      }
      res.json({ setting });
    } catch (error: any) {
      console.error('[API] Internal error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

router.put(
  '/:key',
  settingsWriteRateLimit,
  requirePermission('settings.manage'),
  (req: Request, res: Response) => {
    try {
      if (!isAllowedWildcardKey(req.params.key as string)) {
        return res.status(403).json({ error: 'This setting cannot be updated via wildcard route' });
      }
      const { value } = req.body;
      if (value === undefined) {
        return res.status(400).json({ error: 'Value is required' });
      }
      // Upgrades legacy string values to canonical structured JSON on save.
      if (req.params.key === 'bill_template' && !isAvailableBillTemplate(value)) {
        return res.status(400).json({ error: 'Unsupported bill template' });
      }
      if (req.params.key === 'theme_mode' && !isThemeMode(value)) {
        return res.status(400).json({ error: 'Invalid theme_mode value' });
      }
      if (req.params.key === 'orders_layout' && !isOrdersLayout(value)) {
        return res.status(400).json({ error: 'orders_layout must be "split" or "cards"' });
      }
      if (req.params.key === 'pos_category_sort' && !isPosCategorySort(value)) {
        return res.status(400).json({ error: 'pos_category_sort must be "saved" or "name"' });
      }
      if (req.params.key === 'pos_item_sort' && !isPosItemSort(value)) {
        return res.status(400).json({
          error: 'pos_item_sort must be "saved", "name", "price_asc" or "price_desc"',
        });
      }
      let valueToPersist: unknown = value;
      if (
        req.params.key === 'require_open_shift' ||
        req.params.key === 'card_transaction_id_required'
      ) {
        if (value !== true && value !== false && value !== 'true' && value !== 'false') {
          return res.status(400).json({ error: `${req.params.key} must be a boolean` });
        }
        valueToPersist = value === true || value === 'true' ? 'true' : 'false';
      }
      const diagnosticsChoice =
        req.params.key === 'diagnostics_consent' ||
        req.params.key === 'diagnostics_transmission_enabled';
      if (diagnosticsChoice) valueToPersist = boolFlag(value);
      if (req.params.key === 'currency') {
        valueToPersist = typeof value === 'string' ? value.trim().toUpperCase() : value;
        if (!isSyntacticallyValidCurrencyCode(valueToPersist)) {
          return res.status(400).json({ error: 'Invalid currency' });
        }
      }
      if (req.params.key === 'bill_template') {
        valueToPersist = upgradeBillTemplateValue(value);
      }
      if (typeof req.params.key === 'string' && LANGUAGE_POLICY_SETTING_KEYS.has(req.params.key)) {
        const validation = validateLanguagePolicySetting(req.params.key, value);
        if (!validation.ok) {
          return res.status(400).json({ error: validation.error });
        }
        valueToPersist = validation.stored;
      }
      const db = getDatabase();
      if (req.params.key === 'currency') {
        const currentCurrency = getAllSettings(db).currency || '';
        if (valueToPersist !== currentCurrency) {
          return res.status(409).json({
            error: 'currency_change_requires_reset',
            current_currency: currentCurrency,
            requested_currency: valueToPersist,
          });
        }
      }
      const wildcardKey = String(req.params.key);
      if (isLocalePreferenceKey(wildcardKey)) {
        const countryCode = getAllSettings(db).country || '';
        if (
          typeof value !== 'string' ||
          !isLocalePreferenceSupported(wildcardKey, value, countryCode)
        ) {
          return res
            .status(400)
            .json({ error: `Invalid ${wildcardKey} for country ${countryCode}` });
        }
      }

      if (req.params.key === 'business_phone') {
        const effectiveCountry = getAllSettings(db).country || '';
        const phoneRes = normalizeOptionalPhone(value, effectiveCountry);
        if (!phoneRes.valid) {
          return res.status(400).json({ error: phoneRes.error || 'Invalid business phone number' });
        }
        valueToPersist = phoneRes.e164 || '';
      }

      // Invalidate outstanding pairing tokens when KDS is disabled.
      if (req.params.key === 'kds_enabled') {
        const wasEnabled = getAllSettings(db).kds_enabled !== 'false';
        const turningOff = boolFlag(value) === 'false';
        if (wasEnabled && turningOff) {
          db.prepare('DELETE FROM kds_pairing_tokens').run();
        }
      }

      const saveSetting = db.prepare(`
      INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `);
      if (diagnosticsChoice) {
        db.transaction(() => {
          saveSetting.run(req.params.key, valueToPersist as string, now());
          db.prepare(`
          INSERT INTO settings (key, value, updated_at) VALUES ('diagnostics_settings_explicit', 'true', ?)
          ON CONFLICT(key) DO UPDATE SET value = 'true', updated_at = excluded.updated_at
        `).run(now());
        })();
      } else {
        saveSetting.run(req.params.key, valueToPersist as string, now());
      }

      const setting = db.prepare('SELECT * FROM settings WHERE key = ?').get(req.params.key);
      res.json({ setting });
    } catch (error: any) {
      console.error('[API] Internal error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

export const settingsRoutes = router;
