import { describe, expect, it } from 'vitest';

import { fail, ok } from './envelope.js';

describe('ok', () => {
  it('wraps data in a success envelope', () => {
    expect(ok({ id: '1' })).toEqual({ success: true, data: { id: '1' } });
  });
});

describe('fail', () => {
  it('wraps code and message in an error envelope', () => {
    expect(fail('NOT_FOUND', 'Movie not found')).toEqual({
      success: false,
      error: { code: 'NOT_FOUND', message: 'Movie not found' },
    });
  });

  it('omits details entirely when none are given', () => {
    expect('details' in fail('NOT_FOUND', 'Movie not found').error).toBe(false);
  });

  it('includes details when given', () => {
    expect(fail('VALIDATION_ERROR', 'Invalid body', { field: 'title' }).error.details).toEqual({
      field: 'title',
    });
  });
});
