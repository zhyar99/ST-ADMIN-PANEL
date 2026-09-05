import { describe, expect, it } from 'vitest';

import { omitStreamUrl, omitStreamUrls } from './dtoHelpers.js';

describe('omitStreamUrl', () => {
  it('removes the url field', () => {
    const result = omitStreamUrl({ id: '1', url: 'secret', title: 'Test' });
    expect(result).toEqual({ id: '1', title: 'Test' });
    expect('url' in result).toBe(false);
  });

  it('does not mutate the input', () => {
    const input = { id: '1', url: 'secret', title: 'Test' };
    omitStreamUrl(input);
    expect(input.url).toBe('secret');
  });

  it('is a no-op for rows that have no url', () => {
    const row: { id: string; title: string; url?: string } = { id: '1', title: 'Test' };
    expect(omitStreamUrl(row)).toEqual({ id: '1', title: 'Test' });
  });

  it('strips a url even when it is null or undefined', () => {
    expect('url' in omitStreamUrl({ id: '1', url: null })).toBe(false);
    expect('url' in omitStreamUrl({ id: '1', url: undefined })).toBe(false);
  });
});

describe('omitStreamUrls', () => {
  it('strips the url from every row', () => {
    const rows = [
      { id: '1', url: 'secret-1', title: 'A' },
      { id: '2', url: 'secret-2', title: 'B' },
    ];
    expect(omitStreamUrls(rows)).toEqual([
      { id: '1', title: 'A' },
      { id: '2', title: 'B' },
    ]);
    expect(rows[0]?.url).toBe('secret-1');
  });

  it('returns an empty array unchanged', () => {
    expect(omitStreamUrls([])).toEqual([]);
  });
});
