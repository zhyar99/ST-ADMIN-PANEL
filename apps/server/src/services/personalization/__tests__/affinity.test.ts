import { describe, expect, it } from 'vitest';

import {
  MAX_AFFINITY_GENRES,
  applyWatchSignal,
  completionRateWeight,
  normalizeAffinity,
  rankContentTypes,
  recencyWeight,
  signalStrength,
} from '../affinity';

/**
 * The affinity model, at its boundaries.
 *
 * Every band edge is tested from both sides, because the bands are where a
 * one-character mistake changes a viewer's recommendations without changing
 * anything a coarser test would notice.
 */

const NOW = new Date('2026-09-01T12:00:00.000Z');

function daysBefore(days: number): Date {
  return new Date(NOW.getTime() - days * 86_400_000);
}

describe('completionRateWeight', () => {
  it.each([
    [0, 0],
    [0.09, 0],
    // 0.10 is the bounce boundary: below it the viewer told us "no".
    [0.1, 0.2],
    [0.24, 0.2],
    [0.25, 0.5],
    [0.49, 0.5],
    [0.5, 0.8],
    [0.79, 0.8],
    [0.8, 1],
    [1, 1],
  ])('weighs a completion rate of %s as %s', (rate, expected) => {
    expect(completionRateWeight(rate)).toBe(expected);
  });

  it('treats a nonsensical rate as a bounce rather than throwing', () => {
    expect(completionRateWeight(Number.NaN)).toBe(0);
    expect(completionRateWeight(-1)).toBe(0);
  });
});

describe('recencyWeight', () => {
  it('is 1 for an event happening now', () => {
    expect(recencyWeight(NOW, NOW)).toBe(1);
  });

  it('halves at roughly 35 days', () => {
    expect(recencyWeight(daysBefore(34.66), NOW)).toBeCloseTo(0.5, 2);
  });

  it('leaves a 90-day-old event carrying about a sixth of its weight', () => {
    expect(recencyWeight(daysBefore(90), NOW)).toBeCloseTo(0.165, 3);
  });

  it('never exceeds 1, even for a clock running ahead', () => {
    expect(recencyWeight(new Date(NOW.getTime() + 86_400_000), NOW)).toBe(1);
  });
});

describe('signalStrength', () => {
  it('is zero for a bounce regardless of how recent it was', () => {
    expect(signalStrength({ completionRate: 0.05, startedAt: NOW, rewatch: false }, NOW)).toBe(0);
  });

  it('applies the rewatch bonus', () => {
    const once = signalStrength({ completionRate: 1, startedAt: NOW, rewatch: false }, NOW);
    const again = signalStrength({ completionRate: 1, startedAt: NOW, rewatch: true }, NOW);

    expect(once).toBe(1);
    expect(again).toBeCloseTo(1.4, 10);
  });
});

describe('applyWatchSignal', () => {
  it('moves a cold genre most of the way on a completed viewing', () => {
    const vector = applyWatchSignal({}, ['drama'], 1);
    expect(vector.drama).toBe(1);
  });

  it('approaches 1 asymptotically rather than overshooting', () => {
    // 0 + 0.5×(1−0) = 0.5, then 0.5 + 0.5×(1−0.5) = 0.75 — but normalisation
    // rescales the single-genre vector to 1.0 each time, so the invariant worth
    // asserting is the ceiling.
    let vector: Record<string, number> = {};
    for (let index = 0; index < 10; index += 1) {
      vector = applyWatchSignal(vector, ['drama'], 0.5);
    }

    expect(vector.drama).toBe(1);
    expect(Object.values(vector).every((score) => score <= 1)).toBe(true);
  });

  it('clamps at 1 even when the rewatch bonus overshoots', () => {
    expect(applyWatchSignal({ drama: 0.9 }, ['drama'], 1.4).drama).toBe(1);
  });

  it('ranks ten dramas above one comedy', () => {
    let vector: Record<string, number> = {};

    for (let index = 0; index < 10; index += 1) {
      vector = applyWatchSignal(vector, ['drama'], 1);
    }
    vector = applyWatchSignal(vector, ['comedy'], 0.2);

    expect(vector.drama).toBe(1);
    expect(vector.comedy!).toBeLessThan(vector.drama!);
  });

  it('splits one film across every genre it carries', () => {
    const vector = applyWatchSignal({}, ['drama', 'action'], 0.5);
    expect(vector.drama).toBe(vector.action);
  });

  it('leaves the vector untouched when the signal is zero', () => {
    expect(applyWatchSignal({ drama: 1 }, ['comedy'], 0)).toEqual({ drama: 1 });
  });

  it('does not mutate its input', () => {
    const before = { drama: 0.5 };
    applyWatchSignal(before, ['drama'], 1);
    expect(before).toEqual({ drama: 0.5 });
  });

  it('caps the stored vector at 50 genres, keeping the strongest', () => {
    const wide: Record<string, number> = {};
    // 60 genres, ascending strength: g00 weakest, g59 strongest.
    for (let index = 0; index < 60; index += 1) {
      wide[`g${String(index).padStart(2, '0')}`] = (index + 1) / 100;
    }

    const vector = applyWatchSignal(wide, ['g59'], 0.1);
    const kept = Object.keys(vector);

    expect(kept).toHaveLength(MAX_AFFINITY_GENRES);
    expect(kept).toContain('g59');
    expect(kept).not.toContain('g00');
  });
});

describe('normalizeAffinity', () => {
  it('rescales so the strongest genre is exactly 1', () => {
    expect(normalizeAffinity({ drama: 0.5, action: 0.25 })).toEqual({ drama: 1, action: 0.5 });
  });

  it('drops zero and negative scores', () => {
    expect(normalizeAffinity({ drama: 1, action: 0, horror: -1 })).toEqual({ drama: 1 });
  });

  it('returns an empty vector for an empty one', () => {
    expect(normalizeAffinity({})).toEqual({});
  });
});

describe('rankContentTypes', () => {
  it('orders by count and rolls episodes up to series', () => {
    expect(rankContentTypes({ MOVIE: 3, EPISODE: 5, LIVE_CHANNEL: 1 })).toEqual([
      'SERIES',
      'MOVIE',
      'LIVE_CHANNEL',
    ]);
  });

  it('omits types with no events', () => {
    expect(rankContentTypes({ MOVIE: 2, EPISODE: 0 })).toEqual(['MOVIE']);
  });
});
