/** Network / USB print transport: raw sockets, CUPS, and the Windows USB path. */

import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { execFileAsync, printViaUSBWindows } from './windows-print';
import { ippGetPrinterAttributes, ippPrintRaw } from './ipp-client';
import type { DispatchResult } from './thermal';

export const NETWORK_PRINT_CHUNK_SIZE = 4096;
export const NETWORK_PRINT_CHUNK_DELAY_MS = 10;

export async function printViaNetwork(
  ip: string,
  port: number,
  data: Buffer,
  signal?: AbortSignal,
): Promise<DispatchResult> {
  return new Promise((resolve) => {
    const client = new net.Socket();
    let settled = false;
    let connected = false;
    let timer: NodeJS.Timeout | null = null;

    const onAbort = (): void => {
      if (timer) clearTimeout(timer);
      client.destroy();
      finish({ ok: false, detail: 'Print cancelled during shutdown' });
    };
    const finish = (result: DispatchResult): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve(result);
    };

    client.connect(port, ip, () => {
      connected = true;
      // For small payloads (typical text receipts <4KB), write directly in a single pass.
      if (data.length <= NETWORK_PRINT_CHUNK_SIZE) {
        client.write(data, () => {
          client.end();
          finish({ ok: true });
        });
        return;
      }

      // For large payloads (e.g. raster graphics, multi-language bitmaps), chunk to avoid overrunning
      // small microcontroller receive buffers on budget thermal printers.
      let offset = 0;
      const sendNextChunk = (): void => {
        if (settled) return;
        if (offset >= data.length) {
          client.end();
          finish({ ok: true });
          return;
        }

        const chunk = data.subarray(offset, offset + NETWORK_PRINT_CHUNK_SIZE);
        offset += chunk.length;

        const scheduleNext = (): void => {
          if (settled) return;
          if (offset < data.length) {
            timer = setTimeout(sendNextChunk, NETWORK_PRINT_CHUNK_DELAY_MS);
          } else {
            client.end();
            finish({ ok: true });
          }
        };

        const canContinue = client.write(chunk, () => {
          if (canContinue) {
            scheduleNext();
          }
        });

        if (!canContinue) {
          client.once('drain', scheduleNext);
        }
      };

      sendNextChunk();
    });

    client.on('error', (err) => {
      console.error(`[Printer] Network error: ${err.message}`);
      client.destroy();
      finish({ ok: false, detail: `Network error: ${err.message}` });
    });

    client.setTimeout(5000, () => {
      client.destroy();
      finish({
        ok: false,
        detail: connected
          ? `Timed out writing to ${ip}:${port}`
          : `Timed out connecting to ${ip}:${port}`,
      });
    });
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

export async function printViaUSB(
  data: Buffer,
  printerName?: string,
  signal?: AbortSignal,
): Promise<DispatchResult> {
  console.log('[Printer] printViaUSB called, platform:', process.platform, 'printer:', printerName);

  if (process.platform === 'darwin' || process.platform === 'linux') {
    return await printViaCups(data, printerName, signal);
  }

  if (process.platform === 'win32') {
    return await printViaUSBWindows(data, printerName, signal);
  }

  console.warn('[Printer] Unsupported platform:', process.platform);
  return { ok: false, detail: `Unsupported platform: ${process.platform}` };
}

// MAS-build counterpart to printViaCups: submits raw bytes to CUPS via local IPP.
export async function printViaLocalIpp(
  data: Buffer,
  printerName?: string,
  signal?: AbortSignal,
): Promise<DispatchResult> {
  if (!printerName) {
    return { ok: false, detail: 'No printer configured' };
  }

  try {
    const attrs = await ippGetPrinterAttributes(printerName, signal);
    if (attrs.state === 5) {
      return { ok: false, detail: 'print queue is disabled' };
    }
    if (attrs.isAcceptingJobs === false) {
      return { ok: false, detail: 'print queue is not accepting jobs' };
    }
  } catch (err) {
    if (signal?.aborted) return { ok: false, detail: 'Print cancelled during shutdown' };
    // Mirrors describeCupsQueueProblem: unreachable queue check does not block print.
    console.log(`[Printer] IPP pre-flight check failed for "${printerName}":`, err);
  }

  try {
    const result = await ippPrintRaw(printerName, data, signal);
    if (!result.ok) {
      console.error(`[Printer] IPP print failed for "${printerName}": ${result.detail}`);
      return { ok: false, detail: result.detail || `IPP print failed for "${printerName}"` };
    }
    console.log(
      `[Printer] IPP print queued for "${printerName}" (job ${result.jobId ?? 'unknown'})`,
    );
    return { ok: true, jobId: result.jobId };
  } catch (err: any) {
    const detail = String(err?.message || err || '').trim();
    console.error(`[Printer] IPP print failed for "${printerName}": ${detail}`);
    return { ok: false, detail: detail || `IPP print failed for "${printerName}"` };
  }
}

// Pre-flight check whether CUPS queue is disabled; returns problem description or null.
async function describeCupsQueueProblem(
  printerName?: string,
  signal?: AbortSignal,
): Promise<string | null> {
  if (!printerName) return null;

  // LC_ALL=C — the state words below are matched in English, and lpstat is localised.
  const opts = {
    encoding: 'utf8' as const,
    timeout: 5000,
    signal,
    env: { ...process.env, LC_ALL: 'C' },
  };

  try {
    const { stdout } = await execFileAsync('lpstat', ['-p', printerName], opts);
    if (/\bdisabled\b/i.test(stdout)) {
      const since = stdout.match(/disabled since [^\n]*/i);
      return since ? since[0].trim().replace(/\s+-\s*$/, '') : 'print queue is disabled';
    }
  } catch {
    return null;
  }

  try {
    const { stdout } = await execFileAsync('lpstat', ['-a', printerName], opts);
    if (/not accepting/i.test(stdout)) return 'print queue is not accepting jobs';
  } catch {
    return null;
  }

  return null;
}

export async function printViaCups(
  data: Buffer,
  printerName?: string,
  signal?: AbortSignal,
): Promise<DispatchResult> {
  const label = printerName || 'default';

  const problem = await describeCupsQueueProblem(printerName, signal);
  if (signal?.aborted) return { ok: false, detail: 'Print cancelled during shutdown' };
  if (problem) {
    console.error(`[Printer] CUPS print aborted for "${label}": ${problem}`);
    return { ok: false, detail: problem };
  }

  const tmpFile = path.join(os.tmpdir(), `flo_print_${process.pid}_${Date.now()}.bin`);

  try {
    fs.writeFileSync(tmpFile, data);

    const args = printerName ? ['-d', printerName, '-o', 'raw', tmpFile] : ['-o', 'raw', tmpFile];
    const { stdout } = await execFileAsync('lp', args, {
      encoding: 'utf8',
      timeout: 20000,
      signal,
    });

    console.log(`[Printer] CUPS print queued for "${label}" (${stdout.trim()})`);
    return { ok: true };
  } catch (err: any) {
    const detail = String(err.stderr || err.message || '').trim();
    console.error(`[Printer] CUPS print failed for "${label}": ${detail}`);
    return { ok: false, detail: detail || `CUPS print failed for "${label}"` };
  } finally {
    try {
      fs.unlinkSync(tmpFile);
    } catch {}
  }
}
