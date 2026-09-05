/**
 * Query keys for the analytics section.
 *
 * Kept in one file for the same reason `homeKeys.ts` is: an invalidation that
 * misses by one segment fails silently — the table simply does not refresh —
 * and that is much easier to see when every key is written down together.
 */
export const analyticsKeys = {
  all: ['admin', 'analytics'] as const,
  overview: (periodDays: number) => ['admin', 'analytics', 'overview', periodDays] as const,
  trending: (periodDays: number, contentType: string) =>
    ['admin', 'analytics', 'trending', periodDays, contentType] as const,
  boosts: ['admin', 'analytics', 'boosts'] as const,
  device: (deviceId: string) => ['admin', 'analytics', 'device', deviceId] as const,
  devicePreview: (deviceId: string) =>
    ['admin', 'analytics', 'device', deviceId, 'recommendations'] as const,
};
