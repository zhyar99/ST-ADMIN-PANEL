import { z } from 'zod';

import { PUBLICATION_STATUSES, STREAM_SOURCE_KINDS, SUBTITLE_LANGUAGES } from '../enums.js';
import { LocalizedText } from './i18n.js';

/**
 * Input shapes for the catalogue admin routes, and the DTO types those routes
 * return. Server and Admin SPA both import from here, so a field can only be
 * added to the wire format in one place.
 */

/**
 * Editorial copy that must actually say something in all three languages.
 *
 * Layered on top of Phase 2's `LocalizedText` rather than redeclared: that one
 * governs the shape (exactly en/ckb/ar, no extra keys) and stays permissive
 * because read paths tolerate a blank translation. Write paths do not.
 */
export const RequiredLocalizedText = LocalizedText.extend({
  en: z.string().trim().min(1, 'English text is required'),
  ckb: z.string().trim().min(1, 'Kurdish Sorani text is required'),
  ar: z.string().trim().min(1, 'Arabic text is required'),
});

export type RequiredLocalizedText = z.infer<typeof RequiredLocalizedText>;

/**
 * Optional copy: either absent, or complete in all three languages.
 *
 * The preprocess step matters for forms. A tagline input that has been rendered
 * but not typed into submits `{en:'',ckb:'',ar:''}` rather than nothing, which
 * would otherwise fail the all-three-languages rule and block the save on a
 * field the user was told was optional. An entirely blank object means "no
 * tagline"; a partly filled one is still an error.
 */
export const OptionalLocalizedText = z.preprocess((value) => {
  if (value !== null && typeof value === 'object') {
    const values = Object.values(value as Record<string, unknown>);
    const allBlank = values.every((entry) => typeof entry !== 'string' || entry.trim() === '');
    if (allBlank) return null;
  }

  return value;
}, RequiredLocalizedText.nullish());

/** 1888 is the year of Roundhay Garden Scene, the oldest surviving film. */
export const ReleaseYear = z.coerce.number().int().min(1888).max(2100);

export const RuntimeMinutes = z.coerce.number().int().positive().max(2000);

/**
 * True for a syntactically valid http/https URL.
 *
 * The try/catch is load-bearing: a Zod refinement still runs when an earlier
 * `.url()` check has only marked the value dirty, so an unparseable string does
 * reach here — and an uncaught `new URL()` throw escapes as a TypeError rather
 * than a validation failure.
 */
function isHttpUrl(value: string): boolean {
  try {
    return /^https?:$/.test(new URL(value).protocol);
  } catch {
    return false;
  }
}

/**
 * A stream or subtitle URL supplied by an operator.
 *
 * Scheme is restricted here rather than in the SSRF guard alone, so a
 * `file://` or `gopher://` value can never reach persistence in the first place.
 */
export const RemoteUrl = z
  .string()
  .trim()
  .min(1, 'URL is required')
  .max(2048)
  .url('Must be a valid URL')
  .refine(isHttpUrl, 'Only http and https URLs are allowed');

export const GenreCreateInput = z.object({
  name_i18n: RequiredLocalizedText,
});

export type GenreCreateInput = z.infer<typeof GenreCreateInput>;

export const GenreUpdateInput = GenreCreateInput;

export type GenreUpdateInput = z.infer<typeof GenreUpdateInput>;

export const MovieCreateInput = z.object({
  title_i18n: RequiredLocalizedText,
  overview_i18n: RequiredLocalizedText,
  tagline_i18n: OptionalLocalizedText,
  release_year: ReleaseYear.nullish(),
  runtime_minutes: RuntimeMinutes.nullish(),
  poster_asset_id: z.string().uuid().nullish(),
  backdrop_asset_id: z.string().uuid().nullish(),
  genre_ids: z.array(z.string().uuid()).max(50).optional(),
});

export type MovieCreateInput = z.infer<typeof MovieCreateInput>;

/**
 * PATCH body. Every field optional, but an empty object is rejected — it is
 * always a client bug, never a meaningful no-op update.
 */
export const MovieUpdateInput = MovieCreateInput.partial().refine(
  (value) => Object.keys(value).length > 0,
  { message: 'No fields to update' },
);

export type MovieUpdateInput = z.infer<typeof MovieUpdateInput>;

export const SeriesCreateInput = z.object({
  title_i18n: RequiredLocalizedText,
  overview_i18n: RequiredLocalizedText,
  poster_asset_id: z.string().uuid().nullish(),
  backdrop_asset_id: z.string().uuid().nullish(),
});

export type SeriesCreateInput = z.infer<typeof SeriesCreateInput>;

export const SeriesUpdateInput = SeriesCreateInput.partial().refine(
  (value) => Object.keys(value).length > 0,
  { message: 'No fields to update' },
);

export type SeriesUpdateInput = z.infer<typeof SeriesUpdateInput>;

/**
 * Season and episode numbering.
 *
 * Zero is allowed because specials are conventionally numbered season 0 or
 * episode 0. The upper bound is arbitrary but finite: it exists so a typo
 * cannot create a season 99999999 that then sorts above everything real.
 */
export const SeasonNumber = z.coerce.number().int().min(0).max(1000);

export const EpisodeNumber = z.coerce.number().int().min(0).max(10000);

export const SeasonCreateInput = z.object({
  number: SeasonNumber,
});

export type SeasonCreateInput = z.infer<typeof SeasonCreateInput>;

export const EpisodeCreateInput = z.object({
  number: EpisodeNumber,
  title_i18n: RequiredLocalizedText,
  // An episode overview is optional where a movie's is required: most shows
  // carry per-episode synopses, but a talk show reasonably does not.
  overview_i18n: OptionalLocalizedText,
  thumbnail_asset_id: z.string().uuid().nullish(),
});

export type EpisodeCreateInput = z.infer<typeof EpisodeCreateInput>;

export const EpisodeUpdateInput = EpisodeCreateInput.partial().refine(
  (value) => Object.keys(value).length > 0,
  { message: 'No fields to update' },
);

export type EpisodeUpdateInput = z.infer<typeof EpisodeUpdateInput>;

/**
 * A broadcast category label ("News", "Sport", ...).
 *
 * Deliberately not localised and not a foreign key: it is an operator-facing
 * grouping key, and the three-language treatment that titles get would make it
 * ambiguous which translation the grouping is keyed on.
 */
export const ChannelCategory = z.string().trim().min(1, 'Category is required').max(64);

export const LiveChannelCreateInput = z.object({
  name_i18n: RequiredLocalizedText,
  category: ChannelCategory,
  logo_asset_id: z.string().uuid().nullish(),
  // `status` is absent by design: a channel starts as a DRAFT and publishing is
  // Phase 8, exactly as with MovieCreateInput.
});

export type LiveChannelCreateInput = z.infer<typeof LiveChannelCreateInput>;

export const LiveChannelUpdateInput = LiveChannelCreateInput.partial().refine(
  (value) => Object.keys(value).length > 0,
  { message: 'No fields to update' },
);

export type LiveChannelUpdateInput = z.infer<typeof LiveChannelUpdateInput>;

/**
 * How the URL is to be played.
 *
 * Optional on create and defaulted to DIRECT, so every caller written before
 * embeds existed keeps working and keeps meaning what it meant.
 */
export const StreamSourceKindSchema = z.enum(STREAM_SOURCE_KINDS);

export const StreamSourceCreateInput = z.object({
  url: RemoteUrl,
  kind: StreamSourceKindSchema.optional(),
  priority: z.coerce.number().int().min(0).max(100).optional(),
});

export type StreamSourceCreateInput = z.infer<typeof StreamSourceCreateInput>;

export const StreamSourceUpdateInput = z
  .object({
    url: RemoteUrl.optional(),
    kind: StreamSourceKindSchema.optional(),
    priority: z.coerce.number().int().min(0).max(100).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'No fields to update' });

export type StreamSourceUpdateInput = z.infer<typeof StreamSourceUpdateInput>;

export const StreamSourceReorderInput = z.object({
  orderedIds: z.array(z.string().uuid()).min(1, 'At least one source id is required'),
});

export type StreamSourceReorderInput = z.infer<typeof StreamSourceReorderInput>;

/**
 * A track is library-hosted or remote, never both. Mirrors the
 * `subtitle_track_exactly_one_source` CHECK constraint; validating here as well
 * turns what would be a 500 from Postgres into a 400 with a usable message.
 */
export const SubtitleTrackCreateInput = z
  .object({
    language: z.enum(SUBTITLE_LANGUAGES),
    asset_id: z.string().uuid().nullish(),
    external_url: RemoteUrl.nullish(),
  })
  .refine(
    (value) => Boolean(value.asset_id) !== Boolean(value.external_url),
    { message: 'Provide exactly one of asset_id or external_url' },
  );

export type SubtitleTrackCreateInput = z.infer<typeof SubtitleTrackCreateInput>;

export const PublicationStatusSchema = z.enum(PUBLICATION_STATUSES);
