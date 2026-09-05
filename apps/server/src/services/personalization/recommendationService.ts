import { eq, sql } from 'drizzle-orm';

import type {
  DeviceContentType,
  LocalizedText,
  RecommendationItem,
  ScoredRecommendationItem,
  SupportedLocale,
} from '@streaming/shared' with { 'resolution-mode': 'import' };

import { db } from '../../db/client';
import { deviceProfile } from '../../db/schema';
import { assetUrl } from '../../lib/assetUrl';
import { localizeField } from '../../lib/i18n';
import { normalizeAffinity } from './affinity';
import {
  COLD_START_WEIGHTS,
  SCORE_WEIGHTS,
  computeScore,
  decodeCursor,
  encodeCursor,
  injectDiversity,
  reasonFor,
  type CandidateSignals,
} from './ranking';

/**
 * The recommender (Phase 15).
 *
 * Content-based and popularity-based only: there is no collaborative filtering
 * here, no model to train and nothing to schedule. One query per request scores
 * every published title against the calling device's affinity vector, and the
 * ordering it produces is reproducible from the row values alone — which is why
 * the admin audit view can show an operator exactly why a device is seeing what
 * it sees.
 *
 * The division of labour between SQL and TypeScript is deliberate:
 *
 *  - **SQL** produces the six normalized [0,1] signals per candidate. All of
 *    them are aggregates over tables (watch counts, genre joins, boosts), so
 *    computing them anywhere else would mean shipping those tables to the
 *    application to fold them there.
 *  - **TypeScript** turns signals into a score, a reason and an order. Those are
 *    the parts a product decision changes, and they live in `ranking.ts` where
 *    they can be tested without a database.
 *
 * The weights are interpolated into the SQL from the same constants
 * `ranking.ts` scores with, so the ORDER BY that picks the working window and
 * the score that finally orders it cannot drift apart.
 */

/**
 * How many candidates are scored per request before pagination.
 *
 * Diversity injection reorders a list, so it has to see more than one page —
 * but scoring the entire catalogue to return twenty items would make the query
 * grow with the library. The window is the requested page plus a buffer, wide
 * enough that a run of same-genre items has somewhere to be swapped from.
 */
const SCORING_WINDOW_LIMIT = 500;
const SCORING_WINDOW_BUFFER = 60;

/** Popularity is measured over this trailing window. */
const POPULARITY_WINDOW_DAYS = 30;

/**
 * Decay for the freshness signal, per day since publication.
 *
 * 0.005 is a half-life of about 138 days: new content stays boosted for months,
 * because a catalogue this size adds titles in batches and a sharper decay
 * would make "new on platform" mean "added last week" — a row that would
 * frequently be empty.
 */
const RECENCY_DECAY_PER_DAY = 0.005;

/** In-progress means started and not finished. */
const IN_PROGRESS_MIN = 0.05;
const IN_PROGRESS_MAX = 0.79;

/** At or above this, the device has seen it and `exclude_watched` drops it. */
const COMPLETED_THRESHOLD = 0.8;

export interface RecommendationOptions {
  contentTypes?: DeviceContentType[];
  limit?: number;
  cursor?: string;
  excludeWatched?: boolean;
  lang?: SupportedLocale;
}

export interface RecommendationResult {
  items: ScoredRecommendationItem[];
  nextCursor: string | null;
  totalAvailable: number;
  /** True when the device had no usable affinity vector — blocked or brand new. */
  coldStart: boolean;
}

/**
 * One row of the scoring query.
 *
 * The index signature is what `db.execute<T>` requires of a row type; the
 * named fields are what the rest of this module actually reads. Numerics come
 * back as strings from node-postgres — Postgres `numeric` has more range than a
 * JS number, so the driver refuses to lose precision on your behalf — and are
 * converted at the one place they are read.
 */
interface CandidateRow extends Record<string, unknown> {
  content_type: DeviceContentType;
  content_id: string;
  title_i18n: LocalizedText;
  poster_path: string | null;
  primary_genre_id: string | null;
  primary_genre_name: LocalizedText | null;
  genre_score: string;
  popularity_score: string;
  recency_score: string;
  in_progress_score: string;
  favorite_score: string;
  editorial_boost: string;
  last_watch_seconds: number | null;
  last_content_seconds: number | null;
  last_completion: string | null;
  total_available: string;
}

/**
 * The device's affinity vector, or an empty one.
 *
 * A blocked device is scored as if it had never watched anything. It keeps
 * accumulating a profile — the block is a moderation decision, not a data
 * deletion — but the vector is dropped on the way into the query, so the device
 * receives the same globally-popular list a brand-new one does. Nothing about
 * the block is observable from the response.
 */
async function affinityFor(deviceId: string | null): Promise<Record<string, number>> {
  if (!deviceId) return {};

  const [profile] = await db
    .select({ genreAffinity: deviceProfile.genreAffinity, isBlocked: deviceProfile.isBlocked })
    .from(deviceProfile)
    .where(eq(deviceProfile.id, deviceId))
    .limit(1);

  if (!profile || profile.isBlocked) return {};

  return normalizeAffinity(profile.genreAffinity ?? {});
}

/**
 * Scores every published candidate for one device.
 *
 * A note on the episode/series rollup that appears twice below: watch events
 * are recorded against episodes, and recommendations are made about series, so
 * every read of `watch_event` maps `EPISODE -> SERIES` through
 * `episode -> season -> series` before it can be joined to a candidate.
 */
function candidateQuery(
  deviceId: string | null,
  affinity: Record<string, number>,
  contentTypes: DeviceContentType[],
  excludeWatched: boolean,
  coldStart: boolean,
  windowLimit: number,
) {
  const affinityJson = JSON.stringify(affinity);
  const device = deviceId ?? null;

  // Built from the same constants `ranking.ts` scores with — see the module
  // note. Cold start redistributes genre's weight to the two signals that need
  // no history.
  const scoreExpression = coldStart
    ? sql`(popularity_score * ${COLD_START_WEIGHTS.popularity}::numeric + recency_score * ${COLD_START_WEIGHTS.recency}::numeric + editorial_boost)`
    : sql`(genre_score * ${SCORE_WEIGHTS.genre}::numeric + popularity_score * ${SCORE_WEIGHTS.popularity}::numeric + recency_score * ${SCORE_WEIGHTS.recency}::numeric + in_progress_score * ${SCORE_WEIGHTS.in_progress}::numeric + favorite_score * ${SCORE_WEIGHTS.favorite}::numeric + editorial_boost)`;

  return sql`
    with affinity as (
      select ${affinityJson}::jsonb as vector
    ),
    candidate as (
      select 'MOVIE'::text as content_type, m.id as content_id, m.title_i18n as title_i18n,
             poster.file_path as poster_path, m.created_at as created_at
        from movie m
        left join media_asset poster on poster.id = m.poster_asset_id
       where m.status = 'PUBLISHED'
      union all
      select 'SERIES'::text, s.id, s.title_i18n, poster.file_path, s.created_at
        from series s
        left join media_asset poster on poster.id = s.poster_asset_id
       where s.status = 'PUBLISHED'
      union all
      select 'LIVE_CHANNEL'::text, c.id, c.name_i18n, logo.file_path, c.created_at
        from live_channel c
        left join media_asset logo on logo.id = c.logo_asset_id
       where c.status = 'PUBLISHED'
    ),
    device_watch as (
      select
        case when we.content_type = 'EPISODE' then 'SERIES' else we.content_type::text end as content_type,
        case when we.content_type = 'EPISODE' then se.series_id else we.content_id end as content_id,
        max(we.completion_rate) as max_completion,
        (array_agg(we.watch_seconds order by we.started_at desc))[1] as last_watch_seconds,
        (array_agg(we.content_seconds order by we.started_at desc))[1] as last_content_seconds,
        (array_agg(we.completion_rate order by we.started_at desc))[1] as last_completion
        from watch_event we
        left join episode ep on we.content_type = 'EPISODE' and ep.id = we.content_id
        left join season se on se.id = ep.season_id
       where ${device}::text is not null and we.device_id = ${device}::text
       group by 1, 2
      having (case when we.content_type = 'EPISODE' then se.series_id else we.content_id end) is not null
    ),
    popularity as (
      select
        case when we.content_type = 'EPISODE' then 'SERIES' else we.content_type::text end as content_type,
        case when we.content_type = 'EPISODE' then se.series_id else we.content_id end as content_id,
        count(*)::numeric as watch_count
        from watch_event we
        left join episode ep on we.content_type = 'EPISODE' and ep.id = we.content_id
        left join season se on se.id = ep.season_id
       where we.created_at >= now() - make_interval(days => ${POPULARITY_WINDOW_DAYS}::int)
       group by 1, 2
    ),
    popularity_max as (
      select greatest(coalesce(max(watch_count), 0), 1) as peak from popularity
    ),
    scored as (
      select
        c.content_type,
        c.content_id,
        c.title_i18n,
        c.poster_path,
        genres.primary_genre_id,
        genres.primary_genre_name,
        coalesce(genres.genre_score, 0)::numeric as genre_score,
        (coalesce(pop.watch_count, 0) / (select peak from popularity_max))::numeric as popularity_score,
        exp(-1 * ${RECENCY_DECAY_PER_DAY}::double precision
            * greatest(extract(epoch from (now() - c.created_at))::double precision / 86400.0, 0))::numeric as recency_score,
        (case
           when dw.last_completion between ${IN_PROGRESS_MIN}::numeric and ${IN_PROGRESS_MAX}::numeric then 1
           else 0
         end)::numeric as in_progress_score,
        (case when fav.content_id is not null then 1 else 0 end)::numeric as favorite_score,
        coalesce(boost.boost_score, 0)::numeric as editorial_boost,
        dw.last_watch_seconds,
        dw.last_content_seconds,
        dw.last_completion,
        dw.max_completion
        from candidate c
        left join lateral (
          select
            avg(coalesce((affinity.vector ->> mg.genre_id::text)::numeric, 0)) as genre_score,
            (array_agg(mg.genre_id order by coalesce((affinity.vector ->> mg.genre_id::text)::numeric, 0) desc, mg.genre_id))[1] as primary_genre_id,
            (array_agg(g.name_i18n order by coalesce((affinity.vector ->> mg.genre_id::text)::numeric, 0) desc, mg.genre_id))[1] as primary_genre_name
            from movie_genre mg
            join genre g on g.id = mg.genre_id
            cross join affinity
           where c.content_type = 'MOVIE' and mg.movie_id = c.content_id
        ) genres on true
        left join device_watch dw
          on dw.content_type = c.content_type and dw.content_id = c.content_id
        left join popularity pop
          on pop.content_type = c.content_type and pop.content_id = c.content_id
        left join device_favorite fav
          on ${device}::text is not null
         and fav.device_id = ${device}::text
         and fav.content_type::text = c.content_type
         and fav.content_id = c.content_id
        left join recommendation_boost boost
          on boost.content_type::text = c.content_type
         and boost.content_id = c.content_id
         and boost.active
         and (boost.expires_at is null or boost.expires_at > now())
       where c.content_type = any(${sql.param(contentTypes)}::text[])
         and (
           ${!excludeWatched}::boolean
           or dw.max_completion is null
           or dw.max_completion < ${COMPLETED_THRESHOLD}::numeric
         )
    )
    select
      content_type, content_id, title_i18n, poster_path,
      primary_genre_id, primary_genre_name,
      genre_score, popularity_score, recency_score,
      in_progress_score, favorite_score, editorial_boost,
      last_watch_seconds, last_content_seconds, last_completion,
      (count(*) over ())::text as total_available
      from scored
     order by ${scoreExpression} desc, content_id asc
     limit ${windowLimit}
  `;
}

const ALL_CONTENT_TYPES: DeviceContentType[] = ['MOVIE', 'SERIES', 'LIVE_CHANNEL'];

/**
 * Ranked recommendations for a device, or globally when `deviceId` is null.
 *
 * Never throws on an empty catalogue: no published content is an empty list
 * with a zero total, not a 500.
 */
export async function getRecommendations(
  deviceId: string | null,
  options: RecommendationOptions = {},
): Promise<RecommendationResult> {
  const limit = Math.min(Math.max(options.limit ?? 20, 1), 50);
  const offset = decodeCursor(options.cursor);
  const contentTypes = options.contentTypes?.length ? options.contentTypes : ALL_CONTENT_TYPES;
  const excludeWatched = options.excludeWatched ?? true;
  const lang = options.lang ?? 'en';

  const affinity = await affinityFor(deviceId);
  const coldStart = Object.keys(affinity).length === 0;

  const windowLimit = Math.min(offset + limit + SCORING_WINDOW_BUFFER, SCORING_WINDOW_LIMIT);

  const result = await db.execute<CandidateRow>(
    candidateQuery(deviceId, affinity, contentTypes, excludeWatched, coldStart, windowLimit),
  );

  const rows = result.rows ?? [];
  if (rows.length === 0) {
    return { items: [], nextCursor: null, totalAvailable: 0, coldStart };
  }

  const totalAvailable = Number(rows[0]!.total_available ?? rows.length);

  const scored = rows.map((row) => {
    const signals: CandidateSignals = {
      genre: Number(row.genre_score),
      popularity: Number(row.popularity_score),
      recency: Number(row.recency_score),
      in_progress: Number(row.in_progress_score),
      favorite: Number(row.favorite_score),
      editorial_boost: Number(row.editorial_boost),
    };

    const genreName = row.primary_genre_name ? localizeField(row.primary_genre_name, lang) : null;

    const item: ScoredRecommendationItem = {
      content_type: row.content_type,
      content_id: row.content_id,
      title: localizeField(row.title_i18n, lang),
      poster_url: assetUrl(row.poster_path),
      reason: reasonFor(signals, genreName, coldStart),
      score: computeScore(signals, coldStart),
      signals,
    };

    if (signals.in_progress >= 1 && row.last_content_seconds && row.last_watch_seconds !== null) {
      item.in_progress = {
        watch_seconds: row.last_watch_seconds,
        content_seconds: row.last_content_seconds,
        completion_rate: Number(row.last_completion ?? 0),
      };
    }

    return { item, primaryGenreId: row.primary_genre_id };
  });

  scored.sort(
    (a, b) => b.item.score - a.item.score || a.item.content_id.localeCompare(b.item.content_id),
  );

  const page = injectDiversity(scored).slice(offset, offset + limit);

  const nextCursor =
    offset + limit >= totalAvailable || page.length < limit ? null : encodeCursor(offset + limit);

  return { items: page.map((entry) => entry.item), nextCursor, totalAvailable, coldStart };
}

/** Strips the scoring for the consumer response. */
export function toConsumerItem(item: ScoredRecommendationItem): RecommendationItem {
  const { score: _score, signals: _signals, ...rest } = item;
  return rest;
}
