/** Common warning contract shared by native, WebUSB, and browser print adapters. */
export type PrintWarningKind = 'line' | 'financial' | 'configuration' | 'locale';

export interface PrintWarning {
  field: string;
  text: string;
  message: string;
  kind?: PrintWarningKind;
}

/**
 * A configured receipt logo the raster gate suppressed: the effective
 * capabilities have raster off, so no GS v 0 logo bands were emitted.
 * The logo is non-financial, so this is a configuration warning, never a
 * refusal — the receipt still prints, and the operator is told the logo
 * was dropped instead of it vanishing silently.
 */
export function makeLogoRasterSuppressedWarning(): PrintWarning {
  return {
    field: 'receipt logo',
    text: '',
    message:
      'Receipt logo was not printed because raster printing is not enabled for this printer.',
    kind: 'configuration',
  };
}
