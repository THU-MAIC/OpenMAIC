-- Migration: Configure courses storage bucket to accept JSON content files
-- Date: 2026-04-15
-- Goal: Ensure the 'courses' bucket exists and allows application/json uploads
--       so that POST /api/courses can store {stage, scenes} blobs at
--       courses/{stage_id}/content.json for fast, auth-free client retrieval.

-- Create the bucket if it doesn't already exist (idempotent)
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'courses',
  'courses',
  true,
  10485760,  -- 10 MiB
  ARRAY['image/png', 'image/jpeg', 'application/pdf', 'application/json']
)
ON CONFLICT (id) DO UPDATE
  SET
    public              = EXCLUDED.public,
    file_size_limit     = EXCLUDED.file_size_limit,
    allowed_mime_types  = EXCLUDED.allowed_mime_types;

-- Allow public (anon) reads — the bucket is public so objects are readable without auth
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage'
      AND tablename  = 'objects'
      AND policyname = 'Courses public read'
  ) THEN
    CREATE POLICY "Courses public read"
      ON storage.objects FOR SELECT
      USING (bucket_id = 'courses');
  END IF;
END $$;

-- Allow authenticated users to upload/update their own course content
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage'
      AND tablename  = 'objects'
      AND policyname = 'Courses authenticated upload'
  ) THEN
    CREATE POLICY "Courses authenticated upload"
      ON storage.objects FOR INSERT
      WITH CHECK (bucket_id = 'courses' AND auth.role() = 'authenticated');
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage'
      AND tablename  = 'objects'
      AND policyname = 'Courses authenticated update'
  ) THEN
    CREATE POLICY "Courses authenticated update"
      ON storage.objects FOR UPDATE
      USING (bucket_id = 'courses' AND auth.role() = 'authenticated');
  END IF;
END $$;

-- Service-role (admin client used by POST /api/courses) bypasses RLS by design,
-- so no extra policy is needed for server-side uploads.
