/**
 * M3U / M3U8 playlist parsing.
 *
 * Pure text work, deliberately: nothing here opens a socket. A playlist is an
 * untrusted file full of operator-supplied URLs, and the moment a parser
 * fetches one of them — a `tvg-logo`, a nested manifest — it becomes an SSRF
 * gadget pointed at whatever the server can reach. Logo URLs are stored as text
 * and left alone; fetching them is a Section 25 item.
 *
 * The grammar recognised here is the one every IPTV provider actually emits:
 *
 *     #EXTM3U
 *     #EXTINF:-1 tvg-id="bbc1" tvg-name="BBC One" group-title="UK",BBC One
 *     https://provider.example/live/bbc1.m3u8
 *
 * The header is optional, attributes may be single- or double-quoted, and a URL
 * line with no preceding `#EXTINF:` is still an entry — just a nameless one.
 */

export interface ParsedEntry {
  /** Where the entry begins: its `#EXTINF:` line, or its URL line if it has none. */
  lineNumber: number;
  rawName: string | null;
  rawUrl: string;
  rawLogo: string | null;
  rawGroup: string | null;
  rawTvgId: string | null;
}

/** Why a line was passed over. Carries no URL — see the note on `parseM3U`. */
export interface SkippedLine {
  lineNumber: number;
  reason: 'unsupported-scheme' | 'unparseable-url';
}

const EXTINF = '#EXTINF:';
const EXTM3U = '#EXTM3U';

/**
 * `key="value"` or `key='value'`, as they appear on an `#EXTINF:` line.
 *
 * Both quote styles are in the wild, and the two alternatives are kept separate
 * rather than folded into a character class so a value containing the *other*
 * quote character survives intact.
 */
const ATTRIBUTE_PATTERN = /([A-Za-z0-9_-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

function attributesOf(body: string): Map<string, string> {
  const attributes = new Map<string, string>();

  for (const match of body.matchAll(ATTRIBUTE_PATTERN)) {
    const value = (match[2] ?? match[3] ?? '').trim();
    if (value !== '') attributes.set(match[1]!.toLowerCase(), value);
  }

  return attributes;
}

/**
 * The display name: everything after the comma that closes the attribute list.
 *
 * Searching from the last quote rather than from the start is what keeps a
 * comma *inside* an attribute value (`tvg-name="News, Live"`) from being
 * mistaken for the separator.
 */
function displayNameOf(body: string): string {
  const lastQuote = Math.max(body.lastIndexOf('"'), body.lastIndexOf("'"));
  const separator = body.indexOf(',', lastQuote + 1);

  return separator === -1 ? '' : body.slice(separator + 1).trim();
}

/** True for a syntactically valid http/https URL, matching `stream_source.url`. */
function httpUrlOrNull(value: string): 'ok' | SkippedLine['reason'] {
  let parsed: URL;

  try {
    parsed = new URL(value);
  } catch {
    return 'unparseable-url';
  }

  return /^https?:$/.test(parsed.protocol) ? 'ok' : 'unsupported-scheme';
}

interface PendingInfo {
  lineNumber: number;
  rawName: string | null;
  rawLogo: string | null;
  rawGroup: string | null;
  rawTvgId: string | null;
}

function readExtinf(line: string, lineNumber: number): PendingInfo {
  const body = line.slice(EXTINF.length);
  const attributes = attributesOf(body);
  const displayName = displayNameOf(body);

  return {
    lineNumber,
    // `tvg-name` is the provider's canonical label; the text after the comma is
    // what a player shows. They usually agree, and where they do not the
    // attribute is the more reliable of the two.
    rawName: attributes.get('tvg-name') ?? (displayName === '' ? null : displayName),
    rawLogo: attributes.get('tvg-logo') ?? null,
    rawGroup: attributes.get('group-title') ?? null,
    rawTvgId: attributes.get('tvg-id') ?? null,
  };
}

/**
 * Parses a playlist into entries, in source order.
 *
 * A line whose URL is not http/https is dropped rather than thrown on: one
 * `rtp://` multicast address in a file of ten thousand channels is a line to
 * ignore, not a failed import. `onSkip` reports those, and is handed the line
 * number and a reason — never the URL itself, which falls under the same
 * no-logging rule as `stream_source.url`.
 *
 * Does not mutate `fileContent`.
 */
export function parseM3U(fileContent: string, onSkip?: (skipped: SkippedLine) => void): ParsedEntry[] {
  const entries: ParsedEntry[] = [];
  // Handles LF, CRLF and the lone-CR files that some Windows tooling still
  // produces. A leading BOM would otherwise ride along on the first line.
  const lines = fileContent.replace(/^\uFEFF/, '').split(/\r\n|\r|\n/);

  let pending: PendingInfo | null = null;

  for (const [index, rawLine] of lines.entries()) {
    const lineNumber = index + 1;
    const line = rawLine.trim();

    if (line === '') continue;

    if (line.startsWith(EXTINF)) {
      pending = readExtinf(line, lineNumber);
      continue;
    }

    // `#EXTM3U`, `#EXTVLCOPT`, `#EXTGRP`, plain comments: recognised and
    // ignored. Crucially they do *not* clear `pending` — providers routinely
    // put player options between an `#EXTINF:` and its URL.
    if (line.startsWith('#')) {
      if (line.startsWith(EXTM3U)) pending = null;
      continue;
    }

    const verdict = httpUrlOrNull(line);

    if (verdict !== 'ok') {
      onSkip?.({ lineNumber, reason: verdict });
      pending = null;
      continue;
    }

    entries.push({
      lineNumber: pending?.lineNumber ?? lineNumber,
      rawName: pending?.rawName ?? null,
      rawUrl: line,
      rawLogo: pending?.rawLogo ?? null,
      rawGroup: pending?.rawGroup ?? null,
      rawTvgId: pending?.rawTvgId ?? null,
    });

    pending = null;
  }

  return entries;
}
