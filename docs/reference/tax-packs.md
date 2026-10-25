# Tax pack reference

The pack schema — an internal data format in this fork. How the engine applies a pack is in
[taxation](../architecture/taxation.md); why packs are data rather than plugins is in
[0004: data-only tax packs](../decisions/0004-data-only-tax-packs.md).

The types below are declared in [`main/tax-packs/types.ts`](../../main/tax-packs/types.ts).
`main/tax-packs/generic.json` is the reference instance and the only bundled pack.

## `CountryPack`

A pack is a data object conforming to `schemaVersion: 1`.

| Field | Type | Notes |
| --- | --- | --- |
| `schemaVersion` | `1` | Only `1` is accepted at activation. |
| `id` | `string` | Ids match `^[a-z0-9][a-z0-9-]*$`. |
| `publisher` | `string` | `local` is reserved for packs the owner builds in Settings. |
| `sourceType` | `'official' \| 'community'` | Optional; defaults to `official`. |
| `version` | `string` | Must match `^\d+\.\d+\.\d+$`. |
| `country` | `string` | Two-letter code, or `*` for a multi-country pack. |
| `jurisdiction` | `string` | Free text, `*` for country-wide. |
| `currency` | `string` | ISO 4217, or `XXX` for a placeholder. |
| `effectiveFrom` | `string` | A parseable date. |
| `effectiveTo` | `string` | Optional; must be at or after `effectiveFrom`. |
| `publishedAt` | `string` | |
| `minFloVersion` | `string` | Minimum app version that may activate it. |
| `taxPoint` | `'order_created' \| 'finalized_at'` | Declared, but nothing reads it. |
| `inclusivePricingDefault` | `boolean` | |
| `registrationNumberLabel` | `string` | Merchant-facing label. |
| `registrationNumberFormat` | `TaxIdFormat` | Optional pattern plus description. |
| `categories` | `TaxCategory[]` | |
| `defaultCategories` | `Record<TaxLineKind, string>` | A category id for every line kind. |
| `unclassifiedCategoryId` | `string` | Must name a category in `categories`. |
| `rules` | `TaxRule[]` | |
| `taxRounding` | `TaxRounding` | |
| `payableRounding` | `PayableRounding` | |

`TaxCategory` is `{ id, label, ruleIds, defaultBehavior? }`, where `defaultBehavior` is one of
`country_default`, `inclusive`, `exclusive`, or `exempt`.

`TaxLineKind` is `product`, `packaging`, `delivery`, `service_charge`, or `addon`. Every one of
those needs an entry in `defaultCategories`.

`TaxRounding` is `{ scope, method, decimalPlaces, remainderAllocation }`:

- `scope`: `unit`, `line`, or `document`.
- `method`: `half_up`, `half_even`, `floor`, or `ceiling`.
- `decimalPlaces`: an integer from 0 to 6.
- `remainderAllocation`: `largest_remainder`. It is the only accepted value.

`PayableRounding` is `{ increment, method }`, where `increment` is a positive decimal string at most
1000.

## `TaxRule`

`TaxRule` is `{ id, label, type, categoryIds, rate?, amount?, appliesPer?, baseRuleIds?,
conditions? }`.

- `type` is `percent` or `fixed`. A `percent` rule carries `rate`; a `fixed` rule carries `amount`
  and `appliesPer`.
- `appliesPer` is `unit` or `line`. A `fixed` rule must declare it.
- `baseRuleIds` makes a `percent` rule compound, applying to the base rules' result instead of the
  line gross. A `fixed` rule may not declare it.
- `categoryIds` names the categories the rule applies to.

`TaxRuleConditions` is `{ businessTypes?, customerStateRelation?, customerExempt? }`.
`customerStateRelation` is `interstate` or `intra_or_unspecified`.

Amounts are strings, not numbers. A rate or amount that is not finite, or is negative, fails
activation.

## How packs exist in this fork

Rest&Cafe ships exactly one bundled pack, `main/tax-packs/generic.json` — an empty framework
with no rates. There is no catalog, no download, and no signing or trust chain: the routes that
fetched, installed, or updated packs from a remote catalog do not exist, and no community or
country packs are bundled.

The only other packs are the ones the owner creates in Settings through the manual tax
configuration (below). A locally built pack still passes the same activation validation
(`validationChecklist` in `main/routes/tax-packs.ts`) before it can become active, and the
engine calculates from it exactly like any other pack.

## Manual tax configuration

`buildManualPack()` in `main/routes/tax-packs.ts` turns settings-entered tax configuration into
a `CountryPack` with `publisher: 'local'`, id `manual-<key>`, and jurisdiction `*`. It is
validated and activated locally and is calculated by the same `TaxEngine.calculate()`, so there
is no second calculation path. `POST /manual-config` requires the `tax-packs.manage`
permission.

## Verification

```sh
npm run test:tax-pack-catalog
npm run test:manual-tax-config
npm run test:tax-engine
```
