import { describe, expect, it } from 'vitest';

import { extensionFor, isUploadTypeAllowed } from './policy';

describe('subtitle upload policy', () => {
  it('accepts SRT files reported with the generic binary MIME type', () => {
    expect(isUploadTypeAllowed('SUBTITLE', 'application/octet-stream', 'captions.srt')).toBe(true);
    expect(extensionFor('SUBTITLE', 'application/octet-stream', 'captions.srt')).toBe('srt');
  });

  it('preserves VTT extensions reported with the generic binary MIME type', () => {
    expect(isUploadTypeAllowed('SUBTITLE', 'application/octet-stream', 'captions.VTT')).toBe(true);
    expect(extensionFor('SUBTITLE', 'application/octet-stream', 'captions.VTT')).toBe('vtt');
  });

  it('rejects generic binary files without a subtitle extension', () => {
    expect(isUploadTypeAllowed('SUBTITLE', 'application/octet-stream', 'video.mp4')).toBe(false);
    expect(isUploadTypeAllowed('POSTER', 'application/octet-stream', 'poster.jpg')).toBe(false);
  });
});
