import { useMemo } from 'react';

import {
  addSource,
  deleteSource,
  getSourceUrl,
  listSources,
  reorderSources,
  testSource,
} from '../../lib/catalogApi';
import StreamSourceManager, { type StreamSourceApi } from '../../components/StreamSourceManager';

/**
 * Stream sources for one movie.
 *
 * The list, the health pill, the test button and the history popover all live
 * in `StreamSourceManager` — this file only binds them to the movie endpoints.
 * It used to be a hand-written copy of that component (Phase 5, before the
 * shared one existed); Phase 12 folded it back in so Movies, Episodes and Live
 * Channels cannot drift apart again.
 */
export default function StreamSourcesSection({ movieId }: { movieId: string }) {
  // Rebuilt only when the movie id changes — a new object identity on every
  // render would reset the source list's mutation state mid-interaction.
  const sourceApi = useMemo<StreamSourceApi>(
    () => ({
      list: () => listSources(movieId),
      add: (url) => addSource(movieId, { url }),
      remove: (sourceId) => deleteSource(movieId, sourceId),
      reorder: (orderedIds) => reorderSources(movieId, orderedIds),
      test: (sourceId) => testSource(movieId, sourceId),
      revealUrl: (sourceId) => getSourceUrl(movieId, sourceId),
    }),
    [movieId],
  );

  return <StreamSourceManager queryKey={['admin', 'movies', movieId, 'sources']} api={sourceApi} />;
}
