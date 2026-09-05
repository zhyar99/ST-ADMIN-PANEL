import { count, eq, sql } from 'drizzle-orm';

import type {
  GenreDto,
  GenreListItemDto,
  LocalizedText,
} from '@streaming/shared' with { 'resolution-mode': 'import' };

import { db } from '../../db/client';
import { genre, movieGenre, type Genre } from '../../db/schema';
import { HttpError } from '../../middleware/errorHandler';

export function toGenreDto(row: Genre): GenreDto {
  return { id: row.id, nameI18n: row.nameI18n };
}

/** Genres with the number of movies each is attached to, English name first. */
export async function listGenres(): Promise<GenreListItemDto[]> {
  const rows = await db
    .select({
      id: genre.id,
      nameI18n: genre.nameI18n,
      movieCount: sql<number>`count(${movieGenre.movieId})::int`,
    })
    .from(genre)
    .leftJoin(movieGenre, eq(movieGenre.genreId, genre.id))
    .groupBy(genre.id)
    .orderBy(sql`${genre.nameI18n} ->> 'en'`);

  return rows.map((row) => ({
    id: row.id,
    nameI18n: row.nameI18n,
    movieCount: row.movieCount,
  }));
}

export async function createGenre(nameI18n: LocalizedText): Promise<GenreDto> {
  const [row] = await db.insert(genre).values({ nameI18n }).returning();

  if (!row) throw new HttpError(500, 'INTERNAL_ERROR', 'Failed to create genre');

  return toGenreDto(row);
}

export async function updateGenre(id: string, nameI18n: LocalizedText): Promise<GenreDto> {
  const [row] = await db.update(genre).set({ nameI18n }).where(eq(genre.id, id)).returning();

  if (!row) throw new HttpError(404, 'NOT_FOUND', 'Genre not found');

  return toGenreDto(row);
}

/**
 * Deletes an unused genre.
 *
 * `movie_genre` cascades on genre deletion, which would silently strip the
 * genre off every movie that used it — so the in-use case is refused here
 * rather than left to the database.
 */
export async function deleteGenre(id: string): Promise<void> {
  const [existing] = await db.select({ id: genre.id }).from(genre).where(eq(genre.id, id)).limit(1);

  if (!existing) throw new HttpError(404, 'NOT_FOUND', 'Genre not found');

  const [usage] = await db
    .select({ value: count() })
    .from(movieGenre)
    .where(eq(movieGenre.genreId, id));

  const used = usage?.value ?? 0;

  if (used > 0) {
    throw new HttpError(
      409,
      'GENRE_IN_USE',
      `Genre is still assigned to ${used} movie${used === 1 ? '' : 's'}`,
    );
  }

  await db.delete(genre).where(eq(genre.id, id));
}
