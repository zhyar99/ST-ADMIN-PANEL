import type { DeviceContentType, WatchContentType } from '../enums.js';
import type { LocalizedText } from '../schemas/i18n.js';

/**
 * The device personalization contract (Phase 15).
 *
 * Two audiences, and the split between them is the security boundary of this
 * phase:
 *
 *  - Consumer shapes ({@link RecommendationItem}, {@link DeviceHistoryItem}, …)
 *    are what an anonymous TV client receives. Copy is already resolved to one
 *    language, artwork is already a URL, and **no numeric score appears** — a
 *    client that could read the scoring could reverse the ranking.
 *  - Admin shapes ({@link ScoredRecommendationItem}, {@link DeviceProfileDTO},
 *    {@link DeviceAnalyticsOverviewDTO}) carry the numbers, because auditing
 *    what a device is being shown is the entire point of the admin view.
 *
 * The invariant Phase 9 established still holds throughout: no stream URL
 * appears in any of these shapes.
 */

/** Why an item is in a device's list. Rendered as a pill by the client. */
export type RecommendationReason =
  | 'continue_watching'
  | 'trending_now'
  | 'new_on_platform'
  | 'editorial_pick'
  /** Suffixed with the localized genre name, e.g. `because_you_like_Drama`. */
  | `because_you_like_${string}`;

/** Resume state for an item the device started and did not finish. */
export interface InProgressState {
  watch_seconds: number;
  content_seconds: number;
  completion_rate: number;
}

/** One ranked item, as the consumer endpoint returns it. */
export interface RecommendationItem {
  content_type: DeviceContentType;
  content_id: string;
  /** Localized to `Accept-Language`; the raw jsonb never leaves the server. */
  title: string;
  poster_url: string | null;
  reason: RecommendationReason;
  in_progress?: InProgressState;
}

/**
 * The same item with its scoring exposed. Admin-only.
 *
 * `score` is the weighted total including `editorial_boost`; the sub-scores are
 * the normalized [0,1] signals it was built from, so a reviewer can see *why*
 * something ranked where it did rather than only *that* it did.
 */
export interface ScoredRecommendationItem extends RecommendationItem {
  score: number;
  signals: {
    genre: number;
    popularity: number;
    recency: number;
    in_progress: number;
    favorite: number;
    editorial_boost: number;
  };
}

export interface RecommendationResponse {
  items: RecommendationItem[];
  next_cursor: string | null;
  total_available: number;
}

export interface ScoredRecommendationResponse {
  items: ScoredRecommendationItem[];
  next_cursor: string | null;
  total_available: number;
}

/** A favourited or watchlisted item, localized. */
export interface DeviceContentItem {
  content_type: DeviceContentType;
  content_id: string;
  title: string;
  poster_url: string | null;
  added_at: string;
}

export interface DeviceHistoryItem {
  content_type: WatchContentType;
  content_id: string;
  title: string;
  poster_url: string | null;
  watch_seconds: number;
  content_seconds: number;
  completion_rate: number;
  started_at: string;
}

export interface DeviceListResponse<T> {
  items: T[];
  next_cursor: string | null;
  total_available: number;
}

/**
 * What a *device* may know about itself.
 *
 * Deliberately free of `genre_affinity` and `is_blocked`: the affinity vector is
 * the ranking model and the block flag is a moderation decision, and neither is
 * something an anonymous client is owed. Both live on {@link AdminDeviceProfileDTO}.
 */
export interface DeviceProfileDTO {
  id: string;
  first_seen_at: string;
  last_seen_at: string;
  total_watch_seconds: number;
  top_content_types: DeviceContentType[];
}

/** One genre of a device's affinity vector, with the id resolved to a name. */
export interface GenreAffinityEntry {
  genre_id: string;
  genre_name: string;
  score: number;
}

export interface AdminDeviceProfileDTO extends DeviceProfileDTO {
  total_watch_hours: number;
  genre_affinity: GenreAffinityEntry[];
  is_blocked: boolean;
  recent_watch_events: DeviceHistoryItem[];
  favorites_count: number;
  watchlist_count: number;
}

export interface DeviceAnalyticsOverviewDTO {
  period_days: number;
  total_devices: number;
  active_devices_in_period: number;
  new_devices_in_period: number;
  total_watch_hours: number;
  avg_watch_seconds_per_device: number;
  top_genres: Array<{ genre_id: string; genre_name: string; affinity_count: number }>;
  content_type_breakdown: Record<WatchContentType, number>;
}

export interface TrendingContentItem {
  content_type: WatchContentType;
  content_id: string;
  title: string;
  poster_url: string | null;
  watch_count: number;
  unique_devices: number;
  avg_completion_rate: number;
  total_watch_hours: number;
}

export interface RecommendationBoostDTO {
  id: string;
  content_type: DeviceContentType;
  content_id: string;
  /** Null when the boosted row has since been deleted from the catalogue. */
  title_i18n: LocalizedText | null;
  boost_score: number;
  reason: string | null;
  active: boolean;
  expires_at: string | null;
  created_by: string | null;
  created_by_name: string | null;
  created_at: string;
}
