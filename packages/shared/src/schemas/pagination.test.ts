import { describe, expect, it } from 'vitest';

import { CursorPaginationQuery, OffsetPaginationQuery } from './pagination.js';

describe('CursorPaginationQuery', () => {
  it('defaults limit to 20 and leaves cursor unset', () => {
    expect(CursorPaginationQuery.parse({})).toEqual({ limit: 20 });
  });

  it('coerces a query-string limit to a number', () => {
    expect(CursorPaginationQuery.parse({ limit: '50', cursor: 'abc' })).toEqual({
      limit: 50,
      cursor: 'abc',
    });
  });

  it('rejects a limit outside 1..100', () => {
    expect(() => CursorPaginationQuery.parse({ limit: '0' })).toThrow();
    expect(() => CursorPaginationQuery.parse({ limit: '101' })).toThrow();
  });
});

describe('OffsetPaginationQuery', () => {
  it('defaults to page 1, limit 20', () => {
    expect(OffsetPaginationQuery.parse({})).toEqual({ page: 1, limit: 20 });
  });

  it('rejects page 0', () => {
    expect(() => OffsetPaginationQuery.parse({ page: '0' })).toThrow();
  });
});
