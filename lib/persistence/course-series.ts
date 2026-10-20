/**
 * The table behind a course series: a material too large for one course,
 * automatically split and generated as several sequential courses, in order.
 *
 * `course_series` holds one row per series (its id, owner, title and planned
 * part count). The series' courses stay ordinary `generation_runs` rows; a
 * run that belongs to a series carries the series' id and its own 1-based
 * `series_order` (see the `series_id`/`series_order` columns added to
 * `generation_runs` by `lib/persistence/generation-runs.ts`, and mirrored
 * onto `stage_meta` by `lib/persistence/stage-meta.ts` once the run's course
 * exists, so a course's listing can show its series membership without
 * joining back to a run).
 *
 * Every part reads the same real, owner-uploaded materials (`materialIds`,
 * same list for every part); a part never gets its own derived material row.
 * `pendingParts` holds, for every part not yet started as a run, only the
 * small `textRanges` map (`lib/server/generation/series/plan.ts`) cutting
 * each material's already-extracted text down to that part's slice --- not
 * the slice's text or images, which stay cheap to re-derive from the
 * (cached) extraction result when that part's own run reaches
 * material-analysis. This keeps the row small regardless of material size.
 */
import type { Queryable } from '@openmaic/storage/document/pg';
import { applySchemaMigrations, type SchemaMigrationSet } from '@openmaic/storage/pg-migrations';

/** The half-open character range of one material's text one series part teaches. */
export interface SeriesPartTextRange {
  start: number;
  end: number;
}

/** One part of the series not yet started as a run. */
export interface PendingSeriesPart {
  /** 1-based position in the series. */
  order: number;
  /** By original material id, the range of its text this part teaches. */
  textRanges: Record<string, SeriesPartTextRange>;
}

export interface CourseSeriesRow {
  id: string;
  ownerId: string;
  title: string;
  partCount: number;
  /** Owner-library material ids every part reads from, same list for all. */
  materialIds: string[];
  /** Parts not yet started as a run, by 1-based series order, ascending. */
  pendingParts: PendingSeriesPart[];
  createdAt: string;
}

interface RawCourseSeriesRow extends Record<string, unknown> {
  id: string;
  owner_id: string;
  title: string;
  part_count: number;
  material_ids: string[];
  pending_parts: CourseSeriesRow['pendingParts'];
  created_at: Date | string;
}

export const COURSE_SERIES_SCHEMA = `
CREATE TABLE IF NOT EXISTS course_series (
  id           TEXT PRIMARY KEY,
  owner_id     TEXT NOT NULL,
  title        TEXT NOT NULL,
  part_count   INTEGER NOT NULL CHECK (part_count > 0),
  material_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  pending_parts JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS course_series_owner_idx ON course_series (owner_id, created_at);
`;

export const COURSE_SERIES_MIGRATIONS: SchemaMigrationSet = {
  store: 'course-series',
  migrations: [{ version: 1, name: 'baseline', up: COURSE_SERIES_SCHEMA, transaction: false }],
};

export async function ensureCourseSeriesSchema(queryable: Queryable): Promise<void> {
  await applySchemaMigrations(queryable, COURSE_SERIES_MIGRATIONS);
}

function isoTimestamp(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

export function toCourseSeriesRow(row: RawCourseSeriesRow): CourseSeriesRow {
  return {
    id: row.id,
    ownerId: row.owner_id,
    title: row.title,
    partCount: row.part_count,
    materialIds: row.material_ids,
    pendingParts: row.pending_parts,
    createdAt: isoTimestamp(row.created_at),
  };
}

export const COURSE_SERIES_COLUMNS =
  'id, owner_id, title, part_count, material_ids, pending_parts, created_at';

/** A fresh series id (same shape as `generateClassroomId`, prefixed for readability in logs). */
function generateCourseSeriesId(): string {
  return `series-${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
}

/**
 * Create a series row: `firstPartTextRanges` is this row's own part 1 (the
 * run that discovered the split becomes part 1 in the same commit that
 * creates this row, so part 1 is never in `pendingParts`); `restParts` is
 * every later part, not yet started as a run.
 */
export async function createCourseSeries(
  queryable: Queryable,
  input: {
    ownerId: string;
    title: string;
    materialIds: string[];
    partCount: number;
    restParts: PendingSeriesPart[];
  },
): Promise<CourseSeriesRow> {
  const id = generateCourseSeriesId();
  const result = await queryable.query<RawCourseSeriesRow>(
    `INSERT INTO course_series (id, owner_id, title, part_count, material_ids, pending_parts)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb)
     RETURNING ${COURSE_SERIES_COLUMNS}`,
    [
      id,
      input.ownerId,
      input.title,
      input.partCount,
      JSON.stringify(input.materialIds),
      JSON.stringify(input.restParts),
    ],
  );
  return toCourseSeriesRow(result.rows[0]!);
}

export async function getCourseSeries(
  queryable: Queryable,
  id: string,
  ownerId: string,
): Promise<CourseSeriesRow | null> {
  const result = await queryable.query<RawCourseSeriesRow>(
    `SELECT ${COURSE_SERIES_COLUMNS} FROM course_series WHERE id = $1 AND owner_id = $2`,
    [id, ownerId],
  );
  return result.rows[0] ? toCourseSeriesRow(result.rows[0]) : null;
}

/**
 * Pop the series' next pending part (lowest `order`), atomically: locks the
 * row, so two callers racing to start the next part (the run completion path
 * and a retry of it) cannot both pop the same one. Null when none are left.
 */
export async function claimNextPendingSeriesPart(
  queryable: Queryable,
  seriesId: string,
): Promise<PendingSeriesPart | null> {
  const result = await queryable.query<RawCourseSeriesRow>(
    `SELECT ${COURSE_SERIES_COLUMNS} FROM course_series WHERE id = $1 FOR UPDATE`,
    [seriesId],
  );
  const row = result.rows[0];
  if (!row) return null;
  const pending = [...row.pending_parts].sort((a, b) => a.order - b.order);
  const next = pending[0];
  if (!next) return null;
  await queryable.query(
    `UPDATE course_series SET pending_parts = $2::jsonb WHERE id = $1`,
    [seriesId, JSON.stringify(pending.slice(1))],
  );
  return next;
}
