import type {
  PartialLocalizedText,
  SupportedLocale,
} from '@streaming/shared' with { 'resolution-mode': 'import' };

/**
 * Language negotiation for the consumer API.
 *
 * Mirrors `SUPPORTED_LOCALES` and `getLocalized` from @streaming/shared rather
 * than importing them, for the reason `catalogSchemas.ts` sets out at length:
 * shared is ESM and this server compiles to CommonJS, so types cross that
 * boundary and runtime values do not. `i18n.test.ts` pins the behaviour both
 * copies have to agree on.
 *
 * Note on the API shape: this exports `pickLocale(header)` — which resolves a
 * language *tag* — and `localizeField(json, lang)`, which reads a value out of
 * a jsonb column. Splitting them means a request negotiates its language once
 * per response instead of once per field.
 */

/** Mirrors `SUPPORTED_LOCALES`. Nothing outside this list is ever negotiated. */
export const SUPPORTED_LOCALES = ['en', 'ckb', 'ar'] as const;

/** Where negotiation lands when the header asks for nothing we speak. */
export const DEFAULT_LOCALE: SupportedLocale = 'en';

function isSupported(tag: string): tag is SupportedLocale {
  return (SUPPORTED_LOCALES as readonly string[]).includes(tag);
}

interface RankedTag {
  tag: string;
  quality: number;
  /** Header position, used to break q-value ties in the client's stated order. */
  index: number;
}

/** Reads the `;q=` parameter off one Accept-Language entry. Absent means 1. */
function qualityOf(params: string[]): number {
  for (const param of params) {
    const match = /^\s*q\s*=\s*([0-9.]+)\s*$/i.exec(param);
    if (match) {
      const value = Number.parseFloat(match[1]!);
      return Number.isNaN(value) ? 0 : value;
    }
  }

  return 1;
}

/**
 * Negotiates a language from an `Accept-Language` header.
 *
 * Matching is exact: `ckb` matches, `ckb-IQ` does not. Region subtags carry no
 * meaning here — there is one Sorani translation, not one per country — so
 * accepting them would imply a granularity the catalogue does not have.
 *
 * Never throws. A malformed header degrades to {@link DEFAULT_LOCALE}, because
 * this runs on render paths where a bad header must not become a 500.
 */
export function pickLocale(acceptLanguage: string | null | undefined): SupportedLocale {
  if (!acceptLanguage) return DEFAULT_LOCALE;

  const ranked: RankedTag[] = acceptLanguage
    .split(',')
    .map((entry, index) => {
      const [tag = '', ...params] = entry.trim().split(';');
      return { tag: tag.trim().toLowerCase(), quality: qualityOf(params), index };
    })
    // `q=0` is an explicit refusal, not a weak preference.
    .filter((entry) => entry.tag !== '' && entry.quality > 0)
    .sort((a, b) => b.quality - a.quality || a.index - b.index);

  return ranked.map((entry) => entry.tag).find(isSupported) ?? DEFAULT_LOCALE;
}

/**
 * Reads one language out of a localized jsonb value.
 *
 * Resolution order: the requested language, then English, then the first
 * non-empty supported locale, then `fallback`. Mirrors `getLocalized` in
 * @streaming/shared, and like it never throws — a half-translated row renders
 * in whatever language it does have rather than failing the whole response.
 */
export function localizeField(
  value: PartialLocalizedText | null | undefined,
  lang: SupportedLocale,
  fallback = '',
): string {
  if (value === null || typeof value !== 'object') return fallback;

  const requested = (value as Record<string, unknown>)[lang];
  if (typeof requested === 'string' && requested.trim() !== '') return requested;

  if (typeof value.en === 'string' && value.en.trim() !== '') return value.en;

  for (const locale of SUPPORTED_LOCALES) {
    const candidate = value[locale];
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate;
  }

  return fallback;
}

/**
 * Nullable variant, for copy that is genuinely optional.
 *
 * A movie with no tagline and an episode with no overview must serialise as
 * `null`, not as `""` — the client renders nothing for the former and an empty
 * paragraph for the latter.
 */
export function localizeOptionalField(
  value: PartialLocalizedText | null | undefined,
  lang: SupportedLocale,
): string | null {
  const text = localizeField(value, lang);
  return text === '' ? null : text;
}
