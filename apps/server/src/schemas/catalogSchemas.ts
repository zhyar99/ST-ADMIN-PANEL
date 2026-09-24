import { z } from 'zod';

import { publicationStatus, streamSourceKind, subtitleLanguage } from '../db/schema';

/**
 * Zod shapes for every untrusted input the catalogue routes accept.
 *
 * These mirror `packages/shared/src/schemas/catalog.ts`, which the Admin SPA
 * uses for form validation. They are not imported from there because
 * @streaming/shared is an ESM package and this server compiles to CommonJS —
 * types cross that boundary, runtime values do not. Phase 4 hit the same wall
 * (see `assetSchemas.ts`, which mirrors `AssetDto` the same way).
 *
 * This copy is the one that matters: it is the security boundary. The shared
 * copy only decides whether a form shows an error before submitting.
 * `packages/shared/src/schemas/catalog.test.ts` pins the rules both must agree
 * on, so a change to one that is not mirrored fails the suite.
 */

/** Enum values come from the Drizzle schema so they cannot drift from the DB. */
const statusValues = publicationStatus.enumValues;
const languageValues = subtitleLanguage.enumValues;
const sourceKindValues = streamSourceKind.enumValues;

/**
 * Copy that must actually say something in all three languages, with no extra
 * keys — an unknown language is a typo, not a bonus translation.
 */
const requiredLocalizedText = z
  .object({
    en: z.string().trim().min(1, 'English text is required'),
    ckb: z.string().trim().min(1, 'Kurdish Sorani text is required'),
    ar: z.string().trim().min(1, 'Arabic text is required'),
  })
  .strict();

/** 1888 is Roundhay Garden Scene, the oldest surviving film. */
const releaseYear = z.coerce.number().int().min(1888).max(2100);

const runtimeMinutes = z.coerce.number().int().positive().max(2000);

/**
 * True for a syntactically valid http/https URL.
 *
 * The try/catch is load-bearing: a Zod refinement still runs when an earlier
 * `.url()` check has only marked the value dirty, so an unparseable string does
 * reach here — and an uncaught `new URL()` throw would surface as a 500 instead
 * of a 400.
 */
function isHttpUrl(value: string): boolean {
  try {
    return /^https?:$/.test(new URL(value).protocol);
  } catch {
    return false;
  }
}

/**
 * An operator-supplied URL.
 *
 * The scheme allowlist lives here as well as in the SSRF guard, so a `file://`
 * or `gopher://` value is rejected before it can ever be persisted — defence in
 * depth, not redundancy.
 */
const remoteUrl = z
  .string()
  .trim()
  .min(1, 'URL is required')
  .max(2048)
  .url('Must be a valid URL')
  .refine(isHttpUrl, 'Only http and https URLs are allowed');

/**
 * Optional copy: either absent, or complete in all three languages.
 *
 * An all-blank object is normalised to null so a form that rendered the field
 * but left it empty is not rejected for omitting a translation of nothing. A
 * partly filled object is still an error.
 */
const optionalLocalizedText = z.preprocess((value) => {
  if (value !== null && typeof value === 'object') {
    const values = Object.values(value as Record<string, unknown>);
    const allBlank = values.every((entry) => typeof entry !== 'string' || entry.trim() === '');
    if (allBlank) return null;
  }

  return value;
}, requiredLocalizedText.nullish());

export const genreBody = z.object({
  name_i18n: requiredLocalizedText,
});

export const listMoviesQuery = z.object({
  status: z.enum(statusValues).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export type ListMoviesQuery = z.infer<typeof listMoviesQuery>;

export const movieCreateBody = z.object({
  title_i18n: requiredLocalizedText,
  overview_i18n: requiredLocalizedText,
  tagline_i18n: optionalLocalizedText,
  release_year: releaseYear.nullish(),
  runtime_minutes: runtimeMinutes.nullish(),
  poster_asset_id: z.string().uuid().nullish(),
  backdrop_asset_id: z.string().uuid().nullish(),
  genre_ids: z.array(z.string().uuid()).max(50).optional(),
});

/**
 * PATCH body. Every field optional, but an empty object is refused — it is
 * always a client bug, never a meaningful no-op.
 */
export const movieUpdateBody = movieCreateBody
  .partial()
  .refine((value) => Object.keys(value).length > 0, { message: 'No fields to update' });

/** Same bounded page/status shape as the movie list. */
export const listSeriesQuery = listMoviesQuery;

export type ListSeriesQuery = z.infer<typeof listSeriesQuery>;

export const seriesCreateBody = z.object({
  title_i18n: requiredLocalizedText,
  overview_i18n: requiredLocalizedText,
  poster_asset_id: z.string().uuid().nullish(),
  backdrop_asset_id: z.string().uuid().nullish(),
});

export const seriesUpdateBody = seriesCreateBody
  .partial()
  .refine((value) => Object.keys(value).length > 0, { message: 'No fields to update' });

/**
 * Season and episode numbering. Zero is allowed because specials are
 * conventionally numbered season 0 or episode 0. The upper bounds are arbitrary
 * but finite, so a typo cannot create a season 99999999 that then sorts above
 * everything real.
 */
const seasonNumber = z.coerce.number().int().min(0).max(1000);

const episodeNumber = z.coerce.number().int().min(0).max(10000);

export const seasonCreateBody = z.object({
  number: seasonNumber,
});

export const episodeCreateBody = z.object({
  number: episodeNumber,
  title_i18n: requiredLocalizedText,
  // Optional where a movie's overview is required — see the shared schema.
  overview_i18n: optionalLocalizedText,
  thumbnail_asset_id: z.string().uuid().nullish(),
});

export const episodeUpdateBody = episodeCreateBody
  .partial()
  .refine((value) => Object.keys(value).length > 0, { message: 'No fields to update' });

/**
 * Live channel inputs.
 *
 * `category` is a bounded plain string — an operator grouping key, not
 * localised copy. `status` is absent for the same reason it is absent from
 * `movieCreateBody`: channels start as DRAFT and publishing is Phase 8.
 */
const channelCategory = z.string().trim().min(1, 'Category is required').max(64);

export const listLiveChannelsQuery = z.object({
  status: z.enum(statusValues).optional(),
  category: channelCategory.optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export type ListLiveChannelsQuery = z.infer<typeof listLiveChannelsQuery>;

export const liveChannelCreateBody = z.object({
  name_i18n: requiredLocalizedText,
  category: channelCategory,
  logo_asset_id: z.string().uuid().nullish(),
});

export const liveChannelUpdateBody = liveChannelCreateBody
  .partial()
  .refine((value) => Object.keys(value).length > 0, { message: 'No fields to update' });

export const liveChannelIdParam = z.object({
  id: z.string().uuid('Not a valid live channel id'),
});

/** `:channelId` on every live channel sub-resource route. */
export const liveChannelScopeParam = z.object({
  channelId: z.string().uuid('Not a valid live channel id'),
});

export const liveChannelSourceScopeParam = liveChannelScopeParam.extend({
  sourceId: z.string().uuid('Not a valid stream source id'),
});

/** `:sourceId` on the owner-agnostic /admin/stream-sources routes. */
export const streamSourceIdParam = z.object({
  sourceId: z.string().uuid('Not a valid stream source id'),
});

/**
 * How the URL is meant to be played — a media file (DIRECT) or a third-party
 * player page that has to be framed (EMBED).
 *
 * Optional, and the column defaults to DIRECT: a body written before embeds
 * existed still means what it meant. No URL-shape check rides along with it,
 * because there is none to make — an embed page and a manifest are both just
 * https URLs, and guessing from the path would only override the operator.
 */
const sourceKind = z.enum(sourceKindValues);

export const streamSourceCreateBody = z.object({
  url: remoteUrl,
  kind: sourceKind.optional(),
  priority: z.coerce.number().int().min(0).max(100).optional(),
});

export const streamSourceUpdateBody = z
  .object({
    url: remoteUrl.optional(),
    kind: sourceKind.optional(),
    priority: z.coerce.number().int().min(0).max(100).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'No fields to update' });

export const streamSourceReorderBody = z.object({
  orderedIds: z.array(z.string().uuid()).min(1, 'At least one source id is required'),
});

/**
 * Mirrors the `subtitle_track_exactly_one_source` CHECK constraint. Validating
 * it here too turns what Postgres would raise as a 500 into a 400 that says
 * what to fix.
 */
export const subtitleCreateBody = z
  .object({
    language: z.enum(languageValues),
    asset_id: z.string().uuid().nullish(),
    external_url: remoteUrl.nullish(),
  })
  .refine((value) => Boolean(value.asset_id) !== Boolean(value.external_url), {
    message: 'Provide exactly one of asset_id or external_url',
  });

export const genreIdParam = z.object({
  id: z.string().uuid('Not a valid genre id'),
});

export const movieIdParam = z.object({
  id: z.string().uuid('Not a valid movie id'),
});

/** `:movieId` on every sub-resource route. */
export const movieScopeParam = z.object({
  movieId: z.string().uuid('Not a valid movie id'),
});

export const sourceScopeParam = movieScopeParam.extend({
  sourceId: z.string().uuid('Not a valid stream source id'),
});

export const subtitleScopeParam = movieScopeParam.extend({
  subtitleId: z.string().uuid('Not a valid subtitle track id'),
});

/**
 * Series path params, one level of nesting at a time.
 *
 * Each is built by extending the level above, so a route that reads
 * `:episodeId` also proves `:seriesId` and `:seasonId` are well formed before
 * the handler runs — malformed ids fail as a 400 rather than reaching the
 * service and coming back as a 404.
 */
export const seriesScopeParam = z.object({
  seriesId: z.string().uuid('Not a valid series id'),
});

export const seasonScopeParam = seriesScopeParam.extend({
  seasonId: z.string().uuid('Not a valid season id'),
});

export const episodeScopeParam = seasonScopeParam.extend({
  episodeId: z.string().uuid('Not a valid episode id'),
});

export const episodeSourceScopeParam = episodeScopeParam.extend({
  sourceId: z.string().uuid('Not a valid stream source id'),
});

export const episodeSubtitleScopeParam = episodeScopeParam.extend({
  subtitleId: z.string().uuid('Not a valid subtitle track id'),
});

export const bulkChannelPublicationBody = z.object({
  ids: z.array(z.string().uuid()).min(1).max(1000)
    .refine((ids) => new Set(ids).size === ids.length, 'Channel ids must be unique'),
  status: z.enum(['PUBLISHED', 'UNPUBLISHED']),
});

export const moveLiveChannelBody = z.object({
  id: z.string().uuid(),
  placement: z.enum(['before', 'after', 'first', 'last']),
  targetId: z.string().uuid().optional(),
}).refine((input) => {
  const relative = input.placement === 'before' || input.placement === 'after';
  return relative ? !!input.targetId && input.targetId !== input.id : input.targetId === undefined;
}, 'A relative move needs a different target channel');
