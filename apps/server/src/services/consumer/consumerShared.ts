import { and, asc, eq, inArray } from 'drizzle-orm';

import type {
  GenreRef,
  SubtitleTrackDTO,
  SupportedLocale,
} from '@streaming/shared' with { 'resolution-mode': 'import' };

import { db } from '../../db/client';
import { genre, mediaAsset, movieGenre, subtitleTrack } from '../../db/schema';
import { assetUrl } from '../../lib/assetUrl';
import { localizeField } from '../../lib/i18n';

/**
 * Joins the consumer read paths share.
 *
 * Every one of these is written to fetch a whole page at once and be regrouped
 * in memory. A movie list rendering 20 cards must not become 20 genre queries,
 * and a series detail with 40 episodes must not become 40 subtitle queries.
 */

/** Localised genres for a page of movies, keyed by movie id. */
export async function genresForMovies(
  movieIds: string[],
  lang: SupportedLocale,
): Promise<Map<string, GenreRef[]>> {
  const byMovie = new Map<string, GenreRef[]>();
  if (movieIds.length === 0) return byMovie;

  const rows = await db
    .select({ movieId: movieGenre.movieId, id: genre.id, nameI18n: genre.nameI18n })
    .from(movieGenre)
    .innerJoin(genre, eq(genre.id, movieGenre.genreId))
    .where(inArray(movieGenre.movieId, movieIds));

  for (const row of rows) {
    const list = byMovie.get(row.movieId) ?? [];
    list.push({ id: row.id, name: localizeField(row.nameI18n, lang) });
    byMovie.set(row.movieId, list);
  }

  // Sorted in the requested language, so the chip order matches what the user
  // is actually reading rather than the English alphabet.
  for (const list of byMovie.values()) {
    list.sort((a, b) => a.name.localeCompare(b.name, lang));
  }

  return byMovie;
}

/**
 * Subtitle tracks for a set of owners, keyed by owner id.
 *
 * `url` resolves the library asset first and falls back to the operator's
 * remote URL. The `subtitle_track_exactly_one_source` CHECK guarantees exactly
 * one of the two is set, so the null branch is unreachable in practice — it is
 * typed anyway because a CHECK is not a type.
 */
export async function subtitleTracksFor(
  ownerType: 'MOVIE' | 'EPISODE',
  ownerIds: string[],
): Promise<Map<string, SubtitleTrackDTO[]>> {
  const byOwner = new Map<string, SubtitleTrackDTO[]>();
  if (ownerIds.length === 0) return byOwner;

  const rows = await db
    .select({
      ownerId: subtitleTrack.ownerId,
      language: subtitleTrack.language,
      externalUrl: subtitleTrack.externalUrl,
      filePath: mediaAsset.filePath,
    })
    .from(subtitleTrack)
    .leftJoin(mediaAsset, eq(mediaAsset.id, subtitleTrack.assetId))
    .where(and(eq(subtitleTrack.ownerType, ownerType), inArray(subtitleTrack.ownerId, ownerIds)))
    .orderBy(asc(subtitleTrack.language));

  for (const row of rows) {
    const list = byOwner.get(row.ownerId) ?? [];
    list.push({ language: row.language, url: assetUrl(row.filePath) ?? row.externalUrl });
    byOwner.set(row.ownerId, list);
  }

  return byOwner;
}

/** Single-owner convenience wrapper around {@link subtitleTracksFor}. */
export async function subtitleTracksForOne(
  ownerType: 'MOVIE' | 'EPISODE',
  ownerId: string,
): Promise<SubtitleTrackDTO[]> {
  return (await subtitleTracksFor(ownerType, [ownerId])).get(ownerId) ?? [];
}

/**
 * Escapes a user-supplied search term for use inside an ILIKE pattern.
 *
 * Without this a query of "%" matches everything and "_" matches any single
 * character — the caller's text would be a query language rather than a term.
 * Backslash is escaped first so it cannot double up with the escapes added
 * after it. Postgres' default LIKE escape character is backslash, so no
 * ESCAPE clause is needed.
 */
export function likePattern(term: string): string {
  return `%${term.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}
