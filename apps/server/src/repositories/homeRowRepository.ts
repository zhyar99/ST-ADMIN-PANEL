import { asc, eq, sql } from 'drizzle-orm';

import type {
  HomeItemRef,
  HomeRowDto,
  LocalizedText,
} from '@streaming/shared' with { 'resolution-mode': 'import' };

import { db } from '../db/client';
import { homeRow } from '../db/schema';
import { HttpError } from '../middleware/errorHandler';

/**
 * Persistence for `home_row`.
 *
 * Every read here returns rows in `order` ascending with `id` as the tie-break,
 * so equal `order` values — which the schema permits — still produce a stable
 * sequence rather than one that changes between requests.
 */

const columns = {
  id: homeRow.id,
  titleI18n: homeRow.titleI18n,
  order: homeRow.order,
  itemRefs: homeRow.itemRefs,
  createdAt: homeRow.createdAt,
  updatedAt: homeRow.updatedAt,
};

interface Row {
  id: string;
  titleI18n: LocalizedText;
  order: number;
  itemRefs: HomeItemRef[];
  createdAt: Date;
  updatedAt: Date;
}

function toDto(row: Row): HomeRowDto {
  return {
    id: row.id,
    titleI18n: row.titleI18n,
    order: row.order,
    // Defensive: the column is NOT NULL with a `[]` default, but it is jsonb —
    // a hand-written UPDATE could put a scalar there, and a non-array would
    // otherwise reach the UI as something it cannot map over.
    itemRefs: Array.isArray(row.itemRefs) ? row.itemRefs : [],
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function listHomeRows(): Promise<HomeRowDto[]> {
  const rows = await db
    .select(columns)
    .from(homeRow)
    .orderBy(asc(homeRow.order), asc(homeRow.id));

  return rows.map(toDto);
}

export async function findHomeRow(id: string): Promise<HomeRowDto | null> {
  const [row] = await db.select(columns).from(homeRow).where(eq(homeRow.id, id)).limit(1);
  return row ? toDto(row) : null;
}

/** Like {@link findHomeRow} but 404s instead of returning null. */
export async function requireHomeRow(id: string): Promise<HomeRowDto> {
  const row = await findHomeRow(id);
  if (!row) throw new HttpError(404, 'NOT_FOUND', 'Home row not found');
  return row;
}

export interface CreateHomeRowInput {
  titleI18n: LocalizedText;
  order?: number;
  itemRefs?: HomeItemRef[];
}

/**
 * Appends a row.
 *
 * With no explicit `order` the row lands after every existing one, which is
 * what "Add Row" means. The subquery computes that position inside the INSERT
 * so two concurrent creates cannot both read the same max and collide — and if
 * they did, equal orders are merely untidy, not an error.
 */
export async function createHomeRow(input: CreateHomeRowInput): Promise<HomeRowDto> {
  const [row] = await db
    .insert(homeRow)
    .values({
      titleI18n: input.titleI18n,
      order:
        input.order ??
        sql`(select coalesce(max(${homeRow.order}) + 1, 0) from ${homeRow})`,
      itemRefs: input.itemRefs ?? [],
    })
    .returning(columns);

  return toDto(row!);
}

export interface UpdateHomeRowInput {
  titleI18n?: LocalizedText;
  order?: number;
  itemRefs?: HomeItemRef[];
}

export async function updateHomeRow(
  id: string,
  input: UpdateHomeRowInput,
): Promise<HomeRowDto> {
  const [row] = await db
    .update(homeRow)
    .set({
      ...(input.titleI18n !== undefined ? { titleI18n: input.titleI18n } : {}),
      ...(input.order !== undefined ? { order: input.order } : {}),
      ...(input.itemRefs !== undefined ? { itemRefs: input.itemRefs } : {}),
      updatedAt: new Date(),
    })
    .where(eq(homeRow.id, id))
    .returning(columns);

  if (!row) throw new HttpError(404, 'NOT_FOUND', 'Home row not found');

  return toDto(row);
}

/**
 * Deletes the editorial row only.
 *
 * There is nothing to cascade: `item_refs` holds ids, not foreign keys, so the
 * movies and channels a row pointed at are untouched by design.
 */
export async function deleteHomeRow(id: string): Promise<void> {
  const [row] = await db.delete(homeRow).where(eq(homeRow.id, id)).returning({ id: homeRow.id });

  if (!row) throw new HttpError(404, 'NOT_FOUND', 'Home row not found');
}

/**
 * Rewrites every listed row's position to its index in `ids`.
 *
 * All-or-nothing: the existence check and the writes share one transaction, so
 * a payload naming a row that was deleted a moment ago leaves the previous
 * order completely intact rather than half-applied.
 *
 * `ids` must name *every* row. A partial reorder is rejected because the
 * positions it does not mention would keep their old values and interleave
 * unpredictably with the dense 0..n-1 range assigned here — the caller would
 * have asked for one order and got another.
 */
export async function reorderHomeRows(ids: string[]): Promise<HomeRowDto[]> {
  return db.transaction(async (tx) => {
    const existing = await tx.select({ id: homeRow.id }).from(homeRow);
    const known = new Set(existing.map((row) => row.id));

    const missing = ids.filter((id) => !known.has(id));
    if (missing.length > 0) {
      throw new HttpError(404, 'NOT_FOUND', `Unknown home row id(s): ${missing.join(', ')}`);
    }

    if (ids.length !== known.size) {
      throw new HttpError(
        400,
        'VALIDATION_ERROR',
        `ids must list every home row (expected ${known.size}, got ${ids.length})`,
      );
    }

    // One statement rather than a loop of N updates: the positions are applied
    // as a single set, so there is no window in which some rows carry new
    // positions and the rest still carry old ones.
    const positions = sql.join(
      ids.map((id, index) => sql`(${id}::uuid, ${index}::integer)`),
      sql`, `,
    );

    await tx.execute(
      sql`update ${homeRow} set "order" = v.position, "updated_at" = now()
          from (values ${positions}) as v(id, position)
          where ${homeRow.id} = v.id`,
    );

    const rows = await tx
      .select(columns)
      .from(homeRow)
      .orderBy(asc(homeRow.order), asc(homeRow.id));

    return rows.map(toDto);
  });
}
