import type {
  EpisodeCreateInput,
  EpisodeDetailDto,
  EpisodeListItemDto,
  EpisodeUpdateInput,
  PublicationStatus,
  SeasonDto,
  SeriesCreateInput,
  SeriesDetailDto,
  SeriesListItemDto,
  SeriesUpdateInput,
  StreamSourceCreateInput,
  StreamSourceDto,
  StreamSourceUpdateInput,
  SubtitleTrackCreateInput,
  SubtitleTrackDto,
} from '@streaming/shared';

import { apiFetch } from './api';
import type { StreamTestOutcome } from './catalogApi';

/**
 * Series, season and episode client.
 *
 * Split from `catalogApi` rather than folded into it because every path here is
 * nested three levels deep; sharing the movie helpers would mean threading a
 * base path through all of them for no gain in either file.
 *
 * As with the movie client, response types come from @streaming/shared — so the
 * absence of a `url` field on StreamSourceDto is enforced by the compiler here
 * as well as by the server.
 */

// --- Series ---

export interface ListSeriesParams {
  status?: PublicationStatus;
  page?: number;
  limit?: number;
}

export interface ListSeriesResult {
  items: SeriesListItemDto[];
  total: number;
  page: number;
  limit: number;
  hasMore: boolean;
}

export function listSeries(params: ListSeriesParams = {}): Promise<ListSeriesResult> {
  const query = new URLSearchParams();
  if (params.status) query.set('status', params.status);
  if (params.page) query.set('page', String(params.page));
  if (params.limit) query.set('limit', String(params.limit));

  const suffix = query.size > 0 ? `?${query.toString()}` : '';
  return apiFetch<ListSeriesResult>(`/admin/series${suffix}`);
}

export function getSeries(seriesId: string): Promise<SeriesDetailDto> {
  return apiFetch<{ series: SeriesDetailDto }>(`/admin/series/${seriesId}`).then(
    (body) => body.series,
  );
}

export function createSeries(input: SeriesCreateInput): Promise<SeriesDetailDto> {
  return apiFetch<{ series: SeriesDetailDto }>('/admin/series', {
    method: 'POST',
    body: JSON.stringify(input),
  }).then((body) => body.series);
}

export function updateSeries(
  seriesId: string,
  input: SeriesUpdateInput,
): Promise<SeriesDetailDto> {
  return apiFetch<{ series: SeriesDetailDto }>(`/admin/series/${seriesId}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  }).then((body) => body.series);
}

export function deleteSeries(seriesId: string): Promise<void> {
  return apiFetch<void>(`/admin/series/${seriesId}`, { method: 'DELETE' });
}

// --- Seasons ---

export function listSeasons(seriesId: string): Promise<SeasonDto[]> {
  return apiFetch<{ seasons: SeasonDto[] }>(`/admin/series/${seriesId}/seasons`).then(
    (body) => body.seasons,
  );
}

export function createSeason(seriesId: string, number: number): Promise<SeasonDto> {
  return apiFetch<{ season: SeasonDto }>(`/admin/series/${seriesId}/seasons`, {
    method: 'POST',
    body: JSON.stringify({ number }),
  }).then((body) => body.season);
}

export function deleteSeason(seriesId: string, seasonId: string): Promise<void> {
  return apiFetch<void>(`/admin/series/${seriesId}/seasons/${seasonId}`, { method: 'DELETE' });
}

// --- Episodes ---

/** The shared prefix for everything hanging off a single episode. */
function episodePath(seriesId: string, seasonId: string, episodeId: string): string {
  return `/admin/series/${seriesId}/seasons/${seasonId}/episodes/${episodeId}`;
}

export function listEpisodes(
  seriesId: string,
  seasonId: string,
): Promise<EpisodeListItemDto[]> {
  return apiFetch<{ episodes: EpisodeListItemDto[] }>(
    `/admin/series/${seriesId}/seasons/${seasonId}/episodes`,
  ).then((body) => body.episodes);
}

export function getEpisode(
  seriesId: string,
  seasonId: string,
  episodeId: string,
): Promise<EpisodeDetailDto> {
  return apiFetch<{ episode: EpisodeDetailDto }>(
    episodePath(seriesId, seasonId, episodeId),
  ).then((body) => body.episode);
}

export function createEpisode(
  seriesId: string,
  seasonId: string,
  input: EpisodeCreateInput,
): Promise<EpisodeDetailDto> {
  return apiFetch<{ episode: EpisodeDetailDto }>(
    `/admin/series/${seriesId}/seasons/${seasonId}/episodes`,
    { method: 'POST', body: JSON.stringify(input) },
  ).then((body) => body.episode);
}

export function updateEpisode(
  seriesId: string,
  seasonId: string,
  episodeId: string,
  input: EpisodeUpdateInput,
): Promise<EpisodeDetailDto> {
  return apiFetch<{ episode: EpisodeDetailDto }>(episodePath(seriesId, seasonId, episodeId), {
    method: 'PATCH',
    body: JSON.stringify(input),
  }).then((body) => body.episode);
}

export function deleteEpisode(
  seriesId: string,
  seasonId: string,
  episodeId: string,
): Promise<void> {
  return apiFetch<void>(episodePath(seriesId, seasonId, episodeId), { method: 'DELETE' });
}

// --- Episode stream sources ---

/** Identifies one episode. Passed around as a unit because every source and
 * subtitle call below needs all three ids to address it. */
export interface EpisodeRef {
  seriesId: string;
  seasonId: string;
  episodeId: string;
}

function sourcesPath(ref: EpisodeRef): string {
  return `${episodePath(ref.seriesId, ref.seasonId, ref.episodeId)}/sources`;
}

export function listEpisodeSources(ref: EpisodeRef): Promise<StreamSourceDto[]> {
  return apiFetch<{ sources: StreamSourceDto[] }>(sourcesPath(ref)).then((body) => body.sources);
}

export function addEpisodeSource(
  ref: EpisodeRef,
  input: StreamSourceCreateInput,
): Promise<StreamSourceDto> {
  return apiFetch<{ source: StreamSourceDto }>(sourcesPath(ref), {
    method: 'POST',
    body: JSON.stringify(input),
  }).then((body) => body.source);
}

export function updateEpisodeSource(
  ref: EpisodeRef,
  sourceId: string,
  input: StreamSourceUpdateInput,
): Promise<StreamSourceDto> {
  return apiFetch<{ source: StreamSourceDto }>(`${sourcesPath(ref)}/${sourceId}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  }).then((body) => body.source);
}

export function deleteEpisodeSource(ref: EpisodeRef, sourceId: string): Promise<void> {
  return apiFetch<void>(`${sourcesPath(ref)}/${sourceId}`, { method: 'DELETE' });
}

export function reorderEpisodeSources(
  ref: EpisodeRef,
  orderedIds: string[],
): Promise<StreamSourceDto[]> {
  return apiFetch<{ sources: StreamSourceDto[] }>(`${sourcesPath(ref)}/reorder`, {
    method: 'POST',
    body: JSON.stringify({ orderedIds }),
  }).then((body) => body.sources);
}

/** Reveals a raw URL. ADMIN-only and audited server-side. */
export function getEpisodeSourceUrl(ref: EpisodeRef, sourceId: string): Promise<string> {
  return apiFetch<{ url: string }>(`${sourcesPath(ref)}/${sourceId}/url`).then((body) => body.url);
}

export function testEpisodeSource(
  ref: EpisodeRef,
  sourceId: string,
): Promise<StreamTestOutcome> {
  return apiFetch<StreamTestOutcome>(`${sourcesPath(ref)}/${sourceId}/test`, { method: 'POST' });
}

// --- Episode subtitle tracks ---

function subtitlesPath(ref: EpisodeRef): string {
  return `${episodePath(ref.seriesId, ref.seasonId, ref.episodeId)}/subtitles`;
}

export function listEpisodeSubtitles(ref: EpisodeRef): Promise<SubtitleTrackDto[]> {
  return apiFetch<{ subtitles: SubtitleTrackDto[] }>(subtitlesPath(ref)).then(
    (body) => body.subtitles,
  );
}

export function addEpisodeSubtitle(
  ref: EpisodeRef,
  input: SubtitleTrackCreateInput,
): Promise<SubtitleTrackDto> {
  return apiFetch<{ subtitle: SubtitleTrackDto }>(subtitlesPath(ref), {
    method: 'POST',
    body: JSON.stringify(input),
  }).then((body) => body.subtitle);
}

export function deleteEpisodeSubtitle(ref: EpisodeRef, subtitleId: string): Promise<void> {
  return apiFetch<void>(`${subtitlesPath(ref)}/${subtitleId}`, { method: 'DELETE' });
}
