import { and, asc, eq } from 'drizzle-orm';

import type {
  AdPolicyDTO,
  PlaybackContentType,
  PlaybackSessionResponse,
  StreamSourceKind,
  StreamSourceOwnerType,
} from '@streaming/shared' with { 'resolution-mode': 'import' };

import { db } from '../../db/client';
import { episode, liveChannel, movie, streamSource } from '../../db/schema';
import { logger } from '../../logger';
import { HttpError } from '../../middleware/errorHandler';
import { getAdConfig } from '../../repositories/adConfigRepository';
import { getOneActiveCreative } from '../../repositories/adCreativeRepository';
import { subtitleTracksForOne } from './consumerShared';

/**
 * Playback session issuance.
 *
 * This is the only code path in the system that returns `stream_source.url` to
 * an unauthenticated caller, and the whole consumer API is arranged so that it
 * stays that way. Two consequences run through the file:
 *
 *  - The URL is never logged. Not at debug, not in an error, not in an audit
 *    entry. Pino's redaction list covers headers, not values a handler chooses
 *    to log, so the only reliable rule is that the string is read out of the
 *    row and put straight into the response body.
 *  - Publication is checked before sources are even queried, so an unpublished
 *    id cannot be used to probe whether a stream exists.
 */

/**
 * The public contract's vocabulary, mapped to the `stream_source` pg enum.
 *
 * `as const satisfies` rather than a plain `Record` annotation: it type-checks
 * the map against both vocabularies while keeping the literal value types, so
 * narrowing `contentType` to the VOD pair also narrows the owner type to
 * `'MOVIE' | 'EPISODE'` and the subtitle lookup below needs no cast.
 */
const OWNER_TYPE_FOR = {
  movie: 'MOVIE',
  episode: 'EPISODE',
  live_channel: 'LIVE_CHANNEL',
} as const satisfies Record<PlaybackContentType, StreamSourceOwnerType>;

/**
 * Confirms the content exists and is published, or 404s.
 *
 * Spelled out per table rather than indexing a lookup map: the three tables are
 * distinct Drizzle types, and the union that a map produces type-checks only by
 * accident of their columns currently matching.
 */
async function requirePublished(
  contentType: PlaybackContentType,
  contentId: string,
): Promise<void> {
  const found = await (async () => {
    switch (contentType) {
      case 'movie':
        return db
          .select({ id: movie.id })
          .from(movie)
          .where(and(eq(movie.id, contentId), eq(movie.status, 'PUBLISHED')))
          .limit(1);
      case 'episode':
        return db
          .select({ id: episode.id })
          .from(episode)
          .where(and(eq(episode.id, contentId), eq(episode.status, 'PUBLISHED')))
          .limit(1);
      case 'live_channel':
        return db
          .select({ id: liveChannel.id })
          .from(liveChannel)
          .where(and(eq(liveChannel.id, contentId), eq(liveChannel.status, 'PUBLISHED')))
          .limit(1);
    }
  })();

  if (found.length === 0) throw new HttpError(404, 'NOT_FOUND', 'Content not found');
}

/**
 * Picks which source the player gets.
 *
 * Sources are ordered by `priority` ascending, 0 being the primary. The first
 * one not known to be broken wins; a source that has never been tested
 * (`last_test_result IS NULL`) counts as usable, because "untested" is not
 * "failing" and refusing it would make a freshly added backup useless.
 *
 * If every source has failed its last test, the primary is handed back anyway.
 * A stale FAILED verdict is a guess about the past — the stream may well be
 * back — whereas returning nothing is a guaranteed black screen. Better to let
 * the player try and fail than to fail on its behalf.
 */
function selectSource<
  T extends { url: string; kind: StreamSourceKind; lastTestResult: 'OK' | 'FAILED' | null },
>(sources: T[]): T | undefined {
  return sources.find((source) => source.lastTestResult !== 'FAILED') ?? sources[0];
}

/**
 * Ad policy for a VOD session.
 *
 * Fixed-rule: the timing comes from the single `ad_config` row and the creative
 * is one row picked at random from the active pool. Nothing about the request
 * influences either — there is no viewer identity in this phase, so every
 * requester gets the same policy, and that is a product decision rather than a
 * gap to be filled in by inference.
 *
 * Failures degrade to `null` instead of propagating. An ad break is optional;
 * playback is not, and a viewer who cannot be shown an advert should still be
 * shown their film. The config read creates the row on first call, so a fresh
 * database serves defaults rather than nothing.
 *
 * The creative URL is a public `/storage/ad-creatives/...` path. It is the only
 * URL this file emits besides the stream source, and unlike that one it is not
 * sensitive — it is a file the player is about to fetch anyway.
 */
async function loadAdPolicy(): Promise<AdPolicyDTO | null> {
  try {
    const [config, creative] = await Promise.all([getAdConfig(), getOneActiveCreative()]);

    return {
      preRoll: {
        minSeconds: config.preRollMinSeconds,
        maxSeconds: config.preRollMaxSeconds,
        // Fixed rule, not a stored column: a pre-roll always runs to
        // completion, and only a mid-roll becomes skippable.
        skippable: false,
      },
      midRoll: {
        intervalMinutes: config.midRollIntervalMinutes,
        maxSeconds: config.midRollMaxSeconds,
        skipAfterSeconds: config.skipAfterSeconds,
      },
      // Null when every creative is deactivated. The timing above still
      // stands — the client has simply been given nothing to fill the break
      // with, which is not the same as advertising being switched off.
      creative,
    };
  } catch (error) {
    // Never fatal: failing to describe the ad break must not cost the viewer
    // the thing they actually asked for.
    logger.warn({ err: error }, 'Could not resolve an ad policy — serving null');
    return null;
  }
}

export interface PlaybackSessionParams {
  contentType: PlaybackContentType;
  contentId: string;
}

export async function createPlaybackSession(
  params: PlaybackSessionParams,
): Promise<PlaybackSessionResponse> {
  const { contentType, contentId } = params;

  await requirePublished(contentType, contentId);

  const sources = await db
    .select({
      url: streamSource.url,
      kind: streamSource.kind,
      lastTestResult: streamSource.lastTestResult,
    })
    .from(streamSource)
    .where(
      and(
        eq(streamSource.ownerType, OWNER_TYPE_FOR[contentType]),
        eq(streamSource.ownerId, contentId),
      ),
    )
    .orderBy(asc(streamSource.priority), asc(streamSource.createdAt));

  const selected = selectSource(sources);

  if (!selected) {
    // Publishing requires at least one source, so this means an operator
    // deleted the last one after publishing. The message says nothing about
    // sources — it is the same 404 an unpublished id gets.
    throw new HttpError(404, 'NOT_FOUND', 'Content not found');
  }

  // A live channel has neither subtitle tracks (the feed carries its own
  // captions if any) nor ad breaks, so both keys are absent rather than empty.
  if (contentType === 'live_channel') {
    return { sourceUrl: selected.url, sourceKind: selected.kind };
  }

  const [subtitleTracks, adPolicy] = await Promise.all([
    subtitleTracksForOne(OWNER_TYPE_FOR[contentType], contentId),
    loadAdPolicy(),
  ]);

  // `sourceKind` tells the player which of the two it has been handed: a media
  // URL for its video element, or a third-party player page for an iframe.
  // Nothing about it can be derived from the URL, and the URL is the one thing
  // the player must not have to parse.
  return { sourceUrl: selected.url, sourceKind: selected.kind, subtitleTracks, adPolicy };
}
