import { desc, eq, sql } from 'drizzle-orm';

import type {
  DeviceContentType,
  RecommendationBoostDTO,
} from '@streaming/shared' with { 'resolution-mode': 'import' };

import { db } from '../../db/client';
import { adminUser, recommendationBoost } from '../../db/schema';
import { HttpError } from '../../middleware/errorHandler';
import { resolveContentSummaries, summaryKey } from './contentSummaries';

/**
 * Editorial boosts (Phase 15).
 *
 * One standing decision per content item, which is why the write is an upsert
 * on `(content_type, content_id)` rather than an insert: an operator who boosts
 * the same film twice has changed their mind, not created a second campaign.
 *
 * Removal is soft. The audit trail records who removed a boost and when, and a
 * hard delete would leave that entry pointing at a row that no longer exists —
 * which is precisely the question someone reading the audit log is asking.
 */

export interface BoostInput {
  contentType: DeviceContentType;
  contentId: string;
  boostScore: number;
  reason?: string;
  expiresAt?: string | null;
  createdBy: string;
}

/**
 * Every boost, active first.
 *
 * Inactive rows are included: a removed boost is history an operator may want
 * to see, and the `active` flag in the DTO is what the table renders it by.
 */
export async function listBoosts(): Promise<RecommendationBoostDTO[]> {
  const rows = await db
    .select({
      id: recommendationBoost.id,
      contentType: recommendationBoost.contentType,
      contentId: recommendationBoost.contentId,
      boostScore: recommendationBoost.boostScore,
      reason: recommendationBoost.reason,
      active: recommendationBoost.active,
      expiresAt: recommendationBoost.expiresAt,
      createdBy: recommendationBoost.createdBy,
      createdByName: adminUser.name,
      createdAt: recommendationBoost.createdAt,
    })
    .from(recommendationBoost)
    .leftJoin(adminUser, eq(adminUser.id, recommendationBoost.createdBy))
    .orderBy(desc(recommendationBoost.active), desc(recommendationBoost.createdAt));

  const summaries = await resolveContentSummaries(
    rows.map((row) => ({ contentType: row.contentType, contentId: row.contentId })),
  );

  return rows.map((row) => ({
    id: row.id,
    content_type: row.contentType,
    content_id: row.contentId,
    // Raw `title_i18n` rather than a resolved string: this is an admin DTO, and
    // the panel renders whichever language the operator is working in.
    title_i18n: summaries.get(summaryKey(row.contentType, row.contentId))?.titleI18n ?? null,
    boost_score: Number(row.boostScore),
    reason: row.reason,
    active: row.active,
    expires_at: row.expiresAt?.toISOString() ?? null,
    created_by: row.createdBy,
    created_by_name: row.createdByName,
    created_at: row.createdAt.toISOString(),
  }));
}

/** Creates or replaces the standing boost for one content item. */
export async function upsertBoost(input: BoostInput): Promise<{ id: string }> {
  const expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;

  const [row] = await db
    .insert(recommendationBoost)
    .values({
      contentType: input.contentType,
      contentId: input.contentId,
      // `numeric` columns take a string in Drizzle, for the same reason they
      // come back as one: the type has more range than a JS number.
      boostScore: input.boostScore.toFixed(2),
      reason: input.reason ?? null,
      expiresAt,
      createdBy: input.createdBy,
      active: true,
    })
    .onConflictDoUpdate({
      target: [recommendationBoost.contentType, recommendationBoost.contentId],
      set: {
        boostScore: input.boostScore.toFixed(2),
        reason: input.reason ?? null,
        expiresAt,
        createdBy: input.createdBy,
        active: true,
        createdAt: sql`now()`,
      },
    })
    .returning({ id: recommendationBoost.id });

  return { id: row!.id };
}

/** Soft-deletes a boost. A second removal is a 404, not a silent success. */
export async function deactivateBoost(id: string): Promise<void> {
  const updated = await db
    .update(recommendationBoost)
    .set({ active: false })
    .where(eq(recommendationBoost.id, id))
    .returning({ id: recommendationBoost.id });

  if (updated.length === 0) throw new HttpError(404, 'NOT_FOUND', 'No such boost');
}
