import { z } from 'zod';

/** Cursor pagination — the default for consumer-facing catalog listings. */
export const CursorPaginationQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export type CursorPaginationQuery = z.infer<typeof CursorPaginationQuery>;

/** Offset pagination — for admin tables that need page numbers and totals. */
export const OffsetPaginationQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export type OffsetPaginationQuery = z.infer<typeof OffsetPaginationQuery>;

export interface PaginatedResult<T> {
  items: T[];
  /** Only populated when the caller asked for a count — it costs an extra query. */
  total?: number;
  nextCursor?: string;
  hasMore: boolean;
}
