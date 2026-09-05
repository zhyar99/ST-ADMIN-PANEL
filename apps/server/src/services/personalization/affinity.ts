/**
 * The genre-affinity model (Phase 15).
 *
 * Pure functions, no database, no clock of their own — every entry point takes
 * `now` as an argument. That is what makes the model testable at the boundaries
 * that actually matter (a completion rate of exactly 0.10, an event 90 days
 * old) rather than only through an integration test that has to fabricate
 * timestamps in Postgres.
 *
 * The vector is a map of `genre_id -> score` in [0,1], normalised after every
 * update so the device's strongest genre always sits at exactly 1.0. That
 * normalisation is what makes the scores comparable *between* devices: a
 * viewer with 400 hours of drama and one with four both end up with drama at
 * 1.0, and the ranking then differs by what else they watched rather than by
 * how much they watch overall.
 */

/**
 * The most genres a stored vector may carry.
 *
 * Without a cap the map grows for the life of the device — a household screen
 * that samples everything would eventually carry every genre in the catalogue,
 * and the vector is read and rewritten on every single ingestion. The 50
 * highest scores are kept; anything below that is, by construction, a genre the
 * device has barely touched.
 */
export const MAX_AFFINITY_GENRES = 50;

/**
 * Decay constant for the recency weight, per day.
 *
 * 0.02 gives a half-life of ln(2)/0.02 ≈ 34.7 days: a month-old session counts
 * about half as much as today's, and a 90-day-old one about a sixth.
 */
const RECENCY_DECAY_PER_DAY = 0.02;

const MS_PER_DAY = 86_400_000;

/** A rewatch is a stronger statement than a first viewing. */
const REWATCH_MULTIPLIER = 1.4;

/**
 * How much a viewing session counts, by how much of it was watched.
 *
 * The first band is 0 on purpose: someone who opened a title and left inside
 * the first tenth has told us they did *not* want it, and folding that into a
 * positive affinity is how a recommender ends up confidently showing people
 * more of what they bounced off.
 */
export function completionRateWeight(completionRate: number): number {
  if (!Number.isFinite(completionRate) || completionRate < 0.1) return 0;
  if (completionRate < 0.25) return 0.2;
  if (completionRate < 0.5) return 0.5;
  if (completionRate < 0.8) return 0.8;
  return 1;
}

/** `exp(-0.02 × days_ago)`, clamped so a future timestamp cannot exceed 1. */
export function recencyWeight(startedAt: Date, now: Date): number {
  const daysAgo = (now.getTime() - startedAt.getTime()) / MS_PER_DAY;
  if (!Number.isFinite(daysAgo) || daysAgo <= 0) return 1;
  return Math.exp(-RECENCY_DECAY_PER_DAY * daysAgo);
}

export interface WatchSignalInput {
  completionRate: number;
  startedAt: Date;
  rewatch: boolean;
}

/** The strength of one event, in [0, 1.4]. Zero for a bounce. */
export function signalStrength(input: WatchSignalInput, now: Date): number {
  const completion = completionRateWeight(input.completionRate);
  if (completion === 0) return 0;

  return completion * recencyWeight(input.startedAt, now) * (input.rewatch ? REWATCH_MULTIPLIER : 1);
}

/** Four decimal places, which is the resolution the vector is stored at. */
function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

/**
 * Folds one event's signal into an affinity vector.
 *
 * Incremental by design: the update reads the current score for each of the
 * content's genres and nothing else, so ingestion cost does not grow with a
 * device's history. The update rule
 *
 *     new = current + signal × (1 - current)
 *
 * approaches 1.0 asymptotically — each event closes a fixed fraction of the
 * remaining distance — so a score saturates rather than running away, and the
 * tenth drama a device watches moves the needle far less than the first.
 * (`REWATCH_MULTIPLIER` can push a single step past 1.0, hence the clamp.)
 *
 * Afterwards the whole vector is renormalised against its own maximum and
 * trimmed to {@link MAX_AFFINITY_GENRES}. Returns a new object; the input is
 * not mutated.
 */
export function applyWatchSignal(
  current: Record<string, number>,
  genreIds: readonly string[],
  signal: number,
): Record<string, number> {
  const next: Record<string, number> = {};

  for (const [genreId, score] of Object.entries(current)) {
    if (Number.isFinite(score)) next[genreId] = score;
  }

  if (signal > 0) {
    for (const genreId of genreIds) {
      const score = next[genreId] ?? 0;
      next[genreId] = round4(Math.min(1, score + signal * (1 - score)));
    }
  }

  return normalizeAffinity(next);
}

/**
 * Renormalises to a maximum of 1.0 and keeps the top {@link MAX_AFFINITY_GENRES}.
 *
 * Exported because the read paths need it too: a vector loaded from a row
 * written by an older revision of this file should still be scored on the same
 * scale as one written by this one.
 */
export function normalizeAffinity(vector: Record<string, number>): Record<string, number> {
  const entries = Object.entries(vector).filter(
    ([, score]) => Number.isFinite(score) && score > 0,
  );

  if (entries.length === 0) return {};

  const max = Math.max(...entries.map(([, score]) => score));
  const scaled = entries.map(([genreId, score]) => [genreId, round4(score / max)] as const);

  // Ties break on genre id so the trim is deterministic — the same history
  // always produces the same stored vector.
  scaled.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

  return Object.fromEntries(scaled.slice(0, MAX_AFFINITY_GENRES));
}

/**
 * Orders the content types a device watches, most-watched first.
 *
 * Episodes are counted as SERIES: the profile answers "does this device watch
 * shows, films or live TV", and an episode count is the evidence for the first
 * of those. Types with no events are omitted rather than listed at zero — the
 * array is a ranking, and a rank for something that never happened is noise.
 */
export function rankContentTypes(counts: Record<string, number>): string[] {
  const rolled: Record<string, number> = {};

  for (const [type, count] of Object.entries(counts)) {
    if (!Number.isFinite(count) || count <= 0) continue;
    const key = type === 'EPISODE' ? 'SERIES' : type;
    rolled[key] = (rolled[key] ?? 0) + count;
  }

  return Object.entries(rolled)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([type]) => type);
}
