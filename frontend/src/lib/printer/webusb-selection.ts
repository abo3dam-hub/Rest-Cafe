/**
 * Deterministic WebUSB printer selection (assignment 037, Delivery 5: F-027).
 *
 * Pure functions, no USB or DOM access, so they are unit-testable: with
 * several WebUSB printers the selection is never silently empty, and the
 * same configured set always picks the same printer. Ordering is by plain
 * code-unit comparison, never locale-dependent, so it is stable across
 * machines.
 */

/** Minimal shape of a configured printer the selection needs. */
export interface WebUsbPrinterCandidate {
  id: string;
  name: string;
  connection_type: string;
  is_default: number;
}

/** Minimal shape of a granted USB device the selection needs. */
export interface UsbDeviceCandidate {
  productName?: string | null;
  serialNumber?: string | null;
  vendorId: number;
  productId: number;
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/** Stable order for configured printers: name first, id breaks ties. */
export function compareWebUsbPrinters(
  left: WebUsbPrinterCandidate,
  right: WebUsbPrinterCandidate,
): number {
  return compareText(left.name, right.name) || compareText(left.id, right.id);
}

/**
 * Pick the WebUSB printer to print through: the configured default when
 * there is one, otherwise the first in stable order. Never null while at
 * least one WebUSB printer is configured — with two printers the old
 * exactly-one rule silently left the WebUSB path with no printer at all.
 * Generic so callers keep their concrete printer type.
 */
export function selectWebUsbPrinter<T extends WebUsbPrinterCandidate>(
  printers: readonly T[],
): T | null {
  const webusb = printers.filter((printer) => printer.connection_type === 'webusb');
  if (webusb.length === 0) return null;
  const sorted = [...webusb].sort(compareWebUsbPrinters);
  return sorted.find((printer) => printer.is_default === 1) ?? sorted[0];
}

/** Stable order for granted USB devices: name, serial, ids. */
export function compareUsbDevices(left: UsbDeviceCandidate, right: UsbDeviceCandidate): number {
  return (
    compareText(left.productName ?? '', right.productName ?? '') ||
    compareText(left.serialNumber ?? '', right.serialNumber ?? '') ||
    left.vendorId - right.vendorId ||
    left.productId - right.productId
  );
}

/**
 * Pick the granted device to re-attach to: the one whose product name
 * matches the selected configured printer when it is still granted,
 * otherwise the first in stable order — never an arbitrary devices[0].
 * Generic so callers keep their concrete device type.
 */
export function selectUsbDevice<T extends UsbDeviceCandidate>(
  devices: readonly T[],
  preferredProductName?: string | null,
): T | null {
  if (devices.length === 0) return null;
  const sorted = [...devices].sort(compareUsbDevices);
  if (preferredProductName) {
    const preferred = sorted.find((device) => device.productName === preferredProductName);
    if (preferred) return preferred;
  }
  return sorted[0];
}
