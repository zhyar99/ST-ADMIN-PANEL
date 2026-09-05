import { describe, expect, it } from 'vitest';

import {
  LiveChannelCreateInput,
  LiveChannelUpdateInput,
  MovieCreateInput,
  MovieUpdateInput,
  RemoteUrl,
  RequiredLocalizedText,
  StreamSourceReorderInput,
  SubtitleTrackCreateInput,
} from './catalog.js';

/**
 * These schemas are mirrored by `apps/server/src/schemas/catalogSchemas.ts`,
 * which cannot import them: the server compiles to CommonJS and this package is
 * ESM. This file pins the rules both copies have to agree on, so a change made
 * to one and not the other shows up as a failure rather than as a form that
 * accepts something the API then rejects.
 */

describe('RequiredLocalizedText', () => {
  it('accepts complete copy in all three languages', () => {
    expect(RequiredLocalizedText.parse({ en: 'A', ckb: 'B', ar: 'C' })).toEqual({
      en: 'A',
      ckb: 'B',
      ar: 'C',
    });
  });

  it('rejects a missing language', () => {
    expect(() => RequiredLocalizedText.parse({ en: 'A', ckb: 'B' })).toThrow();
  });

  it('rejects a whitespace-only translation', () => {
    expect(() => RequiredLocalizedText.parse({ en: 'A', ckb: '   ', ar: 'C' })).toThrow();
  });

  it('rejects an unknown language key', () => {
    expect(() => RequiredLocalizedText.parse({ en: 'A', ckb: 'B', ar: 'C', fr: 'D' })).toThrow();
  });
});

describe('RemoteUrl', () => {
  it('accepts http and https', () => {
    expect(RemoteUrl.parse('https://cdn.example.com/master.m3u8')).toBe(
      'https://cdn.example.com/master.m3u8',
    );
    expect(RemoteUrl.parse('http://cdn.example.com/master.m3u8')).toBe(
      'http://cdn.example.com/master.m3u8',
    );
  });

  it('rejects other schemes', () => {
    for (const value of ['file:///etc/passwd', 'ftp://example.com/a', 'javascript:alert(1)']) {
      expect(() => RemoteUrl.parse(value), value).toThrow();
    }
  });

  // Regression: the refinement runs even after `.url()` marks the value dirty,
  // so an unparseable string must fail validation rather than throw a TypeError.
  it('reports a malformed URL as a validation failure, not a crash', () => {
    const result = RemoteUrl.safeParse('not-a-url');
    expect(result.success).toBe(false);
  });

  it('rejects an empty string', () => {
    expect(RemoteUrl.safeParse('').success).toBe(false);
  });
});

describe('MovieCreateInput', () => {
  const valid = {
    title_i18n: { en: 'Title', ckb: 'Sernav', ar: 'عنوان' },
    overview_i18n: { en: 'Overview', ckb: 'Kurte', ar: 'ملخص' },
  };

  it('accepts the minimum required fields', () => {
    expect(MovieCreateInput.parse(valid)).toMatchObject(valid);
  });

  it('requires both title and overview', () => {
    expect(MovieCreateInput.safeParse({ title_i18n: valid.title_i18n }).success).toBe(false);
    expect(MovieCreateInput.safeParse({ overview_i18n: valid.overview_i18n }).success).toBe(false);
  });

  it('bounds the release year to 1888–2100', () => {
    expect(MovieCreateInput.safeParse({ ...valid, release_year: 1887 }).success).toBe(false);
    expect(MovieCreateInput.safeParse({ ...valid, release_year: 2101 }).success).toBe(false);
    expect(MovieCreateInput.safeParse({ ...valid, release_year: 1888 }).success).toBe(true);
    expect(MovieCreateInput.safeParse({ ...valid, release_year: 2100 }).success).toBe(true);
  });

  it('requires a positive runtime', () => {
    expect(MovieCreateInput.safeParse({ ...valid, runtime_minutes: 0 }).success).toBe(false);
    expect(MovieCreateInput.safeParse({ ...valid, runtime_minutes: -5 }).success).toBe(false);
  });

  it('requires artwork ids to be uuids', () => {
    expect(MovieCreateInput.safeParse({ ...valid, poster_asset_id: 'nope' }).success).toBe(false);
  });

  // Regression: an untouched tagline field group submits three empty strings,
  // which must count as "no tagline" rather than as three missing translations.
  it('treats an all-blank tagline as absent', () => {
    const result = MovieCreateInput.safeParse({
      ...valid,
      tagline_i18n: { en: '', ckb: '', ar: '' },
    });

    expect(result.success).toBe(true);
    expect(result.success && result.data.tagline_i18n).toBeNull();
  });

  it('still rejects a tagline filled in only one language', () => {
    expect(
      MovieCreateInput.safeParse({
        ...valid,
        tagline_i18n: { en: 'Only English', ckb: '', ar: '' },
      }).success,
    ).toBe(false);
  });

  it('accepts a tagline complete in all three languages', () => {
    expect(
      MovieCreateInput.safeParse({
        ...valid,
        tagline_i18n: { en: 'A', ckb: 'B', ar: 'C' },
      }).success,
    ).toBe(true);
  });
});

describe('MovieUpdateInput', () => {
  it('accepts a single field', () => {
    expect(MovieUpdateInput.safeParse({ runtime_minutes: 120 }).success).toBe(true);
  });

  it('rejects an empty body', () => {
    expect(MovieUpdateInput.safeParse({}).success).toBe(false);
  });
});

describe('SubtitleTrackCreateInput', () => {
  const assetId = '11111111-1111-4111-8111-111111111111';

  it('accepts exactly one source', () => {
    expect(SubtitleTrackCreateInput.safeParse({ language: 'en', asset_id: assetId }).success).toBe(
      true,
    );
    expect(
      SubtitleTrackCreateInput.safeParse({
        language: 'ar',
        external_url: 'https://example.com/ar.vtt',
      }).success,
    ).toBe(true);
  });

  it('rejects both sources at once', () => {
    expect(
      SubtitleTrackCreateInput.safeParse({
        language: 'en',
        asset_id: assetId,
        external_url: 'https://example.com/en.vtt',
      }).success,
    ).toBe(false);
  });

  it('rejects neither source', () => {
    expect(SubtitleTrackCreateInput.safeParse({ language: 'en' }).success).toBe(false);
  });

  it('rejects an unsupported language', () => {
    expect(
      SubtitleTrackCreateInput.safeParse({ language: 'fr', asset_id: assetId }).success,
    ).toBe(false);
  });
});

describe('LiveChannelCreateInput', () => {
  const valid = {
    name_i18n: { en: 'News 24', ckb: 'هەواڵ ٢٤', ar: 'أخبار ٢٤' },
    category: 'News',
  };

  it('accepts a name in all three languages with a category', () => {
    const parsed = LiveChannelCreateInput.parse(valid);
    expect(parsed.category).toBe('News');
    expect(parsed.name_i18n.ckb).toBe('هەواڵ ٢٤');
  });

  it('rejects a name missing a language', () => {
    expect(
      LiveChannelCreateInput.safeParse({ ...valid, name_i18n: { en: 'A', ckb: 'B' } }).success,
    ).toBe(false);
  });

  it('rejects an unknown language key', () => {
    expect(
      LiveChannelCreateInput.safeParse({
        ...valid,
        name_i18n: { en: 'A', ckb: 'B', ar: 'C', fr: 'D' },
      }).success,
    ).toBe(false);
  });

  it('requires a category', () => {
    expect(LiveChannelCreateInput.safeParse({ ...valid, category: '' }).success).toBe(false);
    expect(LiveChannelCreateInput.safeParse({ ...valid, category: '   ' }).success).toBe(false);
    expect(LiveChannelCreateInput.safeParse({ name_i18n: valid.name_i18n }).success).toBe(false);
  });

  it('trims the category', () => {
    expect(LiveChannelCreateInput.parse({ ...valid, category: '  Sport  ' }).category).toBe('Sport');
  });

  it('rejects an over-long category', () => {
    expect(LiveChannelCreateInput.safeParse({ ...valid, category: 'x'.repeat(65) }).success).toBe(
      false,
    );
  });

  it('accepts a null logo and rejects a non-uuid one', () => {
    expect(LiveChannelCreateInput.safeParse({ ...valid, logo_asset_id: null }).success).toBe(true);
    expect(LiveChannelCreateInput.safeParse({ ...valid, logo_asset_id: 'nope' }).success).toBe(
      false,
    );
  });

  // Publication is Phase 8. A client that sends `status` must not be able to
  // create a channel that is already live.
  it('ignores a status field rather than honouring it', () => {
    const parsed = LiveChannelCreateInput.parse({ ...valid, status: 'PUBLISHED' });
    expect(parsed).not.toHaveProperty('status');
  });
});

describe('LiveChannelUpdateInput', () => {
  it('accepts a single field', () => {
    expect(LiveChannelUpdateInput.safeParse({ category: 'Sport' }).success).toBe(true);
  });

  it('rejects an empty patch', () => {
    expect(LiveChannelUpdateInput.safeParse({}).success).toBe(false);
  });

  it('still validates the fields it is given', () => {
    expect(LiveChannelUpdateInput.safeParse({ category: '  ' }).success).toBe(false);
    expect(
      LiveChannelUpdateInput.safeParse({ name_i18n: { en: 'A', ckb: 'B' } }).success,
    ).toBe(false);
  });
});

describe('StreamSourceReorderInput', () => {
  it('requires at least one id', () => {
    expect(StreamSourceReorderInput.safeParse({ orderedIds: [] }).success).toBe(false);
  });

  it('requires every id to be a uuid', () => {
    expect(StreamSourceReorderInput.safeParse({ orderedIds: ['nope'] }).success).toBe(false);
  });
});
