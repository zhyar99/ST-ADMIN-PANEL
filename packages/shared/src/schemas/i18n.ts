import { z } from 'zod';

/** The three languages every piece of editorial copy must be authored in. */
export const SUPPORTED_LOCALES = ['en', 'ckb', 'ar'] as const;

export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

/**
 * Strict on purpose: an unknown language key is a bug (a typo, or a locale
 * nobody has wired up yet), so it must fail validation instead of being
 * silently persisted into a jsonb column.
 */
export const LocalizedText = z
  .object({
    en: z.string(),
    ckb: z.string(),
    ar: z.string(),
  })
  .strict();

export type LocalizedText = z.infer<typeof LocalizedText>;

/** Same shape, every field optional — for PATCH-style partial updates. */
export const PartialLocalizedText = LocalizedText.partial();

export type PartialLocalizedText = z.infer<typeof PartialLocalizedText>;

/**
 * Reads one language out of a localized value.
 *
 * Resolution order: the requested language, then English, then the first
 * non-empty supported locale, then `fallback`. Never throws — callers are
 * render paths where a missing translation must not break the response.
 */
export function getLocalized(
  value: PartialLocalizedText | null | undefined,
  lang: string,
  fallback = '',
): string {
  if (value === null || typeof value !== 'object') {
    return fallback;
  }

  const requested = (value as Record<string, unknown>)[lang];
  if (typeof requested === 'string' && requested.trim() !== '') {
    return requested;
  }

  if (typeof value.en === 'string' && value.en.trim() !== '') {
    return value.en;
  }

  for (const locale of SUPPORTED_LOCALES) {
    const candidate = value[locale];
    if (typeof candidate === 'string' && candidate.trim() !== '') {
      return candidate;
    }
  }

  return fallback;
}
