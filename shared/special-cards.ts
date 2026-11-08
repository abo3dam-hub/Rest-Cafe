export const SPECIAL_TOP_CARD_ID = '__special_top';
export const SPECIAL_OFFERS_CARD_ID = '__special_offers';

export type SpecialCardKind = 'top' | 'offers';

export interface SpecialCardsConfig {
  offers_title: string;
  top_position: number;
  offers_position: number;
}

export const DEFAULT_SPECIAL_CARDS_CONFIG: SpecialCardsConfig = {
  offers_title: '',
  top_position: 0,
  offers_position: 1,
};

function parsePosition(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 999 ? parsed : fallback;
}

export function parseSpecialCardsConfig(input: {
  offers_title?: unknown;
  top_position?: unknown;
  offers_position?: unknown;
}): SpecialCardsConfig {
  return {
    offers_title:
      typeof input.offers_title === 'string' ? input.offers_title.trim().slice(0, 80) : '',
    top_position: parsePosition(input.top_position, DEFAULT_SPECIAL_CARDS_CONFIG.top_position),
    offers_position: parsePosition(
      input.offers_position,
      DEFAULT_SPECIAL_CARDS_CONFIG.offers_position,
    ),
  };
}

export function readSpecialCardsConfig(
  settings: Record<string, string | undefined>,
): SpecialCardsConfig {
  return parseSpecialCardsConfig({
    offers_title: settings.special_offers_title,
    top_position: settings.special_top_position,
    offers_position: settings.special_offers_position,
  });
}

export type CatalogChip<T> =
  | { kind: 'category'; key: string; category: T }
  | { kind: SpecialCardKind; key: string };

/** Insert the virtual cards into the category sequence at their saved positions. */
export function mergeCatalogChips<T extends { id: string | number }>(
  categories: T[],
  config: SpecialCardsConfig,
  visibleCards: ReadonlySet<SpecialCardKind>,
): CatalogChip<T>[] {
  const chips: CatalogChip<T>[] = categories.map((category) => ({
    kind: 'category',
    key: String(category.id),
    category,
  }));
  const specials = (
    [
      { kind: 'top' as const, key: SPECIAL_TOP_CARD_ID, position: config.top_position },
      { kind: 'offers' as const, key: SPECIAL_OFFERS_CARD_ID, position: config.offers_position },
    ] satisfies { kind: SpecialCardKind; key: string; position: number }[]
  )
    .filter((special) => visibleCards.has(special.kind))
    .sort((a, b) => a.position - b.position);
  for (const special of specials) {
    chips.splice(Math.min(special.position, chips.length), 0, {
      kind: special.kind,
      key: special.key,
    });
  }
  return chips;
}
