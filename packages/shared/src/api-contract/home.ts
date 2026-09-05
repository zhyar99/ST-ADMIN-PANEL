import type { LocalizedText } from '../schemas/i18n.js';

/**
 * Manually-curated Home rows (Phase 10).
 *
 * Home is editorial, not algorithmic: an operator names a row and picks the
 * items in it, in order. Nothing here is derived from watch history or
 * popularity — recommendations are deferred — so a row is exactly the list an
 * admin typed and no more.
 *
 * Same two-family split as `consumer.ts`: the `*Dto` shapes below are the
 * **admin** ones and carry raw `*I18n` objects plus the unresolved refs the
 * editor manipulates; the unsuffixed ones are the **consumer** shapes, with
 * copy already reduced to one language and refs already resolved to content.
 *
 * The invariant this file inherits from the rest of the contract: no stream URL
 * appears in any of these types. A resolved Home item is a card — a title, some
 * artwork and the id needed to start playback — and `POST /playback/session`
 * remains the only door `stream_source.url` leaves through.
 */

/**
 * Which table a Home row entry points at.
 *
 * Upper-snake to match `stream_source_owner_type` and the admin vocabulary the
 * item picker shows as badges, rather than the lower-snake `SearchHitType` the
 * consumer search endpoint uses. The two are separate vocabularies on purpose;
 * this one is stored in a jsonb column and so is the one that has to stay
 * stable across migrations.
 */
export type HomeItemRefType = 'MOVIE' | 'SERIES' | 'LIVE_CHANNEL';

/**
 * One entry in a row's `item_refs`, as stored.
 *
 * Deliberately just a pointer. It carries no denormalised title or artwork,
 * because a row that cached those would keep showing a stale title after the
 * movie was renamed, and would have to be rewritten every time unrelated
 * content changed. Resolution happens per-request instead.
 */
export interface HomeItemRef {
  type: HomeItemRefType;
  id: string;
}

// --- Admin shapes ----------------------------------------------------------

/** A Home row as the Admin SPA edits it. */
export interface HomeRowDto {
  id: string;
  titleI18n: LocalizedText;
  /** Ascending display position. Dense and zero-based after any reorder. */
  order: number;
  /**
   * Refs exactly as stored — unresolved, and including any that currently
   * point at draft or deleted content. The editor must keep showing an entry
   * whose target was unpublished, or unpublishing a movie would silently erase
   * it from every row an operator had put it in.
   */
  itemRefs: HomeItemRef[];
  /** ISO 8601 timestamps. */
  createdAt: string;
  updatedAt: string;
}

export interface HomeRowCreateInput {
  title_i18n: LocalizedText;
  order?: number;
  item_refs?: HomeItemRef[];
}

export interface HomeRowUpdateInput {
  title_i18n?: LocalizedText;
  order?: number;
  item_refs?: HomeItemRef[];
}

/**
 * One hit in the item picker's search.
 *
 * `title` is already localised — the picker renders a list, not a form — and
 * `posterUrl` is a channel's logo for LIVE_CHANNEL hits, since a picker row
 * only needs "the small square image for this thing".
 */
export interface ContentSearchResult {
  type: HomeItemRefType;
  id: string;
  title: string;
  posterUrl: string | null;
}

// --- Consumer shapes -------------------------------------------------------

export interface HomeMovieItem {
  type: 'MOVIE';
  id: string;
  title: string;
  overview: string;
  posterUrl: string | null;
  backdropUrl: string | null;
  releaseYear: number | null;
  runtimeMinutes: number | null;
}

export interface HomeSeriesItem {
  type: 'SERIES';
  id: string;
  title: string;
  overview: string;
  posterUrl: string | null;
  backdropUrl: string | null;
}

export interface HomeLiveChannelItem {
  type: 'LIVE_CHANNEL';
  id: string;
  name: string;
  logoUrl: string | null;
  category: string;
}

/**
 * A resolved Home entry.
 *
 * Discriminated on `type` so a client can switch exhaustively. The three
 * members deliberately do not share a common `title` key — a channel has a
 * `name` and no overview, and flattening that into a lowest-common-denominator
 * shape would mean inventing empty strings for fields that have no meaning.
 */
export type HomeItem = HomeMovieItem | HomeSeriesItem | HomeLiveChannelItem;

export interface HomeRow {
  id: string;
  /** Resolved to the negotiated language. */
  title: string;
  /** In `item_refs` order, with unresolvable entries dropped. Never empty. */
  items: HomeItem[];
}

export interface HomeResponse {
  rows: HomeRow[];
}
