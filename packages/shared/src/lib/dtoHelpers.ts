/**
 * Stream URLs live in `stream_source.url` as plain text and must never reach a
 * consumer response. These two helpers are the single canonical way to strip
 * that field — no other code should hand-roll a `delete` or a spread-exclude,
 * so there is exactly one place to audit.
 */

/** Returns a shallow copy of `row` without its `url` field. Does not mutate. */
export function omitStreamUrl<T extends { url?: unknown }>(row: T): Omit<T, 'url'> {
  const { url: _url, ...rest } = row;
  return rest;
}

/** Array variant of {@link omitStreamUrl}. */
export function omitStreamUrls<T extends { url?: unknown }>(rows: T[]): Omit<T, 'url'>[] {
  return rows.map(omitStreamUrl);
}
