import {
  parseSpecialCardsConfig,
  readSpecialCardsConfig,
  type SpecialCardsConfig,
} from '../../shared/special-cards';

export {
  DEFAULT_SPECIAL_CARDS_CONFIG,
  SPECIAL_OFFERS_CARD_ID,
  SPECIAL_TOP_CARD_ID,
  mergeCatalogChips,
  parseSpecialCardsConfig,
  readSpecialCardsConfig,
  type CatalogChip,
  type SpecialCardKind,
  type SpecialCardsConfig,
} from '../../shared/special-cards';

export function specialCardsSettings(config: SpecialCardsConfig): Record<string, string> {
  return {
    special_offers_title: config.offers_title,
    special_top_position: String(config.top_position),
    special_offers_position: String(config.offers_position),
  };
}

export function parseSpecialCardsRequest(
  body: unknown,
  current: SpecialCardsConfig,
): SpecialCardsConfig | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const input = body as Record<string, unknown>;
  const hasPosition = (value: unknown) =>
    value === undefined ||
    (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 999);
  if (!hasPosition(input.top_position) || !hasPosition(input.offers_position)) return null;
  if (input.offers_title !== undefined && typeof input.offers_title !== 'string') return null;
  return parseSpecialCardsConfig({
    offers_title: input.offers_title ?? current.offers_title,
    top_position: input.top_position ?? current.top_position,
    offers_position: input.offers_position ?? current.offers_position,
  });
}

export function readSettingsSpecialCards(
  settings: Record<string, string | undefined>,
): SpecialCardsConfig {
  return readSpecialCardsConfig(settings);
}
