-- Migration: Unify Course Schema and Add Scenes Table
-- Date: 2026-04-15
-- Goal: Add all missing columns to courses, create scenes table, keep existing data intact.

-- 1. Add missing columns to courses (all idempotent via IF NOT EXISTS-style DO block)
DO $$
BEGIN
    -- Full-text name (was 'title' in old schema)
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='courses' AND column_name='name') THEN
        ALTER TABLE public.courses ADD COLUMN name TEXT;
    END IF;
    -- Backfill name from title if title exists
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='courses' AND column_name='title') THEN
        UPDATE public.courses SET name = title WHERE name IS NULL;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='courses' AND column_name='user_id') THEN
        ALTER TABLE public.courses ADD COLUMN user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='courses' AND column_name='creation_prompt_id') THEN
        ALTER TABLE public.courses ADD COLUMN creation_prompt_id UUID;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='courses' AND column_name='stage_id') THEN
        ALTER TABLE public.courses ADD COLUMN stage_id TEXT;
    END IF;

    -- 'thumbnail' (short alias); old schema had 'thumbnail_url'
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='courses' AND column_name='thumbnail') THEN
        ALTER TABLE public.courses ADD COLUMN thumbnail TEXT;
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='courses' AND column_name='thumbnail_url') THEN
        UPDATE public.courses SET thumbnail = thumbnail_url WHERE thumbnail IS NULL;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='courses' AND column_name='style') THEN
        ALTER TABLE public.courses ADD COLUMN style TEXT;
    END IF;

    -- Make title nullable to support transitioning to 'name'
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='courses' AND column_name='title') THEN
        ALTER TABLE public.courses ALTER COLUMN title DROP NOT NULL;
    END IF;
END $$;

-- 2. Create scenes table
CREATE TABLE IF NOT EXISTS public.scenes (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id   TEXT        NOT NULL REFERENCES public.courses(id) ON DELETE CASCADE,
  scene_id    TEXT        NOT NULL,
  type        TEXT        NOT NULL,
  title       TEXT,
  "order"     INTEGER     NOT NULL DEFAULT 0,
  content     JSONB,
  actions     JSONB,
  whiteboards JSONB,
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now()
);

-- 3. Enable RLS on scenes
ALTER TABLE public.scenes ENABLE ROW LEVEL SECURITY;

-- 4. Policies for scenes
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'scenes' AND policyname = 'Public read access') THEN
        CREATE POLICY "Public read access" ON public.scenes FOR SELECT USING (true);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'scenes' AND policyname = 'Allow anonymous insert') THEN
        CREATE POLICY "Allow anonymous insert" ON public.scenes FOR INSERT WITH CHECK (true);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'scenes' AND policyname = 'Allow anonymous update') THEN
        CREATE POLICY "Allow anonymous update" ON public.scenes FOR UPDATE USING (true);
    END IF;
END $$;

-- 5. Indices (all idempotent)
CREATE INDEX IF NOT EXISTS idx_scenes_course_id  ON public.scenes(course_id);
CREATE INDEX IF NOT EXISTS idx_scenes_order       ON public.scenes(course_id, "order");
CREATE INDEX IF NOT EXISTS idx_courses_user_id    ON public.courses(user_id);
CREATE INDEX IF NOT EXISTS idx_courses_stage_id   ON public.courses(stage_id);
