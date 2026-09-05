import { and, desc, eq, notInArray } from 'drizzle-orm';

import type {
  StreamHealthCheckDto,
  StreamTestResult,
} from '@streaming/shared' with { 'resolution-mode': 'import' };

import { db } from '../../db/client';
import { logger } from '../../logger';
import { healthCheckLog, streamSource, type HealthCheckLog } from '../../db/schema';
import { HttpError } from '../../middleware/errorHandler';
import { SsrfBlockedError, safeFetch } from '../../lib/ssrf';

/**
 * Manual "is this stream reachable?" check.
 *
 * Owner-agnostic on purpose: it takes a `stream_source` id and nothing else, so
 * Episodes (Phase 6) and Live Channels (Phase 7) reuse it untouched. Automated
 * or scheduled checking is explicitly out of scope — that needs a job runner
 * (Section 25).
 *
 * Phase 12 adds the history side: every check also lands in `health_check_log`,
 * trimmed to the newest {@link HISTORY_LIMIT} rows per source.
 */

const TIMEOUT_MS = 10_000;

/** How many checks are kept per source. Older rows are deleted after each insert. */
const HISTORY_LIMIT = 20;

/** Enough of the stream for an origin to answer without shipping a segment. */
const PROBE_RANGE = 'bytes=0-1023';

export interface StreamTestOutcome {
  result: StreamTestResult;
  testedAt: string;
  /**
   * Round-trip time of the probe. Null when the request never left — an SSRF
   * rejection, say — so there is nothing to have timed.
   */
  latencyMs: number | null;
  /**
   * Short, URL-free explanation for the admin UI ("HTTP 404", "timed out").
   * Safe to display and to log.
   */
  reason: string;
}

function isHealthy(status: number): boolean {
  return (status >= 200 && status < 300) || status === 206;
}

/** Turns a thrown error into a reason string that cannot contain the URL. */
function describeFailure(error: unknown): string {
  if (error instanceof SsrfBlockedError) return error.message;

  if (error instanceof Error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') {
      return `timed out after ${TIMEOUT_MS / 1000}s`;
    }
    // `error.message` from undici is shaped like "fetch failed"; the cause holds
    // the useful code (ENOTFOUND, ECONNREFUSED, ...). Neither embeds the URL.
    const cause = (error as { cause?: { code?: string } }).cause;
    if (cause?.code) return `network error (${cause.code})`;
    return 'network error';
  }

  return 'unknown error';
}

/**
 * Probes a URL without downloading it.
 *
 * HEAD first because it is free; a good number of streaming origins answer it
 * with 405 or 403, so anything unhealthy is retried as a ranged GET before the
 * source is called dead.
 */
async function probe(url: string): Promise<{ ok: boolean; reason: string }> {
  const head = await safeFetch(url, { method: 'HEAD', timeoutMs: TIMEOUT_MS });

  if (isHealthy(head.status)) return { ok: true, reason: `HTTP ${head.status}` };

  const ranged = await safeFetch(url, {
    method: 'GET',
    headers: { range: PROBE_RANGE },
    timeoutMs: TIMEOUT_MS,
  });

  // The body is never read — cancelling releases the socket immediately.
  await ranged.body?.cancel();

  return {
    ok: isHealthy(ranged.status),
    reason: `HTTP ${ranged.status}`,
  };
}

/**
 * Maps a log row to its DTO. Explicit field list, for the same reason
 * `toStreamSourceDto` uses one: a column added later has to be named here to
 * become visible.
 */
function toHealthCheckDto(row: HealthCheckLog): StreamHealthCheckDto {
  return {
    id: row.id,
    result: row.result,
    latencyMs: row.latencyMs,
    errorMessage: row.errorMessage,
    checkedAt: row.checkedAt.toISOString(),
  };
}

/**
 * Deletes everything past the newest {@link HISTORY_LIMIT} rows for one source.
 *
 * Application-level rather than a trigger: the only writer is this file, and a
 * trigger would put retention policy somewhere no one reading the service would
 * find it. `checked_at` ties are broken by id so the kept set is deterministic
 * when several checks land inside the same clock tick.
 */
async function trimHistory(streamSourceId: string): Promise<void> {
  const keep = await db
    .select({ id: healthCheckLog.id })
    .from(healthCheckLog)
    .where(eq(healthCheckLog.streamSourceId, streamSourceId))
    .orderBy(desc(healthCheckLog.checkedAt), desc(healthCheckLog.id))
    .limit(HISTORY_LIMIT);

  // Nothing to trim until the cap is actually reached.
  if (keep.length < HISTORY_LIMIT) return;

  await db.delete(healthCheckLog).where(
    and(
      eq(healthCheckLog.streamSourceId, streamSourceId),
      notInArray(
        healthCheckLog.id,
        keep.map((row) => row.id),
      ),
    ),
  );
}

/**
 * Tests one stream source and records the outcome on the row.
 *
 * Never throws for an unreachable stream — an unreachable stream is a FAILED
 * result, not a server error. Only a missing source id is an exception.
 */
export async function testSource(streamSourceId: string): Promise<StreamTestOutcome> {
  const [row] = await db
    .select({ id: streamSource.id, url: streamSource.url })
    .from(streamSource)
    .where(eq(streamSource.id, streamSourceId))
    .limit(1);

  if (!row) throw new HttpError(404, 'NOT_FOUND', 'Stream source not found');

  let result: StreamTestResult;
  let reason: string;
  let latencyMs: number | null;

  const startedAt = performance.now();

  try {
    const outcome = await probe(row.url);
    result = outcome.ok ? 'OK' : 'FAILED';
    reason = outcome.reason;
    latencyMs = Math.round(performance.now() - startedAt);
  } catch (error) {
    result = 'FAILED';
    reason = describeFailure(error);
    // A blocked URL never reaches the network, so there is no round trip to
    // report — a number here would read as "the origin answered slowly".
    latencyMs =
      error instanceof SsrfBlockedError ? null : Math.round(performance.now() - startedAt);
  }

  const testedAt = new Date();

  await db
    .update(streamSource)
    .set({ lastTestedAt: testedAt, lastTestResult: result, updatedAt: testedAt })
    .where(eq(streamSource.id, streamSourceId));

  // The row on stream_source is the current state; this is the history behind
  // it. `reason` is already URL-free — see describeFailure — so it is safe to
  // persist and to hand back to the admin UI.
  await db.insert(healthCheckLog).values({
    streamSourceId,
    result,
    latencyMs,
    errorMessage: result === 'FAILED' ? reason : null,
    checkedAt: testedAt,
  });

  await trimHistory(streamSourceId);

  // Id and outcome only. The URL must not reach any log sink.
  logger.info({ streamSourceId, result, reason, latencyMs }, 'Stream source tested');

  return { result, testedAt: testedAt.toISOString(), latencyMs, reason };
}

/**
 * The retained history for one source, newest first.
 *
 * Capped by the same limit the writer trims to, so a source whose trim was
 * interrupted still cannot return an unbounded page.
 */
export async function listHealthHistory(streamSourceId: string): Promise<StreamHealthCheckDto[]> {
  const rows = await db
    .select()
    .from(healthCheckLog)
    .where(eq(healthCheckLog.streamSourceId, streamSourceId))
    .orderBy(desc(healthCheckLog.checkedAt), desc(healthCheckLog.id))
    .limit(HISTORY_LIMIT);

  return rows.map(toHealthCheckDto);
}
