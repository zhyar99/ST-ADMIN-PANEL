import type { PublicationStatus, StreamSourceKind, SubtitleLanguage } from '../enums.js';
import type { SupportedLocale } from '../schemas/i18n.js';

/**
 * The consumer-facing API contract (Phase 9).
 *
 * Two DTO families live in this package and they are not interchangeable:
 *
 *  - The `*Dto` types in `models.ts` are the **admin** shapes. They carry raw
 *    `*_i18n` objects and full `AssetDto`s because the Admin SPA edits every
 *    language at once.
 *  - The unsuffixed types below are the **consumer** shapes. Copy is already
 *    resolved to one language (from `Accept-Language`) and artwork is already
 *    reduced to a URL string, because a player has nothing to do with the rest.
 *
 * The invariant both families share: no stream URL appears in any catalogue,
 * list or detail shape. `stream_source.url` leaves the server through exactly
 * one door, {@link PlaybackSessionResponse}.
 */

/** Page descriptor returned alongside every consumer list. */
export interface PaginationMeta {
  page: number;
  limit: number;
  total: number;
}

export interface PaginatedResponse<T> {
  data: T[];
  meta: PaginationMeta;
}

/** A genre reduced to the requested language. */
export interface GenreRef {
  id: string;
  name: string;
}

/**
 * A subtitle track as a player consumes it.
 *
 * `url` points at a subtitle *file* — a library asset resolved through
 * STORAGE_URL_PREFIX, or the remote URL an operator supplied. It is unrelated
 * to `stream_source.url` and is safe to ship in a catalogue response. It is
 * null only if a row somehow satisfies neither branch of the
 * `subtitle_track_exactly_one_source` CHECK.
 */
export interface SubtitleTrackDTO {
  language: SubtitleLanguage;
  url: string | null;
}

export interface MovieListItem {
  id: string;
  title: string;
  overview: string;
  releaseYear: number | null;
  runtimeMinutes: number | null;
  posterUrl: string | null;
  backdropUrl: string | null;
  genres: GenreRef[];
}

export interface MovieDetail extends MovieListItem {
  tagline: string | null;
  subtitleTracks: SubtitleTrackDTO[];
}

export interface SeriesListItem {
  id: string;
  title: string;
  overview: string;
  posterUrl: string | null;
  backdropUrl: string | null;
  /**
   * Always empty. The schema has no series-to-genre relation — `movie_genre` is
   * the only genre join table — so there is nothing to populate this from. The
   * key is present so a client can render movies and series through one card
   * component today and start receiving real values the day a `series_genre`
   * table lands, with no contract change.
   */
  genres: GenreRef[];
}

/**
 * An episode inside a series detail response.
 *
 * `status` is included even though only PUBLISHED episodes are ever returned:
 * clients cache these payloads, and a field that says what it is beats one that
 * has to be inferred from the fact that it arrived at all.
 */
export interface EpisodeDetail {
  id: string;
  number: number;
  title: string;
  overview: string | null;
  thumbnailUrl: string | null;
  subtitleTracks: SubtitleTrackDTO[];
  status: PublicationStatus;
}

export interface Season {
  id: string;
  number: number;
  episodes: EpisodeDetail[];
}

export interface SeriesDetail extends SeriesListItem {
  seasons: Season[];
}

export interface LiveChannelListItem {
  id: string;
  name: string;
  logoUrl: string | null;
  category: string;
}

export type SearchHitType = 'movie' | 'series' | 'live_channel';

export interface SearchHit {
  type: SearchHitType;
  id: string;
  title: string;
  /** Poster for a movie or series, logo for a channel. */
  imageUrl: string | null;
}

export type PlaybackContentType = 'movie' | 'episode' | 'live_channel';

export interface PlaybackSessionRequest {
  contentType: PlaybackContentType;
  contentId: string;
  language?: SupportedLocale;
}

/**
 * The ad break rules for one VOD session (Phase 11).
 *
 * Fixed-rule, not a campaign: every VOD session in the system gets the same
 * timing, because `ad_config` is a single global row. Nothing here is chosen
 * per viewer, per title or per genre — there is no viewer identity to choose
 * by, and inventing one would be a campaign model rather than a policy.
 *
 * The timing fields are *instructions to the player*, not a schedule the server
 * keeps: it is the client that counts minutes and decides when a mid-roll is
 * due. That is why an interval is sent rather than a list of cue points — a
 * server-computed cue list would have to be recomputed whenever the config
 * changed mid-playback, and a session is issued once.
 *
 * Grew two fields in Phase 11, both additive: `preRoll.skippable` states the
 * rule that was previously only implicit (a pre-roll is never skippable, while
 * a mid-roll becomes skippable after `skipAfterSeconds`), and `creative.id`
 * lets a client correlate what it played with the pool it came from. `url`
 * narrowed from `string | null` to `string` — a creative row without a file
 * cannot exist, so the null was never reachable and every consumer that
 * handled it still compiles.
 */
export interface AdPolicyDTO {
  preRoll: {
    minSeconds: number;
    maxSeconds: number;
    /** Always false. A pre-roll runs to completion; only mid-rolls skip. */
    skippable: boolean;
  };
  midRoll: { intervalMinutes: number; maxSeconds: number; skipAfterSeconds: number };
  /**
   * One creative from the active pool, or null when the pool is empty.
   *
   * Null does not mean "no ads": the timing above still stands, and a client
   * that receives it has simply been given no inventory to fill the break
   * with. Deactivating every creative is therefore a content decision, not a
   * way to switch advertising off.
   */
  creative: { id: string; url: string; durationSeconds: number } | null;
}

/**
 * The only response in the system that carries a stream URL.
 *
 * `subtitleTracks` and `adPolicy` are optional rather than nullable because a
 * live channel has neither concept: the keys are absent from a channel session,
 * not present-and-empty.
 */
export interface PlaybackSessionResponse {
  sourceUrl: string;
  /**
   * How to play `sourceUrl`.
   *
   * `DIRECT` — a media URL (.mp4, HLS manifest) for a video element. `EMBED` —
   * a third-party player page that has to be loaded in an iframe or a webview;
   * handing it to a video element plays nothing.
   *
   * Always present, including for a live channel. A client that predates the
   * field and ignores it behaves exactly as before, because every source that
   * existed before embeds did is DIRECT.
   */
  sourceKind: StreamSourceKind;
  subtitleTracks?: SubtitleTrackDTO[];
  adPolicy?: AdPolicyDTO | null;
}
