-- Migration: Add headline to courses
-- Date: 2026-04-16
-- Goal: Add an engaging course headline that is visible in the catalog.

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='courses' AND column_name='headline') THEN
        ALTER TABLE public.courses ADD COLUMN headline TEXT;
    END IF;
END $$;
