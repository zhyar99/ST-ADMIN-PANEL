import { z } from 'zod';

/**
 * Bounded page/limit, shared by every consumer list endpoint.
 *
 * The ceiling is the point: without it a single request can ask for the whole
 * catalogue, and the response assembly (artwork joins, genre joins) is per-row
 * work. `.coerce` is needed because query strings arrive as strings.
 */
export const paginationQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export type PaginationQuery = z.infer<typeof paginationQuery>;
