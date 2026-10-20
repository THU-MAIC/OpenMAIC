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
 * The material for parts not yet started is kept on this table too
 * (`pending_parts`, cleared as each part's run is created), since those runs
 * do not exist yet and so have nowhere else to hold it.
 */
import type { Queryable } from '@openmaic/storage/document/pg';
import { applySchemaMigrations, type SchemaMigrationSet } from '@openmaic/storage/pg-migrations';

import type { ParsedDocumentPart } from '@/lib/document/bundle';

export interface CourseSeriesRow {
  id: string;
  ownerId: string;
  title: string;
  partCount: number;
  /** Parts not yet started as a run, by 1-based series index, ascending. */
  pendingParts: Array<{ index: number; parts: ParsedDocumentPart[] }>;
  createdAt: string;
}

interface RawCourseSeriesRow extends Record<string, unknown> {
  id: string;
  owner_id: string;
  title: string;
  part_count: number;
  pending_parts: CourseSeriesRow['pendingParts'];
  created_at: Date | string;
}

export const COURSE_SERIES_SCHEMA = `
CREATE TABLE IF NOT EXISTS course_series (
  id           TEXT PRIMARY KEY,
  owner_id     TEXT NOT NULL,
  title        TEXT NOT NULL,
  part_count   INTEGER NOT NULL CHECK (part_count > 0),
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
    pendingParts: row.pending_parts,
    createdAt: isoTimestamp(row.created_at),
  };
}

export const COURSE_SERIES_COLUMNS =
  'id, owner_id, title, part_count, pending_parts, created_at';
