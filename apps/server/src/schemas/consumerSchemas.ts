import { z } from 'zod';

import { SUPPORTED_LOCALES } from '../lib/i18n';
import { paginationQuery } from './pagination';

/**
 * Zod shapes for every untrusted input the consumer routes accept.
 *
 * Same arrangement as `catalogSchemas.ts`: this is the security boundary, and
 * it is deliberately its own file rather than an extension of the admin
 * schemas. The two surfaces accept different things — an admin lists by
 * `status`, a consumer never can, because draft content is not theirs to ask
 * for — and sharing a base schema is how a `status` filter would eventually
 * leak onto the public API by accident.
 */

/** The three languages the API will negotiate. Mirrors SUPPORTED_LOCALES. */
export const consumerLocale = z.enum(SUPPORTED_LOCALES);

export const listMoviesQuery = paginationQuery.extend({
  genre: z.string().uuid('genre must be a genre id').optional(),
});

export type ListMoviesQuery = z.infer<typeof listMoviesQuery>;

/**
 * Series take pagination only.
 *
 * No `genre` filter, because the schema has no series-to-genre relation —
 * `movie_genre` is the only join table. Accepting the parameter and ignoring it
 * would be worse than rejecting it: the client would believe it had filtered.
 */
export const listSeriesQuery = paginationQuery;

export type ListSeriesQuery = z.infer<typeof listSeriesQuery>;

export const listLiveChannelsQuery = paginationQuery.extend({
  // Exact match, and bounded the same way `channelCategory` is on the admin side.
  category: z.string().trim().min(1).max(64).optional(),
});

export type ListLiveChannelsQuery = z.infer<typeof listLiveChannelsQuery>;

export const searchQuery = z.object({
  q: z.string().trim().min(1, 'q is required').max(200),
  lang: consumerLocale.default('en'),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export type SearchQuery = z.infer<typeof searchQuery>;

/**
 * Playback session request.
 *
 * `contentType` is lower-snake here and upper-snake in `stream_source_owner_type`
 * — the public contract and the Postgres enum are separate vocabularies, and
 * `OWNER_TYPE_FOR` in `playbackService` is the one place they are mapped.
 */
export const playbackSessionBody = z.object({
  contentType: z.enum(['movie', 'episode', 'live_channel']),
  contentId: z.string().uuid('contentId must be a uuid'),
  language: consumerLocale.optional().default('en'),
});

export type PlaybackSessionBody = z.infer<typeof playbackSessionBody>;

export const movieIdParam = z.object({
  id: z.string().uuid('Not a valid movie id'),
});

export const seriesIdParam = z.object({
  id: z.string().uuid('Not a valid series id'),
});
