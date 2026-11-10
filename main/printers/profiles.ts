import {
  GENERIC_THERMAL_CAPABILITIES,
  LATIN_THERMAL_CAPABILITIES,
  mergeThermalCapabilities,
  type ThermalPrinterCapabilities,
} from '../../shared/print/thermal-capabilities';

export type PrinterCommandSet = 'escpos';
export type PrinterCutMode = 'full' | 'partial';

export interface SupportedPrinterProfile {
  id: string;
  make: string;
  model: string;
  aliases: string[];
  commandSet: PrinterCommandSet;
  defaultPaperWidth:
    | 'cols-32'
    | 'cols-36'
    | 'cols-40'
    | 'cols-42'
    | 'cols-44'
    | 'cols-48'
    | '58mm'
    | '58mm-36'
    | '80mm-42'
    | '80mm';
  defaultPort: number;
  fontAColumns: number;
  fontBColumns: number;
  printWidthMm?: number;
  cutMode: PrinterCutMode;
  /** Legacy override for Arabic shaping capability. @deprecated Use capabilities.shaping.arabic. */
  arabicShaping?: boolean;
  /** Text encoding, shaping, representability, transliteration, and warning policy. */
  capabilities: ThermalPrinterCapabilities;
  notes?: string;
}

export const SUPPORTED_PRINTER_PROFILES: SupportedPrinterProfile[] = [
  {
    id: 'xprinter-xp-v320m-v330m',
    make: 'Xprinter',
    model: 'XP-V320M / XP-V330M',
    aliases: ['xprinter xp-v320m', 'xprinter xp-v330m', 'xp-v320m', 'xp-v330m', 'v320m', 'v330m'],
    commandSet: 'escpos',
    defaultPaperWidth: 'cols-48',
    defaultPort: 9100,
    fontAColumns: 48,
    fontBColumns: 64,
    printWidthMm: 72,
    cutMode: 'partial',
    capabilities: {
      ...LATIN_THERMAL_CAPABILITIES,
      raster: {
        enabled: true,
        widthDots: 576,
        maxBandHeight: 200,
        modes: ['mixed'],
      },
    },
    notes:
      '80mm ESC/POS receipt printer. This profile declares 72mm print width and 576 dots/line, which is 48 Font A and 64 Font B columns; vendor listings also give 42/56 for the 512-dot variant, which stays selectable as 80mm-42 / cols-42.',
  },
  {
    id: 'epson-tm-series',
    make: 'Epson',
    model: 'TM Series ESC/POS',
    aliases: ['epson tm', 'tm-t88', 'tm-t82', 'tm-t20', 'tm-m30'],
    commandSet: 'escpos',
    defaultPaperWidth: 'cols-48',
    defaultPort: 9100,
    fontAColumns: 48,
    fontBColumns: 64,
    cutMode: 'partial',
    capabilities: {
      ...LATIN_THERMAL_CAPABILITIES,
      raster: {
        enabled: true,
        widthDots: 576,
        maxBandHeight: 200,
        modes: ['mixed'],
      },
    },
  },
  {
    id: 'generic-escpos-80',
    make: 'Generic',
    model: 'ESC/POS 80mm',
    aliases: ['generic 80mm', '80mm thermal', 'thermal 80'],
    commandSet: 'escpos',
    defaultPaperWidth: 'cols-48',
    defaultPort: 9100,
    fontAColumns: 48,
    fontBColumns: 64,
    cutMode: 'full',
    capabilities: {
      ...GENERIC_THERMAL_CAPABILITIES,
      encoding: { codePages: ['ascii'], preferredCodePage: 'ascii' },
      // Conservative baseline: an unidentified printer must not be assumed
      // to implement GS v 0 raster. Raster is gained per printer only after
      // the owner validates it with a raster test print (see
      // validatedGenericRaster / isRasterValidatedForPrinter below).
      raster: {
        enabled: false,
        widthDots: 0,
        maxBandHeight: 0,
        modes: [],
      },
    },
  },
  {
    id: 'generic-escpos-58',
    make: 'Generic',
    model: 'ESC/POS 58mm',
    aliases: ['generic 58mm', '58mm thermal', 'thermal 58'],
    commandSet: 'escpos',
    defaultPaperWidth: 'cols-32',
    defaultPort: 9100,
    fontAColumns: 32,
    fontBColumns: 56,
    cutMode: 'full',
    capabilities: {
      ...GENERIC_THERMAL_CAPABILITIES,
      encoding: { codePages: ['ascii'], preferredCodePage: 'ascii' },
      // Conservative baseline, as generic-escpos-80 above.
      raster: {
        enabled: false,
        widthDots: 0,
        maxBandHeight: 0,
        modes: [],
      },
    },
  },
];

export function getSupportedPrinterProfiles(): SupportedPrinterProfile[] {
  return SUPPORTED_PRINTER_PROFILES;
}

export function matchSupportedPrinterProfile(
  ...parts: Array<string | null | undefined>
): SupportedPrinterProfile | null {
  const haystack = parts.filter(Boolean).join(' ').toLowerCase().replace(/[_]+/g, '-');

  if (!haystack) return null;

  for (const profile of SUPPORTED_PRINTER_PROFILES) {
    const tokens = [`${profile.make} ${profile.model}`, profile.model, ...profile.aliases].map(
      (s) => s.toLowerCase(),
    );
    if (tokens.some((token) => haystack.includes(token))) return profile;
  }

  return null;
}

export function resolvePrinterProfile(printer: any): SupportedPrinterProfile {
  const explicit = printer?.profile_id || printer?.profileId;
  if (explicit) {
    const profile = SUPPORTED_PRINTER_PROFILES.find((p) => p.id === explicit);
    if (profile) return profile;
  }

  const matched = matchSupportedPrinterProfile(printer?.name, printer?.make, printer?.model);
  if (matched) return matched;

  const paperWidth = printer?.paper_width || printer?.paperWidth;
  return String(paperWidth || '').startsWith('58mm')
    ? SUPPORTED_PRINTER_PROFILES.find((p) => p.id === 'generic-escpos-58')!
    : SUPPORTED_PRINTER_PROFILES.find((p) => p.id === 'generic-escpos-80')!;
}

export function getPrinterCapabilities(
  profile: SupportedPrinterProfile,
  arabicShapingOverride?: boolean,
): ThermalPrinterCapabilities {
  return mergeThermalCapabilities(
    profile.capabilities || GENERIC_THERMAL_CAPABILITIES,
    arabicShapingOverride,
  );
}

export const GENERIC_PRINTER_PROFILE_IDS = ['generic-escpos-80', 'generic-escpos-58'] as const;

export function isGenericPrinterProfile(
  profile: SupportedPrinterProfile | null | undefined,
): boolean {
  return !!profile && (GENERIC_PRINTER_PROFILE_IDS as readonly string[]).includes(profile.id);
}

/**
 * Raster a generic profile gains only after per-printer validation: the
 * values the generic profiles declared before the validated opt-in, so a
 * validated printer's printed bytes are identical to the old generic
 * raster output.
 */
export function validatedGenericRaster(
  profile: SupportedPrinterProfile,
): ThermalPrinterCapabilities['raster'] {
  return {
    enabled: true,
    widthDots: profile.id === 'generic-escpos-58' ? 384 : 576,
    maxBandHeight: 200,
    modes: ['mixed'],
  };
}

/**
 * Whether the stored printer row carries a raster validation that still
 * applies: the flag is set and it was validated for this exact printer —
 * same stored name, same resolved profile, same paper width. Changing any
 * of those resets validation at read time; no write path has to remember.
 */
export function isRasterValidatedForPrinter(
  printer: any,
  profile?: SupportedPrinterProfile,
): boolean {
  if (!printer || Number(printer.raster_validated) !== 1) return false;
  const resolved = profile ?? resolvePrinterProfile(printer);
  if (!isGenericPrinterProfile(resolved)) return false;
  if (printer.raster_validated_profile_id !== resolved.id) return false;
  const paperWidth = printer.paper_width || resolved.defaultPaperWidth;
  if (printer.raster_validated_paper_width !== paperWidth) return false;
  if (printer.raster_validated_printer_name !== printer.name) return false;
  return true;
}

/**
 * Capabilities a raster probe print uses: the printer's declared raster
 * when it has one, otherwise the validated raster the probe is testing
 * (generic profiles only). A probe never depends on a validation flag.
 */
export function rasterProbeCapabilities(
  profile: SupportedPrinterProfile,
  paperWidth: string | null | undefined,
  arabicShapingOverride?: boolean,
): ThermalPrinterCapabilities {
  return capabilitiesForPrinter(
    profile,
    paperWidth,
    arabicShapingOverride,
    isGenericPrinterProfile(profile),
  );
}

/** Maps paper_width string to canonical raster dot width, or null if unrecognized. */
export function dotsForPaperWidth(paperWidth: string): number | null {
  const colsMatch = String(paperWidth || '').match(/^cols-(3[2-9]|4[0-8])$/);
  const cols = colsMatch
    ? Number(colsMatch[1])
    : (({ '58mm': 32, '58mm-36': 36, '80mm-42': 42, '80mm': 48 } as Record<string, number>)[
        paperWidth
      ] ?? null);
  if (cols === null) return null;
  if (cols <= 32) return 384;
  if (cols <= 36) return 432;
  if (cols <= 40) return 480;
  return 576;
}

/** Returns printer capabilities, capping raster widthDots if paper_width is narrower than hardware. A validated generic printer gains the validated raster before capping. */
export function capabilitiesForPrinter(
  profile: SupportedPrinterProfile,
  paperWidth: string | null | undefined,
  arabicShapingOverride?: boolean,
  rasterValidated = false,
): ThermalPrinterCapabilities {
  let capabilities = getPrinterCapabilities(profile, arabicShapingOverride);
  if (isGenericPrinterProfile(profile) && rasterValidated) {
    capabilities = { ...capabilities, raster: validatedGenericRaster(profile) };
  }
  if (!capabilities.raster.enabled || !capabilities.raster.widthDots) return capabilities;
  const configuredDots = dotsForPaperWidth(String(paperWidth || ''));
  if (configuredDots === null || configuredDots >= capabilities.raster.widthDots)
    return capabilities;
  return { ...capabilities, raster: { ...capabilities.raster, widthDots: configuredDots } };
}
