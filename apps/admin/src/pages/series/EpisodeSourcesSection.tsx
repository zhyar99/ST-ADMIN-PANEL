import { useMemo } from 'react';

import {
  addEpisodeSource,
  deleteEpisodeSource,
  getEpisodeSourceUrl,
  listEpisodeSources,
  reorderEpisodeSources,
  testEpisodeSource,
  type EpisodeRef,
} from '../../lib/seriesApi';
import StreamSourceManager, { type StreamSourceApi } from '../../components/StreamSourceManager';

/**
 * Stream sources for one episode.
 *
 * The episode-side binding of `StreamSourceManager`, and — as with the movies
 * page — nothing more than a binding. Phase 12 replaced the hand-written copy
 * this file used to hold.
 */
export default function EpisodeSourcesSection({ episode }: { episode: EpisodeRef }) {
  const { seriesId, seasonId, episodeId } = episode;

  // Keyed on the three ids rather than on `episode`: callers pass an object
  // literal, so depending on its identity would rebuild the adapter on every
  // render of the edit page.
  const sourceApi = useMemo<StreamSourceApi>(() => {
    const ref: EpisodeRef = { seriesId, seasonId, episodeId };

    return {
      list: () => listEpisodeSources(ref),
      add: (input) => addEpisodeSource(ref, input),
      remove: (sourceId) => deleteEpisodeSource(ref, sourceId),
      reorder: (orderedIds) => reorderEpisodeSources(ref, orderedIds),
      test: (sourceId) => testEpisodeSource(ref, sourceId),
      revealUrl: (sourceId) => getEpisodeSourceUrl(ref, sourceId),
    };
  }, [seriesId, seasonId, episodeId]);

  // Same two kinds as a film — an episode is just as likely to be linked
  // through a third-party player page as hosted as a file.
  return (
    <StreamSourceManager
      queryKey={['admin', 'episodes', episodeId, 'sources']}
      api={sourceApi}
      allowEmbed
    />
  );
}
