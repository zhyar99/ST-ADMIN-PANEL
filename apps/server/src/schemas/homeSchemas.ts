import { z } from 'zod';

/**
 * Zod shapes for the Home row routes.
 *
 * Same arrangement as `catalogSchemas.ts`: this is the security boundary, and
 * it mirrors `packages/shared/src/api-contract/home.ts` rather than importing
 * from it, because @streaming/shared is ESM and this server compiles to
 * CommonJS — types cross that boundary, runtime values do not.
 */

/** Mirrors `HomeItemRefType`. */
export const homeItemRefType = z.enum(['MOVIE', 'SERIES', 'LIVE_CHANNEL']);

/**
 * Copy that must say something in all three languages, with no extra keys.
 * Mirrors `requiredLocalizedText` in `catalogSchemas.ts`.
 */
const requiredLocalizedText = z
  .object({
    en: z.string().trim().min(1, 'English text is required'),
    ckb: z.string().trim().min(1, 'Kurdish Sorani text is required'),
    ar: z.string().trim().min(1, 'Arabic text is required'),
  })
  .strict();

/**
 * One entry in a row.
 *
 * `.strict()` so a client cannot smuggle a denormalised `title` or — the case
 * that matters — a `url` into a jsonb column that is written back verbatim.
 * The column is stored as given, so anything this schema accepts is persisted.
 */
const homeItemRef = z
  .object({
    type: homeItemRefType,
    id: z.string().uuid('Each item ref id must be a uuid'),
  })
  .strict();

/**
 * An ordered list of refs.
 *
 * Bounded because the whole array is resolved on every `GET /api/v1/home`, so
 * its length is a per-request cost. Duplicates are rejected: the same title
 * twice in one row is always an editing mistake, and allowing it would make
 * "remove this item" ambiguous in the UI.
 */
const itemRefs = z
  .array(homeItemRef)
  .max(100, 'A row may hold at most 100 items')
  .refine(
    (refs) => new Set(refs.map((ref) => `${ref.type}:${ref.id}`)).size === refs.length,
    'A row cannot list the same item twice',
  );

/**
 * `order` is bounded rather than free: it is only a sort key, and the reorder
 * endpoint rewrites it densely anyway, so there is no reason to accept values
 * that only exist to overflow something later.
 */
const rowOrder = z.coerce.number().int().min(0).max(10_000);

export const homeRowCreateBody = z
  .object({
    title_i18n: requiredLocalizedText,
    order: rowOrder.optional(),
    item_refs: itemRefs.optional(),
  })
  .strict();

export type HomeRowCreateBody = z.infer<typeof homeRowCreateBody>;

/**
 * PATCH semantics: every field optional, but at least one present. An empty
 * body is a no-op the caller almost certainly did not mean, so it is a 400
 * rather than a silent 200 with unchanged content.
 */
export const homeRowUpdateBody = z
  .object({
    title_i18n: requiredLocalizedText.optional(),
    order: rowOrder.optional(),
    item_refs: itemRefs.optional(),
  })
  .strict()
  .refine(
    (body) => Object.keys(body).length > 0,
    'Provide at least one of title_i18n, order or item_refs',
  );

export type HomeRowUpdateBody = z.infer<typeof homeRowUpdateBody>;

/**
 * Bulk reorder payload.
 *
 * The array must be duplicate-free: a repeated id would make the intended
 * position of that row ambiguous, and the last occurrence would silently win.
 */
export const homeRowReorderBody = z
  .object({
    ids: z
      .array(z.string().uuid('Each id must be a uuid'))
      .min(1, 'ids must not be empty')
      .max(500)
      .refine((ids) => new Set(ids).size === ids.length, 'ids must not contain duplicates'),
  })
  .strict();

export type HomeRowReorderBody = z.infer<typeof homeRowReorderBody>;

export const homeRowIdParam = z.object({
  id: z.string().uuid('Not a valid home row id'),
});

/**
 * Item-picker search.
 *
 * `q` is optional so the picker can show a default page of recent content
 * before the operator types anything; `type` narrows to one content kind.
 * `limit` is bounded per the phase's pagination rule.
 */
export const contentSearchQuery = z.object({
  q: z.string().trim().max(200).optional(),
  type: homeItemRefType.optional(),
  limit: z.coerce.number().int().min(1).max(20).default(20),
});

export type ContentSearchQuery = z.infer<typeof contentSearchQuery>;

/** `TYPE:uuid`, the wire form one ref takes in the lookup query string. */
const REF_PATTERN =
  /^(MOVIE|SERIES|LIVE_CHANNEL):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Ref resolution for the row editor.
 *
 * A comma-separated list rather than a JSON body because this is a read, and a
 * GET keeps it cacheable and logged as one. Capped at the same 100 refs a row
 * may hold, so the longest legitimate request still fits in one call.
 */
export const contentLookupQuery = z.object({
  refs: z
    .string()
    .trim()
    .transform((value) => value.split(',').filter((entry) => entry.trim() !== ''))
    .pipe(
      z
        .array(z.string().regex(REF_PATTERN, 'Each ref must be TYPE:uuid'))
        .max(100, 'At most 100 refs may be resolved at once'),
    )
    .transform((entries) =>
      entries.map((entry) => {
        const [type, id] = entry.split(':') as [string, string];
        return { type: type.toUpperCase() as z.infer<typeof homeItemRefType>, id };
      }),
    ),
});

export type ContentLookupQuery = z.infer<typeof contentLookupQuery>;
