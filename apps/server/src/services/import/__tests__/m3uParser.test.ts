import { describe, expect, it, vi } from 'vitest';

import { parseM3U } from '../m3uParser';

/**
 * The parser is the only part of this phase with no database and no HTTP, and
 * it is where every malformed provider file lands first — so it gets the
 * closest tests. Each case below is a shape that has actually turned up in a
 * real playlist: CRLF from a Windows export, multicast addresses mixed in with
 * HTTP ones, a header-less fragment, single-quoted attributes.
 */

const STANDARD = [
  '#EXTM3U',
  '#EXTINF:-1 tvg-id="bbc1.uk" tvg-name="BBC One" tvg-logo="https://logos.example/bbc1.png" group-title="UK",BBC One HD',
  'https://provider.example/live/bbc1.m3u8',
  '#EXTINF:-1 tvg-id="itv.uk" tvg-name="ITV" tvg-logo="https://logos.example/itv.png" group-title="UK",ITV',
  'https://provider.example/live/itv.m3u8',
].join('\n');

describe('parseM3U', () => {
  it('reads the attributes off a standard playlist', () => {
    const entries = parseM3U(STANDARD);

    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({
      lineNumber: 2,
      rawName: 'BBC One',
      rawUrl: 'https://provider.example/live/bbc1.m3u8',
      rawLogo: 'https://logos.example/bbc1.png',
      rawGroup: 'UK',
      rawTvgId: 'bbc1.uk',
    });
  });

  it('handles Windows line endings', () => {
    const entries = parseM3U(STANDARD.split('\n').join('\r\n'));

    expect(entries).toHaveLength(2);
    expect(entries[0]?.rawUrl).toBe('https://provider.example/live/bbc1.m3u8');
    // A stray \r left on the end of the URL would still parse as a URL, so this
    // asserts the value rather than merely the count.
    expect(entries[1]?.rawUrl).toBe('https://provider.example/live/itv.m3u8');
    expect(entries[1]?.rawGroup).toBe('UK');
  });

  it('skips entries whose URL is not http or https, and reports them', () => {
    const onSkip = vi.fn();

    const entries = parseM3U(
      [
        '#EXTM3U',
        '#EXTINF:-1,Multicast',
        'rtp://239.0.0.1:5000',
        '#EXTINF:-1,File',
        'file:///etc/passwd',
        '#EXTINF:-1,Nonsense',
        'not a url at all',
        '#EXTINF:-1,Real',
        'https://provider.example/live/real.m3u8',
      ].join('\n'),
      onSkip,
    );

    expect(entries.map((entry) => entry.rawName)).toEqual(['Real']);
    expect(onSkip).toHaveBeenCalledTimes(3);
    expect(onSkip).toHaveBeenCalledWith({ lineNumber: 3, reason: 'unsupported-scheme' });
    expect(onSkip).toHaveBeenCalledWith({ lineNumber: 7, reason: 'unparseable-url' });
  });

  it('does not carry a skipped entry name onto the next URL', () => {
    const entries = parseM3U(
      ['#EXTINF:-1,Multicast', 'rtp://239.0.0.1:5000', 'https://provider.example/bare.m3u8'].join(
        '\n',
      ),
    );

    expect(entries).toEqual([
      {
        lineNumber: 3,
        rawName: null,
        rawUrl: 'https://provider.example/bare.m3u8',
        rawLogo: null,
        rawGroup: null,
        rawTvgId: null,
      },
    ]);
  });

  it('parses a file with no #EXTM3U header', () => {
    const entries = parseM3U(
      [
        '#EXTINF:-1,First',
        'https://provider.example/one.m3u8',
        '#EXTINF:-1,Second',
        'https://provider.example/two.m3u8',
      ].join('\n'),
    );

    expect(entries.map((entry) => entry.rawName)).toEqual(['First', 'Second']);
  });

  it('returns entries in source order', () => {
    const entries = parseM3U(
      [
        '#EXTM3U',
        ...Array.from({ length: 6 }, (_, index) => [
          `#EXTINF:-1,Channel ${index}`,
          `https://provider.example/${index}.m3u8`,
        ]).flat(),
      ].join('\n'),
    );

    expect(entries.map((entry) => entry.rawName)).toEqual([
      'Channel 0',
      'Channel 1',
      'Channel 2',
      'Channel 3',
      'Channel 4',
      'Channel 5',
    ]);
    expect(entries.map((entry) => entry.lineNumber)).toEqual([2, 4, 6, 8, 10, 12]);
  });

  it('accepts single-quoted as well as double-quoted attributes', () => {
    const entries = parseM3U(
      [
        '#EXTM3U',
        "#EXTINF:-1 tvg-id='sky.uk' tvg-name='Sky News' tvg-logo='https://logos.example/sky.png' group-title='News',Sky News",
        'https://provider.example/sky.m3u8',
      ].join('\n'),
    );

    expect(entries[0]).toMatchObject({
      rawName: 'Sky News',
      rawLogo: 'https://logos.example/sky.png',
      rawGroup: 'News',
      rawTvgId: 'sky.uk',
    });
  });

  it('does not mistake a comma inside an attribute for the name separator', () => {
    const entries = parseM3U(
      ['#EXTINF:-1 group-title="News, Live",Al Jazeera', 'https://provider.example/aj.m3u8'].join(
        '\n',
      ),
    );

    expect(entries[0]?.rawGroup).toBe('News, Live');
    expect(entries[0]?.rawName).toBe('Al Jazeera');
  });

  it('falls back to the display name when tvg-name is absent', () => {
    const entries = parseM3U(
      ['#EXTINF:-1 group-title="UK",Channel 4', 'https://provider.example/c4.m3u8'].join('\n'),
    );

    expect(entries[0]?.rawName).toBe('Channel 4');
  });

  it('treats a bare URL with no #EXTINF as a nameless entry', () => {
    const entries = parseM3U(['#EXTM3U', 'https://provider.example/bare.m3u8'].join('\n'));

    expect(entries).toEqual([
      {
        lineNumber: 2,
        rawName: null,
        rawUrl: 'https://provider.example/bare.m3u8',
        rawLogo: null,
        rawGroup: null,
        rawTvgId: null,
      },
    ]);
  });

  it('ignores directives between an #EXTINF and its URL', () => {
    const entries = parseM3U(
      [
        '#EXTM3U',
        '#EXTINF:-1 tvg-name="Guarded",Guarded',
        '#EXTVLCOPT:http-user-agent=VLC/3.0',
        '#EXTGRP:Sport',
        'https://provider.example/guarded.m3u8',
      ].join('\n'),
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]?.rawName).toBe('Guarded');
  });

  it('reads a playlist with a byte order mark', () => {
    const entries = parseM3U(
      ['﻿#EXTM3U', '#EXTINF:-1,First', 'https://provider.example/one.m3u8'].join('\n'),
    );

    expect(entries).toHaveLength(1);
  });

  it('returns nothing for an empty or header-only file', () => {
    expect(parseM3U('')).toEqual([]);
    expect(parseM3U('#EXTM3U\n')).toEqual([]);
  });

  it('does not mutate its input', () => {
    const source = STANDARD;
    parseM3U(source);
    expect(source).toBe(STANDARD);
  });
});
