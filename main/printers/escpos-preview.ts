/** ESC/POS preview: decode emitted bytes back to text, with code-page handling. */

import type { ThermalCodePage } from '../../shared/print/thermal-capabilities';

/** Convert the command subset emitted by buildEscPos() into a paperless text preview. */
export function escPosToText(data: Buffer | Uint8Array): string {
  const bytes = Buffer.from(data);
  const text: string[] = [];
  const lineBytes: number[] = [];
  let activeCodePage: ThermalCodePage | 'utf8' = 'utf8';

  const flushLine = (): void => {
    if (lineBytes.length === 0) return;
    text.push(decodeThermalPreviewBytes(lineBytes, activeCodePage));
    lineBytes.length = 0;
  };

  for (let i = 0; i < bytes.length;) {
    const byte = bytes[i];
    if (byte === 0x1b) {
      const command = bytes[i + 1];
      if (command === 0x40) {
        flushLine();
        activeCodePage = 'utf8';
        i += 2;
      } else if (command === 0x74) {
        flushLine();
        activeCodePage = THERMAL_CODE_PAGE_BY_ID[bytes[i + 2]] ?? 'utf8';
        i += 3;
      } else if (command === 0x21 || command === 0x45 || command === 0x61) {
        i += 3;
      } else if (command === 0x64) {
        flushLine();
        const feedLines = bytes[i + 2] || 0;
        for (let line = 0; line < feedLines; line++) text.push('\n');
        i += 3;
      } else {
        i += Math.min(2, bytes.length - i);
      }
      continue;
    }
    if (byte === 0x1d && bytes[i + 1] === 0x56) {
      flushLine();
      const mode = bytes[i + 2];
      i += mode === 0x41 || mode === 0x42 ? 4 : 3;
      continue;
    }
    if (byte === 0x1d && bytes[i + 1] === 0x76 && bytes[i + 2] === 0x30) {
      flushLine();
      const widthBytes = bytes[i + 4] | (bytes[i + 5] << 8);
      const heightDots = bytes[i + 6] | (bytes[i + 7] << 8);
      i += 8 + widthBytes * heightDots;
      continue;
    }
    if (byte === 0x0a) {
      flushLine();
      text.push('\n');
      i += 1;
      continue;
    }
    if (byte === 0x0d) {
      i += 1;
      continue;
    }
    lineBytes.push(byte);
    i += 1;
  }

  flushLine();
  return text.join('').replace(/\n+$/, '');
}

const THERMAL_CODE_PAGE_HIGH_HALVES: Record<Exclude<ThermalCodePage, 'ascii'>, string> = {
  cp437:
    'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ',
  cp850:
    'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜø£Ø×ƒáíóúñÑªº¿®¬½¼¡«»░▒▓│┤ÁÂÀ©╣║╗╝¢¥┐└┴┬├─┼ãÃ╚╔╩╦╠═╬¤ðÐÊËÈıÍÎÏ┘┌█▄¦Ì▀ÓßÔÒõÕµþÞÚÛÙýÝ¯´­±‗¾¶§÷¸°¨·¹³²■ ',
  cp858:
    'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜø£Ø×ƒáíóúñÑªº¿®¬½¼¡«»░▒▓│┤ÁÂÀ©╣║╗╝¢¥┐└┴┬├─┼ãÃ╚╔╩╦╠═╬¤ðÐÊËÈ€ÍÎÏ┘┌█▄¦Ì▀ÓßÔÒõÕµþÞÚÛÙýÝ¯´­±‗¾¶§÷¸°¨·¹³²■ ',
  windows1252:
    '€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜š›œžŸÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝÞßàáâãäåæçèéêëìíîïðñòóôõöøùúûüýþÿ',
};
const THERMAL_CODE_PAGE_BY_ID: Record<number, ThermalCodePage> = {
  0: 'cp437',
  2: 'cp850',
  16: 'windows1252',
  19: 'cp858',
};

function decodeThermalPreviewBytes(bytes: number[], codePage: ThermalCodePage | 'utf8'): string {
  if (codePage === 'utf8') return Buffer.from(bytes).toString('utf8');
  if (codePage === 'ascii') return bytes.map((byte) => String.fromCharCode(byte)).join('');
  const highHalf = THERMAL_CODE_PAGE_HIGH_HALVES[codePage];
  return bytes
    .map((byte) => (byte < 0x80 ? String.fromCharCode(byte) : (highHalf[byte - 0x80] ?? '\uFFFD')))
    .join('');
}
