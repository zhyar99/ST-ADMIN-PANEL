import { describe, expect, it } from 'vitest';

import { getLocalized, LocalizedText, PartialLocalizedText, SUPPORTED_LOCALES } from './i18n.js';

describe('LocalizedText', () => {
  it('accepts all three supported languages', () => {
    const parsed = LocalizedText.parse({ en: 'A', ckb: 'B', ar: 'C' });
    expect(parsed).toEqual({ en: 'A', ckb: 'B', ar: 'C' });
  });

  it('rejects unknown language keys', () => {
    expect(() => LocalizedText.parse({ en: 'A', ckb: 'B', ar: 'C', fr: 'D' })).toThrow();
  });

  it('rejects objects missing a required language', () => {
    expect(() => LocalizedText.parse({ en: 'A', ckb: 'B' })).toThrow();
    expect(() => LocalizedText.parse({ ckb: 'B', ar: 'C' })).toThrow();
  });

  it('rejects non-string values', () => {
    expect(() => LocalizedText.parse({ en: 1, ckb: 'B', ar: 'C' })).toThrow();
  });

  it('exposes exactly the three supported locales', () => {
    expect(SUPPORTED_LOCALES).toEqual(['en', 'ckb', 'ar']);
  });
});

describe('PartialLocalizedText', () => {
  it('accepts a subset of languages', () => {
    expect(PartialLocalizedText.parse({ ckb: 'B' })).toEqual({ ckb: 'B' });
    expect(PartialLocalizedText.parse({})).toEqual({});
  });

  it('still rejects unknown keys', () => {
    expect(() => PartialLocalizedText.parse({ fr: 'D' })).toThrow();
  });
});

describe('getLocalized', () => {
  const text = { en: 'Hello', ckb: 'سڵاو', ar: 'مرحبا' };

  it('returns the requested language', () => {
    expect(getLocalized(text, 'ckb')).toBe('سڵاو');
    expect(getLocalized(text, 'ar')).toBe('مرحبا');
    expect(getLocalized(text, 'en')).toBe('Hello');
  });

  it('falls back to English for an unknown or empty language', () => {
    expect(getLocalized(text, 'fr')).toBe('Hello');
    expect(getLocalized({ en: 'Hello', ckb: '   ', ar: 'مرحبا' }, 'ckb')).toBe('Hello');
  });

  it('falls back to the first non-empty locale when English is missing', () => {
    expect(getLocalized({ en: '', ckb: 'سڵاو', ar: '' }, 'ar')).toBe('سڵاو');
  });

  it('returns the fallback instead of throwing on empty or missing input', () => {
    expect(getLocalized(undefined, 'en')).toBe('');
    expect(getLocalized(null, 'en', 'n/a')).toBe('n/a');
    expect(getLocalized({}, 'en', 'n/a')).toBe('n/a');
    expect(getLocalized({ en: '', ckb: '', ar: '' }, 'en', 'n/a')).toBe('n/a');
  });
});
