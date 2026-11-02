/**
 * KOT line wrapping (assignment 037, Delivery 5: F-016).
 *
 * KOT item names, addons, and special instructions wrap instead of
 * truncating, matching the receipt path: two products sharing a long
 * prefix stay distinguishable on the ticket, and a long instruction
 * keeps its operative tail. Both render paths are covered — the backend
 * document renderer (server prints) and the frontend encoder (WebUSB)
 * — at 32 and 48 columns / 58 and 80 mm.
 *
 * Run: npm run test:kot-line-wrap
 */

const { assertOrThrow, assertEqualOrThrow, getResults } = require('./helpers/test-setup');
const { renderKotViaDocument } = require('../main/printers/document-kot');
const { escPosToText } = require('../main/printers/thermal');
const { displayCellWidth } = require('../shared/print/width');

function loadFrontendModules(): {
  kotEncoder: typeof import('../frontend/src/lib/printer/kot-encoder');
  loadLocaleMessages: (language: any) => Promise<unknown>;
} {
  const path = require('node:path') as typeof import('node:path');
  const moduleApi = require('node:module') as { _resolveFilename: (...args: any[]) => string };
  const originalResolveFilename = moduleApi._resolveFilename;
  moduleApi._resolveFilename = function (
    request: string,
    parent: any,
    isMain: boolean,
    options?: any,
  ) {
    let resolvedRequest = request;
    if (request === '@countries') {
      resolvedRequest = path.resolve(__dirname, '../main/countries.ts');
    } else if (request.startsWith('@/')) {
      resolvedRequest = path.resolve(__dirname, '../frontend/src', request.slice(2));
    } else if (request.startsWith('@print/')) {
      resolvedRequest = path.resolve(__dirname, '../shared/print', request.slice('@print/'.length));
    }
    return originalResolveFilename.call(this, resolvedRequest, parent, isMain, options);
  };
  try {
    return {
      kotEncoder: require('../frontend/src/lib/printer/kot-encoder'),
      loadLocaleMessages: require('../frontend/src/lib/i18n/loader').loadLocaleMessages,
    };
  } finally {
    moduleApi._resolveFilename = originalResolveFilename;
  }
}

// Two products sharing a long prefix: truncation made them identical on the
// ticket; wrapping keeps the differing tail of each.
const LONG_PREFIX =
  'Extra Long Caramelized Vanilla Bean Creme Frappuccino With Extra Whipped Cream And';
const LONG_NAME_A = `${LONG_PREFIX} Caramel Drizzle`;
const LONG_NAME_B = `${LONG_PREFIX} Chocolate Sauce`;
const LONG_ADDON = 'Toasted Marshmallow Fluff With Crushed Pistachio Praline Topping';
const LONG_NOTE =
  'No ice at all, extra hot, and please leave the whipped cream off the second cup entirely';

const items = [
  {
    product_name: LONG_NAME_A,
    quantity: 2,
    status: 'pending',
    addons: [{ name: LONG_ADDON, quantity: 1, price: 0 }],
    special_instructions: LONG_NOTE,
  },
  {
    product_name: LONG_NAME_B,
    quantity: 1,
    status: 'pending',
    addons: [],
    special_instructions: '',
  },
  {
    product_name: 'Espresso',
    quantity: 1,
    status: 'pending',
    addons: [],
    special_instructions: '',
  },
];
const baseOrder = { order_number: 'K-16', created_at: '2026-01-01 12:00:00', type: 'dine_in' };

function stripTokens(line: string): string {
  return line.replace(/\{\/?[A-Z_]+\}/g, '');
}

function main(): void {
  // ── Backend document renderer ──────────────────────────────────────────
  for (const columns of [32, 48]) {
    const rendered = renderKotViaDocument(baseOrder, items, 'Kitchen', {
      columns,
      language: 'en',
      useUnicode: false,
      arabicShaping: false,
      cutMode: 'full' as const,
    });
    const joined = rendered.lines.map(stripTokens).join(' ').replace(/\s+/g, ' ');
    assertOrThrow(
      joined.includes('Caramel Drizzle') && joined.includes('Chocolate Sauce'),
      `F-016 backend @${columns}: products sharing a long prefix stay distinguishable`,
    );
    assertOrThrow(
      joined.includes(LONG_ADDON),
      `F-016 backend @${columns}: full addon name is kept, not truncated`,
    );
    assertOrThrow(
      joined.includes('entirely'),
      `F-016 backend @${columns}: long instruction keeps its operative tail`,
    );
    assertOrThrow(
      !joined.includes('…') && !rendered.lines.some((line: string) => line.includes('..')),
      `F-016 backend @${columns}: no truncation marker survives on KOT item lines`,
    );
    const over = rendered.lines
      .map(stripTokens)
      .filter((line: string) => displayCellWidth(line) > columns)
      .map((line: string) => `${displayCellWidth(line)} cells: ${line}`);
    assertEqualOrThrow(
      over.length,
      0,
      `F-016 backend @${columns}: wrapped KOT lines stay within the column budget (${over.join('; ')})`,
    );
    const short = renderKotViaDocument(
      baseOrder,
      [
        {
          product_name: 'Espresso',
          quantity: 1,
          status: 'pending',
          addons: [],
          special_instructions: '',
        },
      ],
      'Kitchen',
      {
        columns,
        language: 'en',
        useUnicode: false,
        arabicShaping: false,
        cutMode: 'full' as const,
      },
    );
    assertEqualOrThrow(
      short.lines.filter((line: string) => stripTokens(line).includes('Espresso')).length,
      1,
      `F-016 backend @${columns}: a short name still renders on one line`,
    );
    // The raster groups still map one source line per item part, so a
    // wrapped row keeps its raster identity after the reflow.
    assertEqualOrThrow(
      rendered.rasterGroups.filter((group: { groupId: string }) =>
        group.groupId.startsWith('kot-items-row-'),
      ).length,
      3,
      `F-016 backend @${columns}: one raster group per KOT row survives wrapping`,
    );
  }
}

async function runAsyncTests(): Promise<void> {
  const frontend = loadFrontendModules();
  await frontend.loadLocaleMessages('en');

  // ── Frontend WebUSB encoder ────────────────────────────────────────────
  for (const paperWidth of [58, 80] as const) {
    const bytes = frontend.kotEncoder.buildKotBytes({ ...baseOrder, items } as any, {
      paperWidth,
      columns: paperWidth === 58 ? 32 : 48,
      language: 'en',
    });
    const text = escPosToText(bytes).replace(/\s+/g, ' ');
    assertOrThrow(
      text.includes('Caramel Drizzle') && text.includes('Chocolate Sauce'),
      `F-016 frontend @${paperWidth}mm: products sharing a long prefix stay distinguishable`,
    );
    assertOrThrow(
      text.includes(LONG_ADDON),
      `F-016 frontend @${paperWidth}mm: full addon name is kept, not truncated`,
    );
    assertOrThrow(
      text.includes('entirely'),
      `F-016 frontend @${paperWidth}mm: long instruction keeps its operative tail`,
    );
    assertOrThrow(
      !text.includes('…'),
      `F-016 frontend @${paperWidth}mm: no truncation marker survives on KOT item lines`,
    );
  }
}

main();
runAsyncTests()
  .then(() => {
    const results = getResults();
    console.log(`\nResults: ${results.passed}/${results.total} passed, ${results.failed} failed`);
    if (results.failed > 0) process.exit(1);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
