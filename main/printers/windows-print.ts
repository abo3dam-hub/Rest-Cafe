/** Windows printing: spooler transport (runtime-compiled C#) + Windows print failure reporting. */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import {
  classifyPrintFailure,
  extractPlatformErrorCode,
  getPrinterConfig,
  sanitizePowerShellStderr,
  windowsPowerShellCommandArgs,
  type DispatchResult,
} from './thermal';

// Write raw ESC/POS directly to Windows spooler via runtime-compiled C# (Add-Type).
// NOTE: no backslash escapes, backticks, or template expressions allowed in source.
const WINSPOOL_HELPER_SOURCE = `
using System;
using System.Runtime.InteropServices;

public static class FloRawPrinter {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private class DOCINFO {
        [MarshalAs(UnmanagedType.LPWStr)] public string pDocName;
        [MarshalAs(UnmanagedType.LPWStr)] public string pOutputFile;
        [MarshalAs(UnmanagedType.LPWStr)] public string pDataType;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PRINTER_INFO_2 {
        public IntPtr pServerName;
        public IntPtr pPrinterName;
        public IntPtr pShareName;
        public IntPtr pPortName;
        public IntPtr pDriverName;
        public IntPtr pComment;
        public IntPtr pLocation;
        public IntPtr pDevMode;
        public IntPtr pSepFile;
        public IntPtr pPrintProcessor;
        public IntPtr pDatatype;
        public IntPtr pParameters;
        public IntPtr pSecurityDescriptor;
        public uint Attributes;
        public uint Priority;
        public uint DefaultPriority;
        public uint StartTime;
        public uint UntilTime;
        public uint Status;
        public uint cJobs;
        public uint AveragePPM;
    }

    [DllImport("winspool.drv", EntryPoint = "OpenPrinterW", SetLastError = true, CharSet = CharSet.Unicode, ExactSpelling = true)]
    private static extern bool OpenPrinter(string pPrinterName, out IntPtr phPrinter, IntPtr pDefault);

    [DllImport("winspool.drv", EntryPoint = "ClosePrinter", SetLastError = true, ExactSpelling = true)]
    private static extern bool ClosePrinter(IntPtr hPrinter);

    [DllImport("winspool.drv", EntryPoint = "GetPrinterW", SetLastError = true, CharSet = CharSet.Unicode, ExactSpelling = true)]
    private static extern bool GetPrinter(IntPtr hPrinter, int Level, IntPtr pPrinter, uint cbBuf, out uint pcbNeeded);

    [DllImport("winspool.drv", EntryPoint = "StartDocPrinterW", SetLastError = true, CharSet = CharSet.Unicode, ExactSpelling = true)]
    private static extern uint StartDocPrinter(IntPtr hPrinter, int Level, [In] DOCINFO pDocInfo);

    [DllImport("winspool.drv", EntryPoint = "EndDocPrinter", SetLastError = true, ExactSpelling = true)]
    private static extern bool EndDocPrinter(IntPtr hPrinter);

    [DllImport("winspool.drv", EntryPoint = "StartPagePrinter", SetLastError = true, ExactSpelling = true)]
    private static extern bool StartPagePrinter(IntPtr hPrinter);

    [DllImport("winspool.drv", EntryPoint = "EndPagePrinter", SetLastError = true, ExactSpelling = true)]
    private static extern bool EndPagePrinter(IntPtr hPrinter);

    [DllImport("winspool.drv", EntryPoint = "WritePrinter", SetLastError = true, ExactSpelling = true)]
    private static extern bool WritePrinter(IntPtr hPrinter, byte[] pBytes, int dwCount, out int dwWritten);

    private const uint PRINTER_ATTRIBUTE_WORK_OFFLINE = 0x00000400;

    private static string DescribeBlockingState(uint status, uint attributes) {
        if ((attributes & PRINTER_ATTRIBUTE_WORK_OFFLINE) != 0) return "printer is set to 'Use Printer Offline' in Windows";
        if ((status & 0x00000080) != 0) return "printer is offline";
        if ((status & 0x00001000) != 0) return "printer is not available";
        if ((status & 0x00000010) != 0) return "printer is out of paper";
        if ((status & 0x00000008) != 0) return "printer has a paper jam";
        if ((status & 0x00400000) != 0) return "printer cover is open";
        if ((status & 0x00100000) != 0) return "printer needs attention";
        if ((status & 0x00000002) != 0) return "printer reported an error";
        return null;
    }

    // OpenPrinter succeeds against the queue even when the device is unplugged,
    // so without this the job would silently spool and we would report success.
    private static void EnsureReady(IntPtr hPrinter) {
        uint needed = 0;
        GetPrinter(hPrinter, 2, IntPtr.Zero, 0, out needed);
        if (needed == 0) return;

        IntPtr buf = Marshal.AllocHGlobal((int)needed);
        try {
            uint unused = 0;
            if (!GetPrinter(hPrinter, 2, buf, needed, out unused)) return;
            PRINTER_INFO_2 info = (PRINTER_INFO_2)Marshal.PtrToStructure(buf, typeof(PRINTER_INFO_2));
            string problem = DescribeBlockingState(info.Status, info.Attributes);
            if (problem != null) throw new Exception(problem);
        } finally {
            Marshal.FreeHGlobal(buf);
        }
    }

    public static uint SendRaw(string printerName, byte[] bytes) {
        IntPtr hPrinter = IntPtr.Zero;
        if (!OpenPrinter(printerName, out hPrinter, IntPtr.Zero))
            throw new Exception("cannot open printer '" + printerName + "' (Win32 error " + Marshal.GetLastWin32Error() + ")");

        try {
            EnsureReady(hPrinter);

            DOCINFO docInfo = new DOCINFO();
            docInfo.pDocName = "Rest&Cafe Receipt";
            docInfo.pDataType = "RAW";

            uint jobId = StartDocPrinter(hPrinter, 1, docInfo);
            if (jobId == 0)
                throw new Exception("StartDocPrinter failed (Win32 error " + Marshal.GetLastWin32Error() + ")");

            try {
                if (!StartPagePrinter(hPrinter))
                    throw new Exception("StartPagePrinter failed (Win32 error " + Marshal.GetLastWin32Error() + ")");

                int written = 0;
                if (!WritePrinter(hPrinter, bytes, bytes.Length, out written))
                    throw new Exception("WritePrinter failed (Win32 error " + Marshal.GetLastWin32Error() + ")");
                if (written != bytes.Length)
                    throw new Exception("WritePrinter accepted " + written + " of " + bytes.Length + " bytes");

                EndPagePrinter(hPrinter);
            } finally {
                EndDocPrinter(hPrinter);
            }

            return jobId;
        } finally {
            ClosePrinter(hPrinter);
        }
    }
}
`;

// Executed as -EncodedCommand to bypass ExecutionPolicy restrictions on script files.
// Arguments passed via environment variables to avoid script parsing issues.
const WINSPOOL_HELPER_SCRIPT = `
$ErrorActionPreference = 'Stop'
try {
  $name = $env:FLO_PRINTER_NAME
  $file = $env:FLO_PRINT_FILE
  if ([string]::IsNullOrEmpty($name)) { throw 'no printer name supplied' }
  if ([string]::IsNullOrEmpty($file)) { throw 'no payload file supplied' }

  # Best-effort metadata for Tier-2 diagnostics. This is never included in the
  # anonymous telemetry payload and must not prevent the raw print attempt.
  try {
    $printerInfo = Get-CimInstance -ClassName Win32_Printer -Property Name,PrinterStatus,DriverName |
      Where-Object { $_.Name -eq $name } |
      Select-Object -First 1 Name,PrinterStatus,DriverName
    if ($printerInfo) {
      Write-Output ('FLO_PRINTER_INFO=' + ($printerInfo | ConvertTo-Json -Compress))
    }
  } catch { }

  Add-Type -TypeDefinition @'
${WINSPOOL_HELPER_SOURCE}
'@

  $bytes = [System.IO.File]::ReadAllBytes($file)
  $jobId = [FloRawPrinter]::SendRaw($name, $bytes)
  Write-Output ('FLO_JOB_ID=' + $jobId)
  exit 0
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  [Console]::Error.Flush()
  exit 1
}
`;

export const execFileAsync = promisify(execFile);

function parseWindowsPrintOutput(
  output: unknown,
): Pick<DispatchResult, 'jobId' | 'driverName' | 'printerStatus'> {
  const outputLines = String(output || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const jobLine = outputLines.find((line) => line.startsWith('FLO_JOB_ID='));
  const infoLine = outputLines.find((line) => line.startsWith('FLO_PRINTER_INFO='));
  const parsed: Pick<DispatchResult, 'jobId' | 'driverName' | 'printerStatus'> = {};

  if (jobLine) {
    const jobId = Number(jobLine.slice('FLO_JOB_ID='.length));
    if (Number.isSafeInteger(jobId) && jobId > 0) parsed.jobId = jobId;
  }
  if (infoLine) {
    try {
      const info = JSON.parse(infoLine.slice('FLO_PRINTER_INFO='.length)) as {
        DriverName?: unknown;
        PrinterStatus?: unknown;
      };
      if (typeof info.DriverName === 'string' && info.DriverName.trim())
        parsed.driverName = info.DriverName.trim();
      if (typeof info.PrinterStatus === 'number') parsed.printerStatus = info.PrinterStatus;
    } catch {
      /* diagnostics metadata is best-effort */
    }
  }
  return parsed;
}

// Node's execFile error message embeds the complete command line, which for the
// raw-print helper is `powershell ... -EncodedCommand <base64>`. Process-level
// failures (timeout, kill, launch failure) report an empty stderr, so that
// message must never become the printer detail.
const WINDOWS_PRINT_DETAIL_MAX_LENGTH = 400;
const WINDOWS_PRINT_COMMAND_EVIDENCE = /Command failed:|-EncodedCommand/i;

/** Stable classification of a failed Windows PowerShell subprocess. */
export function describeWindowsPrintProcessFailure(error: unknown): string {
  const failure = (error || {}) as {
    name?: unknown;
    code?: unknown;
    killed?: unknown;
    signal?: unknown;
  };
  if (failure.name === 'AbortError' || failure.code === 'ABORT_ERR')
    return 'Windows print command was cancelled';
  if (failure.killed === true || failure.code === 'ETIMEDOUT')
    return 'Windows print command timed out';
  // Spawn-level failures report an errno string instead of an exit status.
  if (typeof failure.code === 'string') return 'Could not start the Windows print helper';
  if (typeof failure.signal === 'string' && failure.signal)
    return `Windows print helper was terminated (${failure.signal})`;
  if (typeof failure.code === 'number')
    return `Windows print helper exited with code ${failure.code}`;
  return 'Windows raw print failed';
}

function redactWindowsPrintPayloadPath(detail: string, payloadPath: string): string {
  if (!detail || !payloadPath) return detail;
  return detail
    .split(payloadPath)
    .join('<payload file>')
    .split(path.dirname(payloadPath))
    .join('<temp directory>');
}

const WINDOWS_PRINT_TRUNCATION_SUFFIX = ' [truncated]';

export function capWindowsPrintDetail(detail: string): string {
  if (detail.length <= WINDOWS_PRINT_DETAIL_MAX_LENGTH) return detail;
  const maxContentLength = Math.max(
    0,
    WINDOWS_PRINT_DETAIL_MAX_LENGTH - WINDOWS_PRINT_TRUNCATION_SUFFIX.length,
  );
  return `${detail.slice(0, maxContentLength).trimEnd()}${WINDOWS_PRINT_TRUNCATION_SUFFIX}`;
}

/** Bounded, leak-free diagnostic for a failed Windows raw-print subprocess. */
function describeWindowsRawPrintFailure(
  error: unknown,
  options: { payloadPath: string; printerName?: string },
): string {
  const cleanStderr = sanitizePowerShellStderr(
    String((error as { stderr?: unknown })?.stderr || '').trim(),
  );
  const detail =
    cleanStderr && !WINDOWS_PRINT_COMMAND_EVIDENCE.test(cleanStderr)
      ? cleanStderr
      : describeWindowsPrintProcessFailure(error);
  const redacted = redactWindowsPrintPayloadPath(detail, options.payloadPath).trim();
  return (
    capWindowsPrintDetail(redacted) ||
    `Windows raw print failed for "${options.printerName || 'printer'}"`
  );
}

export async function printViaUSBWindows(
  data: Buffer,
  printerName?: string,
  signal?: AbortSignal,
): Promise<DispatchResult> {
  if (!printerName) {
    const detail = 'No Windows printer configured; refusing to guess a target';
    console.error(`[Printer] ${detail}`);
    return { ok: false, detail };
  }

  // %TEMP%, not C:\Windows\Temp — the latter is not writable by a standard user.
  const tmpFile = path.join(os.tmpdir(), `flo_print_${process.pid}_${Date.now()}.bin`);

  try {
    fs.writeFileSync(tmpFile, data);

    const { stdout } = await execFileAsync(
      'powershell',
      windowsPowerShellCommandArgs(WINSPOOL_HELPER_SCRIPT),
      {
        encoding: 'utf8',
        timeout: 20000,
        signal,
        windowsHide: true,
        env: { ...process.env, FLO_PRINTER_NAME: printerName, FLO_PRINT_FILE: tmpFile },
      },
    );

    const metadata = parseWindowsPrintOutput(stdout);
    console.log(
      `[Printer] Windows raw print accepted for "${printerName}" (${String(stdout).trim()})`,
    );
    return { ok: true, ...metadata };
  } catch (err: any) {
    const detail = describeWindowsRawPrintFailure(err, { payloadPath: tmpFile, printerName });
    console.error(`[Printer] Windows raw print failed for "${printerName}": ${detail}`);
    return {
      ok: false,
      detail,
      failureClass: classifyPrintFailure(detail),
      platformErrorCode: extractPlatformErrorCode(detail),
      ...parseWindowsPrintOutput(err.stdout),
    };
  } finally {
    try {
      fs.unlinkSync(tmpFile);
    } catch {}
  }
}

export function getPrinterStatus(): { connected: boolean; printer: any } {
  const printer = getPrinterConfig();
  return { connected: !!printer, printer };
}
