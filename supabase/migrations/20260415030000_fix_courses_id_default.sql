-- Migration: Fix courses.id default and ensure stage_id uniqueness
-- Date: 2026-04-15
-- Goal: courses.id had no DEFAULT, causing every POST /api/courses insert to fail.
--       Add a gen_random_uuid() default as a safety net, and a unique index on stage_id.

-- 1. Set DEFAULT on courses.id so any insert that omits it still gets a valid PK.
DO $$
BEGIN
    -- Only set the default if the column doesn't already have one.
    -- This is idempotent across repeated runs.
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'courses'
          AND column_name = 'id'
          AND column_default IS NOT NULL
    ) THEN
        ALTER TABLE public.courses ALTER COLUMN id SET DEFAULT gen_random_uuid();
    END IF;
END $$;

-- 2. Unique index on stage_id for fast lookups via GET /api/courses?stageId=...
--    Partial index excludes rows where stage_id is NULL (catalog-only rows).
CREATE UNIQUE INDEX IF NOT EXISTS idx_courses_stage_id_unique
    ON public.courses(stage_id)
    WHERE stage_id IS NOT NULL;
