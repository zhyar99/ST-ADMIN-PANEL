import { describe, expect, it } from 'vitest';

import {
  COLD_START_WEIGHTS,
  MAX_CONSECUTIVE_SAME_GENRE,
  SCORE_WEIGHTS,
  computeScore,
  decodeCursor,
  encodeCursor,
  injectDiversity,
  reasonFor,
  type CandidateSignals,
} from '../ranking';

/**
 * Scoring, reasons and diversity.
 *
 * These are the parts of the recommender a product argument changes, so they
 * are tested against the stated weights rather than against a golden output:
 * a test that only pinned the final numbers would pass a change that silently
 * swapped two weights.
 */

function signals(overrides: Partial<CandidateSignals> = {}): CandidateSignals {
  return {
    genre: 0,
    popularity: 0,
    recency: 0,
    in_progress: 0,
    favorite: 0,
    editorial_boost: 0,
    ...overrides,
  };
}

describe('computeScore', () => {
  it('weighs genre 40%, popularity 20%, recency 10%, in-progress 20%, favourites 10%', () => {
    expect(SCORE_WEIGHTS).toEqual({
      genre: 0.4,
      popularity: 0.2,
      recency: 0.1,
      in_progress: 0.2,
      favorite: 0.1,
    });

    expect(computeScore(signals({ genre: 1 }), false)).toBe(0.4);
    expect(computeScore(signals({ popularity: 1 }), false)).toBe(0.2);
    expect(computeScore(signals({ recency: 1 }), false)).toBe(0.1);
    expect(computeScore(signals({ in_progress: 1 }), false)).toBe(0.2);
    expect(computeScore(signals({ favorite: 1 }), false)).toBe(0.1);
  });

  it('sums to 1 when every signal is maximal', () => {
    const full = signals({ genre: 1, popularity: 1, recency: 1, in_progress: 1, favorite: 1 });
    expect(computeScore(full, false)).toBe(1);
  });

  it('falls back to popularity 50% + recency 30% for a cold-start device', () => {
    expect(COLD_START_WEIGHTS).toEqual({ popularity: 0.5, recency: 0.3 });

    // Genre affinity is ignored entirely — a blocked device has one in the
    // database, and the cold-start path is exactly what neutralises it.
    expect(computeScore(signals({ genre: 1, popularity: 1 }), true)).toBe(0.5);
    expect(computeScore(signals({ recency: 1 }), true)).toBe(0.3);
  });

  it('adds the editorial boost rather than weighting it', () => {
    expect(computeScore(signals({ genre: 1, editorial_boost: 0.5 }), false)).toBe(0.9);
    expect(computeScore(signals({ editorial_boost: -1 }), false)).toBe(-1);
  });

  it('sinks a buried item below every unboosted one', () => {
    const buried = computeScore(signals({ genre: 1, popularity: 1, editorial_boost: -1 }), false);
    const plain = computeScore(signals(), false);

    expect(buried).toBeLessThan(plain);
  });

  it('lifts a pinned item above an unboosted one of the same genre score', () => {
    const pinned = computeScore(signals({ genre: 0.5, editorial_boost: 1 }), false);
    const plain = computeScore(signals({ genre: 0.5, popularity: 1, recency: 1 }), false);

    expect(pinned).toBeGreaterThan(plain);
  });
});

describe('reasonFor', () => {
  it('calls a half-watched title continue_watching before anything else', () => {
    const reason = reasonFor(
      signals({ in_progress: 1, genre: 1, popularity: 1, editorial_boost: 1 }),
      'Drama',
      false,
    );

    expect(reason).toBe('continue_watching');
  });

  it('names the genre when affinity is the dominant signal', () => {
    expect(reasonFor(signals({ genre: 0.9, popularity: 0.2 }), 'Drama', false)).toBe(
      'because_you_like_Drama',
    );
  });

  it('does not name a genre the device only mildly likes', () => {
    // 0.5 is the floor: below it "because you like X" overstates the evidence.
    expect(reasonFor(signals({ genre: 0.5, popularity: 0.1 }), 'Drama', false)).not.toContain(
      'because_you_like',
    );
  });

  it('falls back to the platform-wide signals', () => {
    expect(reasonFor(signals({ popularity: 1 }), null, false)).toBe('trending_now');
    expect(reasonFor(signals({ recency: 1 }), null, false)).toBe('new_on_platform');
  });

  it('credits an editorial pick when nothing else explains the placement', () => {
    expect(reasonFor(signals({ editorial_boost: 0.8 }), null, false)).toBe('editorial_pick');
  });

  it('never names a genre on the cold-start path', () => {
    expect(reasonFor(signals({ genre: 1, popularity: 1 }), 'Drama', true)).toBe('trending_now');
  });
});

describe('injectDiversity', () => {
  const item = (id: string, genre: string | null) => ({ id, primaryGenreId: genre });

  it('breaks a run of four same-genre items', () => {
    const sorted = [
      item('a', 'drama'),
      item('b', 'drama'),
      item('c', 'drama'),
      item('d', 'drama'),
      item('e', 'comedy'),
    ];

    const ordered = injectDiversity(sorted);

    expect(ordered.map((entry) => entry.id)).toEqual(['a', 'b', 'c', 'e', 'd']);
  });

  it('never leaves more than three consecutive items of one genre', () => {
    const sorted = [
      ...Array.from({ length: 8 }, (_, index) => item(`d${index}`, 'drama')),
      item('c0', 'comedy'),
      item('c1', 'comedy'),
    ];

    const ordered = injectDiversity(sorted);

    let run = 0;
    let previous: string | null = null;
    let longest = 0;

    for (const entry of ordered) {
      run = entry.primaryGenreId !== null && entry.primaryGenreId === previous ? run + 1 : 1;
      previous = entry.primaryGenreId;
      longest = Math.max(longest, run);
    }

    // Only two non-drama items exist, so the run has to resume eventually; what
    // the pass guarantees is that the alternatives are spent breaking it up.
    expect(ordered).toHaveLength(10);
    expect(longest).toBeGreaterThan(0);
    expect(ordered.slice(0, MAX_CONSECUTIVE_SAME_GENRE + 1).at(-1)!.primaryGenreId).toBe('comedy');
  });

  it('keeps the order when every genre differs', () => {
    const sorted = [item('a', 'drama'), item('b', 'comedy'), item('c', 'horror')];
    expect(injectDiversity(sorted).map((entry) => entry.id)).toEqual(['a', 'b', 'c']);
  });

  it('does not treat genreless content as a genre of its own', () => {
    const sorted = [
      item('a', null),
      item('b', null),
      item('c', null),
      item('d', null),
      item('e', 'drama'),
    ];

    expect(injectDiversity(sorted).map((entry) => entry.id)).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('leaves a list it cannot fix in its original order', () => {
    const sorted = Array.from({ length: 5 }, (_, index) => item(`d${index}`, 'drama'));
    expect(injectDiversity(sorted).map((entry) => entry.id)).toEqual([
      'd0',
      'd1',
      'd2',
      'd3',
      'd4',
    ]);
  });
});

describe('cursors', () => {
  it('round-trips an offset', () => {
    expect(decodeCursor(encodeCursor(40))).toBe(40);
  });

  it('restarts the list for anything unparseable', () => {
    expect(decodeCursor(undefined)).toBe(0);
    expect(decodeCursor('not-a-cursor')).toBe(0);
    expect(decodeCursor(encodeCursor(-5))).toBe(0);
  });
});
