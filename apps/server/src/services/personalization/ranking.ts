import type { RecommendationReason } from '@streaming/shared' with { 'resolution-mode': 'import' };

/**
 * Scoring, ordering and pagination for the recommender (Phase 15).
 *
 * Separated from `recommendationService` for one reason: everything here is a
 * pure function of numbers a query already produced, so the parts of the
 * algorithm most likely to be argued about — the weights, the tie-breaks, the
 * diversity pass — can be tested without a database in the loop.
 */

/** The normalized [0,1] signals a candidate is scored on. */
export interface CandidateSignals {
  genre: number;
  popularity: number;
  recency: number;
  in_progress: number;
  favorite: number;
  /** Additive, and the only signal that may be negative. Range [-1, 1]. */
  editorial_boost: number;
}

/**
 * The weighted model for a device with history.
 *
 * `in_progress` is weighted as heavily as popularity and twice as heavily as
 * recency because a half-watched title is the strongest statement of intent a
 * viewer ever makes without typing anything — "continue watching" is a promise,
 * not a suggestion. Genre affinity dominates at 0.40 because it is the only
 * signal that is *about this device*; the rest describe the platform.
 */
export const SCORE_WEIGHTS = {
  genre: 0.4,
  popularity: 0.2,
  recency: 0.1,
  in_progress: 0.2,
  favorite: 0.1,
} as const;

/**
 * The fallback model for a device with no affinity data.
 *
 * The 0.40 that genre affinity would have carried is redistributed to the two
 * signals that need no history — what the platform is watching and what is new
 * — rather than left on the table, which would flatten every cold-start list
 * towards zero and make the editorial boost the only thing that ordered it.
 */
export const COLD_START_WEIGHTS = { popularity: 0.5, recency: 0.3 } as const;

/** No more than this many consecutive items may share a primary genre. */
export const MAX_CONSECUTIVE_SAME_GENRE = 3;

export function computeScore(signals: CandidateSignals, coldStart: boolean): number {
  const weighted = coldStart
    ? signals.popularity * COLD_START_WEIGHTS.popularity +
      signals.recency * COLD_START_WEIGHTS.recency
    : signals.genre * SCORE_WEIGHTS.genre +
      signals.popularity * SCORE_WEIGHTS.popularity +
      signals.recency * SCORE_WEIGHTS.recency +
      signals.in_progress * SCORE_WEIGHTS.in_progress +
      signals.favorite * SCORE_WEIGHTS.favorite;

  return Math.round((weighted + signals.editorial_boost) * 1e6) / 1e6;
}

/**
 * The one-line explanation shown next to an item.
 *
 * Resolution order follows the brief: resuming beats every other explanation,
 * then a genre the device demonstrably likes, then the two platform-wide
 * signals ranked by which contributed more, and finally the editorial pick —
 * which is last because an operator boosting a title does not change *why* a
 * viewer would want it, only whether they see it.
 *
 * "Dominant" is measured on weighted contributions, not raw signals: a
 * popularity of 0.9 contributes 0.18 while a genre score of 0.6 contributes
 * 0.24, and it is the second that is doing the work of putting the item here.
 */
export function reasonFor(
  signals: CandidateSignals,
  genreName: string | null,
  coldStart: boolean,
): RecommendationReason {
  if (signals.in_progress >= 1) return 'continue_watching';

  const contributions = coldStart
    ? {
        genre: 0,
        popularity: signals.popularity * COLD_START_WEIGHTS.popularity,
        recency: signals.recency * COLD_START_WEIGHTS.recency,
      }
    : {
        genre: signals.genre * SCORE_WEIGHTS.genre,
        popularity: signals.popularity * SCORE_WEIGHTS.popularity,
        recency: signals.recency * SCORE_WEIGHTS.recency,
      };

  const dominant = (Object.entries(contributions) as Array<[keyof typeof contributions, number]>)
    .sort((a, b) => b[1] - a[1])[0]!;

  if (dominant[0] === 'genre' && signals.genre > 0.5 && genreName) {
    return `because_you_like_${genreName}`;
  }

  if (dominant[1] > 0) {
    if (dominant[0] === 'popularity') return 'trending_now';
    if (dominant[0] === 'recency') return 'new_on_platform';
  }

  if (signals.editorial_boost > 0.3) return 'editorial_pick';

  // Everything is flat — a fresh platform with no watch history at all. The
  // list is still ordered by popularity, so this is the honest label.
  return 'trending_now';
}

export interface DiversityCandidate {
  /** Null for content with no genres, which never counts towards a run. */
  primaryGenreId: string | null;
}

/**
 * Breaks up runs of same-genre items in an already-sorted list.
 *
 * One greedy pass: walk the sorted array, and when placing an item would make a
 * fourth consecutive item of the same primary genre, look ahead for the
 * highest-scoring candidate of any other genre and place that instead. The
 * displaced item is not dropped — it keeps its place in the queue and lands as
 * soon as the run is broken — so this reorders the list without removing
 * anything from it.
 *
 * Items with no primary genre (live channels, and series until a
 * `series_genre` relation exists) never extend a run, because "unknown genre"
 * is not a genre and treating it as one would scatter them artificially.
 *
 * O(n²) worst case, on a window bounded by the caller — see
 * `SCORING_WINDOW_LIMIT` in `recommendationService`.
 */
export function injectDiversity<T extends DiversityCandidate>(sorted: readonly T[]): T[] {
  const remaining = [...sorted];
  const output: T[] = [];

  let runGenre: string | null = null;
  let runLength = 0;

  while (remaining.length > 0) {
    let index = 0;

    if (runGenre !== null && runLength >= MAX_CONSECUTIVE_SAME_GENRE) {
      const alternative = remaining.findIndex((item) => item.primaryGenreId !== runGenre);
      // -1 means every remaining item shares the genre; the cap then cannot be
      // honoured and the original order stands rather than the list stalling.
      if (alternative > 0) index = alternative;
    }

    const [chosen] = remaining.splice(index, 1);
    output.push(chosen!);

    const genre = chosen!.primaryGenreId;
    if (genre !== null && genre === runGenre) {
      runLength += 1;
    } else {
      runGenre = genre;
      runLength = genre === null ? 0 : 1;
    }
  }

  return output;
}

/**
 * Offset pagination, base64-encoded.
 *
 * A keyset cursor is not available here: the sort key is a score computed per
 * request from a vector that the next watch event will change, so there is no
 * stable column to seek on. Encoding the offset rather than sending it raw
 * keeps the contract cursor-shaped, so a later switch to a real keyset is a
 * server-side change with no client work.
 */
export function encodeCursor(offset: number): string {
  return Buffer.from(String(offset), 'utf8').toString('base64url');
}

/** Returns 0 for anything unparseable — a bad cursor restarts the list. */
export function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0;

  const decoded = Number.parseInt(Buffer.from(cursor, 'base64url').toString('utf8'), 10);
  return Number.isFinite(decoded) && decoded > 0 ? Math.min(decoded, 10_000) : 0;
}
