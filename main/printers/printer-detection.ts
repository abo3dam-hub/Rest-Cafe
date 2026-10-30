/** Printer detection: enumerate connected printers across macOS, Windows, Linux and IPP. */

import * as fs from 'fs';
import { ippGetDefaultPrinterName, ippGetPrinters } from './ipp-client';
import { matchSupportedPrinterProfile } from './profiles';
import { isMasBuild, sanitizePowerShellStderr } from './thermal';
import {
  capWindowsPrintDetail,
  describeWindowsPrintProcessFailure,
  execFileAsync,
} from './windows-print';

const PRINTER_DETECTION_TIMEOUT_MS = 10_000;

export type PrinterColumnWidth = 36 | 42 | 48;

export interface PrinterInfo {
  name: string;
  make: string;
  model: string;
  connectionType: 'usb' | 'network' | 'bluetooth';
  deviceUri: string;
  driver?: string;
  status: 'idle' | 'printing' | 'offline';
  isDefault: boolean;
  ipAddress?: string;
  port?: number;
  paperWidth?: string;
  profileId?: string;
}

function guessPaperWidth(name: string, model: string): string {
  const profile = matchSupportedPrinterProfile(name, model);
  if (profile) return profile.defaultPaperWidth;
  const s = (name + ' ' + model).toLowerCase();
  if (s.includes('58')) return 'cols-32';
  return 'cols-42';
}

function annotateProfile(info: Omit<PrinterInfo, 'profileId'>): PrinterInfo {
  const profile = matchSupportedPrinterProfile(info.name, info.make, info.model);
  return profile
    ? { ...info, profileId: profile.id, paperWidth: info.paperWidth || profile.defaultPaperWidth }
    : info;
}

function parseDeviceUri(uri: string): { ip?: string; port?: number } {
  const m = uri.match(/(?:socket|ipp|ipps|http|https|lpd):\/\/([^:\/\s]+)(?::(\d+))?/i);
  if (!m) return {};
  const host = m[1];
  const port = m[2] ? parseInt(m[2], 10) : undefined;
  const isIp = /^\d+\.\d+\.\d+\.\d+$/.test(host);
  return { ip: isIp ? host : host, port };
}

export async function detectConnectedPrinters(signal?: AbortSignal): Promise<PrinterInfo[]> {
  const printers: PrinterInfo[] = [];

  if (signal?.aborted) {
    return printers;
  }

  if (isMasBuild) {
    // In sandboxed MAS build, access local CUPS daemon via loopback IPP
    // instead of shelling out to lpstat/lpoptions.
    return process.platform === 'darwin' ? await detectPrintersViaIpp(signal) : printers;
  }

  if (process.platform === 'darwin') {
    return await detectMacOSPrinters(signal);
  }

  if (process.platform === 'win32') {
    return detectWindowsPrinters(signal);
  }

  if (process.platform === 'linux') {
    return detectLinuxPrinters(signal);
  }

  return printers;
}

async function detectMacOSPrinters(signal?: AbortSignal): Promise<PrinterInfo[]> {
  const printers: PrinterInfo[] = [];

  try {
    const { stdout: lpStatOutput } = await execFileAsync('lpstat', ['-v'], {
      encoding: 'utf8',
      timeout: PRINTER_DETECTION_TIMEOUT_MS,
      signal,
      maxBuffer: 10 * 1024 * 1024,
    });
    const lines = lpStatOutput.split('\n');

    const printerNames = new Set<string>();

    for (const line of lines) {
      const match = line.match(/device for (\S+):\s*(.+)/);
      if (match) {
        if (signal?.aborted) return printers;
        const name = match[1];
        const uri = match[2].trim();

        if (!printerNames.has(name)) {
          printerNames.add(name);

          const makeModel = await getMacOSPrinterDetails(name, signal);
          const isDefault = await isMacOSDefaultPrinter(name, signal);
          const status = await getMacOSPrinterStatus(name, signal);
          if (signal?.aborted) return printers;
          const isNetwork = /^(socket|ipp|ipps|http|https|lpd):\/\//i.test(uri);
          const { ip, port } = isNetwork ? parseDeviceUri(uri) : {};

          printers.push(
            annotateProfile({
              name,
              make: makeModel.make,
              model: makeModel.model,
              connectionType: isNetwork ? 'network' : 'usb',
              deviceUri: uri,
              status,
              isDefault,
              ipAddress: ip,
              port: port || (isNetwork ? 9100 : undefined),
              paperWidth: guessPaperWidth(name, makeModel.model),
            }),
          );
        }
      }
    }
  } catch (err) {
    console.log('[Printer] Could not detect macOS printers:', err);
  }

  return printers;
}

// MAS-build counterpart to detectMacOSPrinters: same CUPS queues, reached over
// local IPP instead of `lpstat`/`lpoptions` (see ipp-client.ts for why).
async function detectPrintersViaIpp(signal?: AbortSignal): Promise<PrinterInfo[]> {
  const printers: PrinterInfo[] = [];

  try {
    const [groups, defaultName] = await Promise.all([
      ippGetPrinters(signal),
      ippGetDefaultPrinterName(signal).catch(() => null),
    ]);

    for (const group of groups) {
      if (signal?.aborted) return printers;
      const name = group['printer-name']?.[0];
      if (typeof name !== 'string' || !name) continue;

      const deviceUri = String(group['device-uri']?.[0] || '');
      const makeAndModel = String(group['printer-make-and-model']?.[0] || '');
      const isNetwork = /^(socket|ipp|ipps|http|https|lpd):\/\//i.test(deviceUri);
      const { ip, port } = isNetwork ? parseDeviceUri(deviceUri) : {};
      const parsedUsb = !isNetwork ? parseCupsDeviceUri(deviceUri) : null;

      const [make, ...modelParts] = makeAndModel.split(' ');
      const model = modelParts.join(' ') || 'Thermal Printer';

      const state = group['printer-state']?.[0];
      const accepting = group['printer-is-accepting-jobs']?.[0];
      const status: 'idle' | 'printing' | 'offline' =
        accepting === false || state === 5 ? 'offline' : state === 4 ? 'printing' : 'idle';

      printers.push(
        annotateProfile({
          name,
          make: parsedUsb?.make || make || 'Unknown',
          model: parsedUsb?.model || model,
          connectionType: isNetwork ? 'network' : 'usb',
          deviceUri,
          status,
          isDefault: name === defaultName,
          ipAddress: ip,
          port: port || (isNetwork ? 9100 : undefined),
          paperWidth: guessPaperWidth(name, parsedUsb?.model || model),
        }),
      );
    }

    // When CUPS-Get-Default is unset, fall back to the single configured printer.
    if (!defaultName && printers.length === 1) {
      printers[0].isDefault = true;
    }
  } catch (err) {
    console.log('[Printer] Could not detect printers via local IPP:', err);
  }

  return printers;
}

async function getMacOSPrinterStatus(
  name: string,
  signal?: AbortSignal,
): Promise<'idle' | 'printing' | 'offline'> {
  try {
    const { stdout } = await execFileAsync('lpstat', ['-p', name], {
      encoding: 'utf8',
      timeout: PRINTER_DETECTION_TIMEOUT_MS,
      signal,
      maxBuffer: 10 * 1024 * 1024,
    });
    const out = stdout.toLowerCase();
    if (out.includes('disabled')) return 'offline';
    if (out.includes('printing') || out.includes('now printing')) return 'printing';
    return 'idle';
  } catch {
    return 'offline';
  }
}

async function getMacOSPrinterDetails(
  name: string,
  signal?: AbortSignal,
): Promise<{ make: string; model: string }> {
  let make = 'Unknown';
  let model = 'Thermal Printer';

  try {
    const { stdout: info } = await execFileAsync('lpoptions', ['-p', name, '-l'], {
      encoding: 'utf8',
      timeout: PRINTER_DETECTION_TIMEOUT_MS,
      signal,
      maxBuffer: 10 * 1024 * 1024,
    });

    const lower = info.toLowerCase();

    if (lower.includes('epson') || name.toLowerCase().includes('tm-')) {
      make = 'Epson';
      model = extractEpsonModel(name, info);
    } else if (lower.includes('xprinter') || name.toLowerCase().includes('xprinter')) {
      make = 'Xprinter';
      model = name.includes('80') ? 'Xprinter 80mm' : 'Xprinter 58mm';
    } else if (lower.includes('star') || name.toLowerCase().includes('tsp')) {
      make = 'Star';
      model = 'TSP Thermal';
    } else if (lower.includes('zjiang') || name.toLowerCase().includes('zj')) {
      make = 'Zjiang';
      model = '58mm Thermal';
    } else if (lower.includes('zebra')) {
      make = 'Zebra';
      model = 'Zebra Thermal';
    } else if (lower.includes('brother')) {
      make = 'Brother';
      model = 'Brother Thermal';
    } else if (lower.includes('canon')) {
      make = 'Canon';
      model = 'Canon Printer';
    } else if (lower.includes('hp') || lower.includes('hewlett')) {
      make = 'HP';
      model = 'HP Printer';
    } else {
      const nameLower = name.toLowerCase();
      if (nameLower.includes('58') || nameLower.includes('thermal')) {
        make = 'Generic';
        model = '58mm Thermal Printer';
      } else if (nameLower.includes('80')) {
        make = 'Generic';
        model = '80mm Thermal Printer';
      }
    }
  } catch {
    const nameLower = name.toLowerCase();
    if (nameLower.includes('epson') || nameLower.includes('tm-')) {
      make = 'Epson';
      model = 'TM Series';
    } else if (nameLower.includes('xprinter')) {
      make = 'Xprinter';
      model = nameLower.includes('80') ? 'Xprinter 80mm' : 'Xprinter 58mm';
    }
  }

  return { make, model };
}

function extractEpsonModel(name: string, _info: string): string {
  const lower = name.toLowerCase();
  if (lower.includes('tm-m30')) return 'TM-m30';
  if (lower.includes('tm-t88')) return 'TM-T88';
  if (lower.includes('tm-t82')) return 'TM-T82';
  if (lower.includes('tm-t20')) return 'TM-T20';
  if (lower.includes('tm-t60')) return 'TM-T60';
  if (lower.includes('tm-l90')) return 'TM-L90';
  if (lower.includes('tm-h600')) return 'TM-H600';
  if (lower.includes('tm-u')) return 'TM-U Series';
  if (lower.includes('tm-')) return 'TM Series';
  return 'Epson Thermal';
}

async function isMacOSDefaultPrinter(name: string, signal?: AbortSignal): Promise<boolean> {
  try {
    const { stdout: defaultPrinter } = await execFileAsync('lpstat', ['-d'], {
      encoding: 'utf8',
      timeout: PRINTER_DETECTION_TIMEOUT_MS,
      signal,
      maxBuffer: 10 * 1024 * 1024,
    });
    return defaultPrinter.includes(name);
  } catch {
    return false;
  }
}

// Windows PowerShell 5.1 encodes redirected stdout/stderr with the console/OEM
// code page, so decoding those bytes as UTF-8 turns accented diagnostics into
// replacement characters. Every helper therefore switches its .NET writers to
// UTF-8 explicitly, and the console code page too where a console exists. The
// module-loading progress record is silenced because it is framing, not a
// device reason. Best-effort on purpose: this must never be able to break
// printing, so a failure here leaves the default streams in place.
const POWERSHELL_UTF8_PRELUDE = `
$ProgressPreference = 'SilentlyContinue'
try {
  $floUtf8 = New-Object -TypeName System.Text.UTF8Encoding -ArgumentList $false
  $floOut = New-Object -TypeName System.IO.StreamWriter -ArgumentList ([Console]::OpenStandardOutput()), $floUtf8
  $floErr = New-Object -TypeName System.IO.StreamWriter -ArgumentList ([Console]::OpenStandardError()), $floUtf8
  $floOut.AutoFlush = $true
  $floErr.AutoFlush = $true
  [Console]::SetOut($floOut)
  [Console]::SetError($floErr)
  [Console]::OutputEncoding = $floUtf8
} catch { }
`;

/** Command line for a Windows PowerShell helper, with the UTF-8 stream
 * contract prefixed so no helper can emit console-code-page output. */
export function windowsPowerShellCommandArgs(script: string): string[] {
  return [
    '-NoProfile',
    '-NonInteractive',
    '-EncodedCommand',
    Buffer.from(`${POWERSHELL_UTF8_PRELUDE}${script}`, 'utf16le').toString('base64'),
  ];
}

// Enumerate printers via Get-CimInstance (Win32_Printer) using -EncodedCommand.
const DETECT_WINDOWS_PRINTERS_SCRIPT = `
$ErrorActionPreference = 'Stop'
try {
  Get-CimInstance -ClassName Win32_Printer -Property Name,Default,PrinterStatus,DriverName |
    Select-Object Name,Default,PrinterStatus,DriverName |
    ConvertTo-Json -Compress
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  [Console]::Error.Flush()
  exit 1
}
`;

// Win32_Printer.PrinterStatus: 1=Other, 2=Unknown, 3=Idle, 4=Printing, 5=Warming Up, 6=Stopped Printing, 7=Offline.
function mapWindowsPrinterStatus(printerStatus: unknown): 'idle' | 'printing' | 'offline' {
  if (printerStatus === 3 || printerStatus === 5) return 'idle';
  if (printerStatus === 4) return 'printing';
  return 'offline';
}

async function detectWindowsPrinters(signal?: AbortSignal): Promise<PrinterInfo[]> {
  const printers: PrinterInfo[] = [];

  try {
    const { stdout } = await execFileAsync(
      'powershell',
      windowsPowerShellCommandArgs(DETECT_WINDOWS_PRINTERS_SCRIPT),
      {
        encoding: 'utf8',
        timeout: PRINTER_DETECTION_TIMEOUT_MS,
        signal,
        windowsHide: true,
        maxBuffer: 10 * 1024 * 1024,
      },
    );

    const trimmed = stdout.trim();
    if (trimmed && trimmed !== 'null') {
      const parsed = JSON.parse(trimmed);
      const entries = Array.isArray(parsed) ? parsed : [parsed];

      for (const entry of entries) {
        const name = typeof entry?.Name === 'string' ? entry.Name.trim() : '';
        if (!name) continue;

        const driver = typeof entry.DriverName === 'string' ? entry.DriverName : '';
        const makeModel = detectWindowsMakeModel(name, driver);

        printers.push(
          annotateProfile({
            name,
            make: makeModel.make,
            model: makeModel.model,
            connectionType: 'usb',
            deviceUri: name,
            driver,
            status: mapWindowsPrinterStatus(entry.PrinterStatus),
            isDefault: entry.Default === true,
            paperWidth: guessPaperWidth(name, makeModel.model),
          }),
        );
      }
    }
  } catch (err) {
    // The detection script is also passed as -EncodedCommand, and the app log
    // tail is attached to support tickets, so the raw error (whose message
    // embeds the command line) must never be logged.
    const rawDetail =
      sanitizePowerShellStderr(String((err as { stderr?: unknown })?.stderr || '').trim()) ||
      describeWindowsPrintProcessFailure(err);
    const detail = capWindowsPrintDetail(rawDetail);
    console.log(`[Printer] Could not detect Windows printers via Get-CimInstance: ${detail}`);
  }

  return printers;
}

function detectWindowsMakeModel(name: string, driver: string): { make: string; model: string } {
  let make = 'Unknown';
  let model = 'Thermal Printer';

  const lower = (name + ' ' + driver).toLowerCase();

  if (lower.includes('epson') || name.toLowerCase().includes('tm-')) {
    make = 'Epson';
    model = name.includes('TM-m30')
      ? 'TM-m30'
      : name.includes('TM-T88')
        ? 'TM-T88'
        : name.includes('TM-T82')
          ? 'TM-T82'
          : name.includes('TM-T20')
            ? 'TM-T20'
            : 'TM Series';
  } else if (lower.includes('xprinter')) {
    make = 'Xprinter';
    model = lower.includes('80') ? 'Xprinter 80mm' : 'Xprinter 58mm';
  } else if (lower.includes('star') || lower.includes('tsp')) {
    make = 'Star';
    model = 'TSP Thermal';
  } else if (lower.includes('zjiang')) {
    make = 'Zjiang';
    model = '58mm Thermal';
  } else if (lower.includes('zebra')) {
    make = 'Zebra';
    model = 'Zebra Thermal';
  } else if (lower.includes('brother')) {
    make = 'Brother';
    model = 'Brother Thermal';
  } else if (lower.includes('58') || lower.includes('thermal')) {
    make = 'Generic';
    model = '58mm Thermal';
  } else if (lower.includes('80')) {
    make = 'Generic';
    model = '80mm Thermal';
  }

  return { make, model };
}

// USB vendor ID lookup for common thermal printer brands
const THERMAL_PRINTER_VENDORS: Record<string, string> = {
  '04b8': 'Epson',
  '0456': 'Xprinter',
  '0519': 'Star Micronics',
  '0525': 'Star Micronics',
  '0416': 'Zjiang',
  '0419': 'Bixolon',
  '1d90': 'Citizen',
  '04f9': 'Brother',
};

// Bridge chip vendor IDs (not printer brands — these identify the USB-to-serial chip)
const BRIDGE_CHIP_VENDORS = new Set(['1a86', '10c4', '0403']);

function parseCupsDeviceUri(uri: string): { make: string; model: string } | null {
  // USB URIs look like: usb://Epson/TM-T88V?serial=ABC123
  const usbMatch = uri.match(/usb:\/\/([^/?]+)\/([^?]+)/);
  if (usbMatch) {
    return { make: decodeURIComponent(usbMatch[1]), model: decodeURIComponent(usbMatch[2]) };
  }
  // Network URIs look like: socket://192.168.1.100:9100
  return null;
}

async function getMakeModelFromLpstat(
  signal?: AbortSignal,
): Promise<Map<string, { make: string; model: string }>> {
  const result = new Map<string, { make: string; model: string }>();
  try {
    const { stdout: output } = await execFileAsync('lpstat', ['-l', '-p'], {
      encoding: 'utf8',
      timeout: PRINTER_DETECTION_TIMEOUT_MS,
      signal,
      maxBuffer: 10 * 1024 * 1024,
    });
    let currentName = '';
    for (const line of output.split('\n')) {
      const nameMatch = line.match(/^printer (\S+) is/);
      if (nameMatch) currentName = nameMatch[1];
      const uriMatch = line.match(/Device URI:\s*(.+)/);
      if (uriMatch && currentName) {
        const parsed = parseCupsDeviceUri(uriMatch[1].trim());
        if (parsed) result.set(currentName, parsed);
      }
    }
  } catch {
    /* CUPS not available */
  }
  return result;
}

function getUsbPrinterVendorIds(): Map<
  string,
  { vendorId: string; manufacturer: string | null; product: string | null }
> {
  const result = new Map<
    string,
    { vendorId: string; manufacturer: string | null; product: string | null }
  >();
  const devicesDir = '/sys/bus/usb/devices';
  try {
    const entries = fs.readdirSync(devicesDir);
    for (const entry of entries) {
      if (entry.includes(':')) continue; // skip interfaces
      const devPath = `${devicesDir}/${entry}`;
      try {
        const devClass = fs.readFileSync(`${devPath}/bDeviceClass`, 'utf8').trim();
        if (devClass !== '07') continue; // 07 = USB printer class
        const vendorId = fs.readFileSync(`${devPath}/idVendor`, 'utf8').trim();
        const manufacturer = readSysfsSafe(`${devPath}/manufacturer`);
        const product = readSysfsSafe(`${devPath}/product`);
        result.set(entry, { vendorId, manufacturer, product });
      } catch {
        /* skip device */
      }
    }
  } catch {
    /* sysfs not available */
  }
  return result;
}

function readSysfsSafe(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf8').trim();
  } catch {
    return null;
  }
}

async function detectLinuxPrinters(signal?: AbortSignal): Promise<PrinterInfo[]> {
  const printers: PrinterInfo[] = [];

  try {
    // Layer 1: Get make/model from CUPS Device URI (most reliable)
    const cupsMakeModel = await getMakeModelFromLpstat(signal);
    if (signal?.aborted) return printers;

    // Layer 2: Get USB vendor IDs from sysfs (works without CUPS)
    const usbVendors = getUsbPrinterVendorIds();

    // Get printer list from CUPS
    const { stdout: output } = await execFileAsync('lpstat', ['-v'], {
      encoding: 'utf8',
      timeout: PRINTER_DETECTION_TIMEOUT_MS,
      signal,
      maxBuffer: 10 * 1024 * 1024,
    });
    const lines = output.split('\n');

    for (const line of lines) {
      if (signal?.aborted) return printers;
      const match = line.match(/device for (\S+):\s*(.+)/);
      if (match) {
        const name = match[1];
        const uri = match[2].trim();
        const isNetwork = /^(socket|ipp|ipps|http|https|lpd):\/\//i.test(uri);
        const { ip, port } = isNetwork ? parseDeviceUri(uri) : {};

        // Try CUPS Device URI first, then fall back to Generic
        const cupsInfo = cupsMakeModel.get(name);
        let make = cupsInfo?.make || 'Generic';
        let model = cupsInfo?.model || 'Thermal Printer';

        // For USB printers without CUPS info, try sysfs vendor ID lookup
        if (!cupsInfo && !isNetwork) {
          for (const [, vendorInfo] of usbVendors) {
            // Skip bridge chips — they identify the serial adapter, not the printer
            if (BRIDGE_CHIP_VENDORS.has(vendorInfo.vendorId.toLowerCase())) {
              // But if sysfs has manufacturer/product strings, use those
              if (vendorInfo.manufacturer && vendorInfo.product) {
                make = vendorInfo.manufacturer;
                model = vendorInfo.product;
              }
              continue;
            }
            const vendorMake = THERMAL_PRINTER_VENDORS[vendorInfo.vendorId.toLowerCase()];
            if (vendorMake) {
              make = vendorMake;
              model = vendorInfo.product || 'Thermal Printer';
              break;
            }
          }
        }

        printers.push(
          annotateProfile({
            name,
            make,
            model,
            connectionType: isNetwork ? 'network' : 'usb',
            deviceUri: uri,
            status: 'idle',
            isDefault: false,
            ipAddress: ip,
            port: port || (isNetwork ? 9100 : undefined),
            paperWidth: guessPaperWidth(name, model),
          }),
        );
      }
    }
  } catch {
    console.log('[Printer] Could not detect Linux printers');
  }

  return printers;
}
