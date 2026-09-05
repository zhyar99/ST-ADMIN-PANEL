import { describe, expect, it } from 'vitest';

import { localizeField, localizeOptionalField, pickLocale } from './i18n';

/**
 * These also pin the contract between this file and `getLocalized` in
 * @streaming/shared, which it mirrors rather than imports — see the note at the
 * top of i18n.ts.
 */

describe('pickLocale', () => {
  it('picks the highest-quality supported tag', () => {
    expect(pickLocale('ckb,ar;q=0.9')).toBe('ckb');
    expect(pickLocale('ckb,ar;q=0.9,en;q=0.8')).toBe('ckb');
  });

  it('honours quality order over header order', () => {
    expect(pickLocale('en;q=0.2,ar;q=0.9')).toBe('ar');
  });

  it('skips tags it does not speak', () => {
    expect(pickLocale('fr,de;q=0.9,ar;q=0.5')).toBe('ar');
  });

  it('falls back to en for an unsupported header', () => {
    expect(pickLocale('fr')).toBe('en');
  });

  it('falls back to en when the header is missing', () => {
    expect(pickLocale(undefined)).toBe('en');
    expect(pickLocale(null)).toBe('en');
    expect(pickLocale('')).toBe('en');
  });

  it('does not match region subtags', () => {
    // There is one Sorani translation, not one per country — accepting ckb-IQ
    // would imply a granularity the catalogue does not have.
    expect(pickLocale('ckb-IQ')).toBe('en');
  });

  it('is case-insensitive', () => {
    expect(pickLocale('CKB')).toBe('ckb');
  });

  it('treats q=0 as a refusal', () => {
    expect(pickLocale('ar;q=0,ckb;q=0.5')).toBe('ckb');
  });

  it('survives a malformed header instead of throwing', () => {
    expect(pickLocale(';;;')).toBe('en');
    expect(pickLocale('*')).toBe('en');
  });

  it('keeps a valid tag whose weight is unparseable', () => {
    // The typo is in the weight, not the language. Discarding a preference the
    // client stated clearly, because it fumbled the parameter attached to it,
    // would be the wrong trade — the tag falls back to the default weight of 1.
    expect(pickLocale('ar;q=banana')).toBe('ar');
  });
});

describe('localizeField', () => {
  const full = { en: 'Title', ckb: 'ناونیشان', ar: 'عنوان' };

  it('returns the requested language', () => {
    expect(localizeField(full, 'ckb')).toBe('ناونیشان');
    expect(localizeField(full, 'ar')).toBe('عنوان');
  });

  it('falls back to English when the requested language is blank', () => {
    expect(localizeField({ en: 'Title', ckb: '   ', ar: 'عنوان' }, 'ckb')).toBe('Title');
  });

  it('falls back to any non-empty locale when English is blank too', () => {
    expect(localizeField({ en: '', ckb: '', ar: 'عنوان' }, 'ckb')).toBe('عنوان');
  });

  it('returns the fallback for a null or empty value', () => {
    expect(localizeField(null, 'en')).toBe('');
    expect(localizeField(undefined, 'en', 'n/a')).toBe('n/a');
    expect(localizeField({ en: '', ckb: '', ar: '' }, 'en')).toBe('');
  });
});

describe('localizeOptionalField', () => {
  it('maps absent copy to null rather than an empty string', () => {
    expect(localizeOptionalField(null, 'en')).toBeNull();
    expect(localizeOptionalField({ en: '', ckb: '', ar: '' }, 'en')).toBeNull();
    expect(localizeOptionalField({ en: 'Tagline' }, 'ar')).toBe('Tagline');
  });
});
