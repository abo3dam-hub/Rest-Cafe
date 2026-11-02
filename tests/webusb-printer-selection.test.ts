/**
 * Deterministic WebUSB printer selection (assignment 037, Delivery 5: F-027).
 *
 * With several WebUSB printers the selection is never silently empty and
 * the same configured set always picks the same printer: the configured
 * default when set, otherwise the first in stable order. The same rule
 * covers the granted-device side — reconnect prefers the selected printer
 * by name, and two identical-model printers no longer fail the lookup.
 *
 * Run: npm run test:webusb-printer-selection
 */

const { assertOrThrow, assertEqualOrThrow, getResults } = require('./helpers/test-setup');
const {
  selectWebUsbPrinter,
  selectUsbDevice,
} = require('../frontend/src/lib/printer/webusb-selection');

function printer(id: string, name: string, isDefault: number, connectionType = 'webusb'): any {
  return { id, name, connection_type: connectionType, is_default: isDefault };
}

function device(
  productName: string | null,
  serialNumber: string | null,
  vendorId = 0x0483,
  productId = 0x5743,
): any {
  return { productName, serialNumber, vendorId, productId };
}

function main(): void {
  // ── Configured-printer selection ───────────────────────────────────────
  assertEqualOrThrow(
    selectWebUsbPrinter([]),
    null,
    'F-027: no WebUSB printer configured selects nothing',
  );
  assertEqualOrThrow(
    selectWebUsbPrinter([printer('net-1', 'Network', 1, 'network')]),
    null,
    'F-027: a non-WebUSB printer is never selected as the WebUSB printer',
  );
  {
    const single = selectWebUsbPrinter([printer('w-1', 'XP-80', 0)]);
    assertOrThrow(!!single, 'F-027: one WebUSB printer is selected');
    assertEqualOrThrow(single!.id, 'w-1', 'F-027: the single WebUSB printer is the selection');
  }
  {
    // Two printers, neither default: the old exactly-one rule left the
    // WebUSB path with no printer at all.
    const picked = selectWebUsbPrinter([printer('w-b', 'Zebra', 0), printer('w-a', 'Epson', 0)]);
    assertOrThrow(!!picked, 'F-027: two WebUSB printers still select one');
    assertEqualOrThrow(
      picked!.id,
      'w-a',
      'F-027: without a default the first in stable order wins',
    );
  }
  {
    const picked = selectWebUsbPrinter([printer('w-a', 'Epson', 0), printer('w-b', 'Zebra', 1)]);
    assertEqualOrThrow(picked!.id, 'w-b', 'F-027: the configured default wins over stable order');
  }
  {
    // Same name twice: the id breaks the tie deterministically.
    const first = selectWebUsbPrinter([printer('w-2', 'Same', 0), printer('w-1', 'Same', 0)]);
    const second = selectWebUsbPrinter([printer('w-1', 'Same', 0), printer('w-2', 'Same', 0)]);
    assertEqualOrThrow(first!.id, 'w-1', 'F-027: same-name printers pick the lower id');
    assertEqualOrThrow(second!.id, 'w-1', 'F-027: same-name selection is order-independent');
  }

  // ── Granted-device selection (reconnect) ───────────────────────────────
  assertEqualOrThrow(
    selectUsbDevice([], 'Epson'),
    null,
    'F-027: no granted device reconnects to nothing',
  );
  {
    const picked = selectUsbDevice([device('Zebra', 'Z1'), device('Epson', 'E1')], 'Epson');
    assertEqualOrThrow(
      picked!.productName,
      'Epson',
      'F-027: reconnect prefers the selected printer by name',
    );
    assertEqualOrThrow(picked!.serialNumber, 'E1', 'F-027: reconnect picks the named device');
  }
  {
    // The selected printer is no longer granted: fall back deterministically.
    const picked = selectUsbDevice([device('Zebra', 'Z1'), device('Epson', 'E1')], 'Missing');
    assertEqualOrThrow(
      picked!.productName,
      'Epson',
      'F-027: reconnect falls back to the first in stable order',
    );
  }
  {
    const first = selectUsbDevice([device('B', 'S2'), device('A', 'S1')]);
    const second = selectUsbDevice([device('A', 'S1'), device('B', 'S2')]);
    assertEqualOrThrow(first!.productName, 'A', 'F-027: reconnect order is stable');
    assertEqualOrThrow(second!.productName, 'A', 'F-027: reconnect order is input-independent');
  }

  // ── The ambiguous-device refusal is deliberately preserved ─────────────
  // Two granted devices sharing a product name still refuse in
  // PrinterService.findUniqueConfiguredDevice (pinned by
  // tests/printer-api.test.ts): the configured record carries no serial,
  // so picking one could send bytes to the wrong physical printer. That
  // refusal is a loud error, not the silent empty selection F-027 fixes.

  const results = getResults();
  console.log(`\nResults: ${results.passed}/${results.total} passed, ${results.failed} failed`);
  if (results.failed > 0) process.exit(1);
}

main();
