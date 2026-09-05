import type {
  GenreDto,
  GenreListItemDto,
  MovieCreateInput,
  MovieDetailDto,
  MovieListItemDto,
  MovieUpdateInput,
  PublicationStatus,
  StreamHealthCheckDto,
  StreamSourceCreateInput,
  StreamSourceDto,
  StreamSourceUpdateInput,
  StreamTestResult,
  SubtitleTrackCreateInput,
  SubtitleTrackDto,
} from '@streaming/shared';

import { apiFetch } from './api';

/**
 * Catalogue client. Every response type comes from @streaming/shared, so the
 * absence of a `url` field on StreamSourceDto is enforced by the compiler here
 * as well as by the server.
 */

// --- Genres ---

export function listGenres(): Promise<GenreListItemDto[]> {
  return apiFetch<{ genres: GenreListItemDto[] }>('/admin/genres').then((body) => body.genres);
}

export function createGenre(input: { name_i18n: GenreDto['nameI18n'] }): Promise<GenreDto> {
  return apiFetch<{ genre: GenreDto }>('/admin/genres', { method: 'POST', body: input }).then(
    (body) => body.genre,
  );
}

export function updateGenre(
  id: string,
  input: { name_i18n: GenreDto['nameI18n'] },
): Promise<GenreDto> {
  return apiFetch<{ genre: GenreDto }>(`/admin/genres/${id}`, {
    method: 'PATCH',
    body: input,
  }).then((body) => body.genre);
}

export function deleteGenre(id: string): Promise<void> {
  return apiFetch<void>(`/admin/genres/${id}`, { method: 'DELETE' });
}

// --- Movies ---

export interface ListMoviesParams {
  status?: PublicationStatus;
  page?: number;
  limit?: number;
}

export interface ListMoviesResult {
  items: MovieListItemDto[];
  total: number;
  page: number;
  limit: number;
  hasMore: boolean;
}

export function listMovies(params: ListMoviesParams = {}): Promise<ListMoviesResult> {
  const query = new URLSearchParams();
  if (params.status) query.set('status', params.status);
  if (params.page) query.set('page', String(params.page));
  if (params.limit) query.set('limit', String(params.limit));

  const suffix = query.size > 0 ? `?${query.toString()}` : '';
  return apiFetch<ListMoviesResult>(`/admin/movies${suffix}`);
}

export function getMovie(id: string): Promise<MovieDetailDto> {
  return apiFetch<{ movie: MovieDetailDto }>(`/admin/movies/${id}`).then((body) => body.movie);
}

export function createMovie(input: MovieCreateInput): Promise<MovieDetailDto> {
  return apiFetch<{ movie: MovieDetailDto }>('/admin/movies', {
    method: 'POST',
    body: input,
  }).then((body) => body.movie);
}

export function updateMovie(id: string, input: MovieUpdateInput): Promise<MovieDetailDto> {
  return apiFetch<{ movie: MovieDetailDto }>(`/admin/movies/${id}`, {
    method: 'PATCH',
    body: input,
  }).then((body) => body.movie);
}

export function deleteMovie(id: string): Promise<void> {
  return apiFetch<void>(`/admin/movies/${id}`, { method: 'DELETE' });
}

// --- Stream sources ---

export function listSources(movieId: string): Promise<StreamSourceDto[]> {
  return apiFetch<{ sources: StreamSourceDto[] }>(`/admin/movies/${movieId}/sources`).then(
    (body) => body.sources,
  );
}

export function addSource(
  movieId: string,
  input: StreamSourceCreateInput,
): Promise<StreamSourceDto> {
  return apiFetch<{ source: StreamSourceDto }>(`/admin/movies/${movieId}/sources`, {
    method: 'POST',
    body: input,
  }).then((body) => body.source);
}

export function updateSource(
  movieId: string,
  sourceId: string,
  input: StreamSourceUpdateInput,
): Promise<StreamSourceDto> {
  return apiFetch<{ source: StreamSourceDto }>(`/admin/movies/${movieId}/sources/${sourceId}`, {
    method: 'PATCH',
    body: input,
  }).then((body) => body.source);
}

export function deleteSource(movieId: string, sourceId: string): Promise<void> {
  return apiFetch<void>(`/admin/movies/${movieId}/sources/${sourceId}`, { method: 'DELETE' });
}

export function reorderSources(movieId: string, orderedIds: string[]): Promise<StreamSourceDto[]> {
  return apiFetch<{ sources: StreamSourceDto[] }>(`/admin/movies/${movieId}/sources/reorder`, {
    method: 'POST',
    body: { orderedIds },
  }).then((body) => body.sources);
}

/** ADMIN-only and audited server-side — every call writes an audit_log row. */
export function getSourceUrl(movieId: string, sourceId: string): Promise<string> {
  return apiFetch<{ url: string }>(`/admin/movies/${movieId}/sources/${sourceId}/url`).then(
    (body) => body.url,
  );
}

export interface StreamTestOutcome {
  result: StreamTestResult;
  testedAt: string;
  /** Round-trip time of the probe, or null when the request never left. */
  latencyMs: number | null;
  reason: string;
}

export function testSource(movieId: string, sourceId: string): Promise<StreamTestOutcome> {
  return apiFetch<StreamTestOutcome>(`/admin/movies/${movieId}/sources/${sourceId}/test`, {
    method: 'POST',
  });
}

/**
 * Retained health checks for one source, newest first and capped at 20 by the
 * server.
 *
 * Owner-agnostic, unlike everything else in this file: history is served by
 * bare source id, so movies, episodes and live channels all call this one.
 */
export function listSourceHealthHistory(sourceId: string): Promise<StreamHealthCheckDto[]> {
  return apiFetch<{ items: StreamHealthCheckDto[] }>(
    `/admin/stream-sources/${sourceId}/health-history`,
  ).then((body) => body.items);
}

// --- Subtitles ---

export function listSubtitles(movieId: string): Promise<SubtitleTrackDto[]> {
  return apiFetch<{ subtitles: SubtitleTrackDto[] }>(`/admin/movies/${movieId}/subtitles`).then(
    (body) => body.subtitles,
  );
}

export function addSubtitle(
  movieId: string,
  input: SubtitleTrackCreateInput,
): Promise<SubtitleTrackDto> {
  return apiFetch<{ subtitle: SubtitleTrackDto }>(`/admin/movies/${movieId}/subtitles`, {
    method: 'POST',
    body: input,
  }).then((body) => body.subtitle);
}

export function deleteSubtitle(movieId: string, subtitleId: string): Promise<void> {
  return apiFetch<void>(`/admin/movies/${movieId}/subtitles/${subtitleId}`, { method: 'DELETE' });
}
