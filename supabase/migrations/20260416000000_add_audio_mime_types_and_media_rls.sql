-- Migration: Add audio MIME types to courses bucket; add service-role write policy to media bucket
-- Date: 2026-04-16
-- Goal:
--   1. Allow the Temporal worker (using service-role admin client) to upload TTS audio
--      files to courses/{stageId}/audio/*.{mp3,wav,ogg,aac} in the 'courses' bucket.
--   2. Confirm the 'media' bucket exists and has a service-role-compatible write policy
--      so the worker can upload generated images and videos.

-- ─── 1. Update courses bucket to accept audio MIME types ─────────────────────

UPDATE storage.buckets
SET
  allowed_mime_types = ARRAY[
    'image/png',
    'image/jpeg',
    'application/pdf',
    'application/json',
    'audio/mpeg',
    'audio/wav',
    'audio/ogg',
    'audio/aac',
    'audio/mp4'
  ]
WHERE id = 'courses';

-- ─── 2. Ensure media bucket exists ───────────────────────────────────────────

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'media',
  'media',
  true,
  52428800,  -- 50 MiB
  ARRAY['image/png', 'image/jpeg', 'image/webp', 'video/mp4']
)
ON CONFLICT (id) DO UPDATE
  SET
    public              = EXCLUDED.public,
    file_size_limit     = EXCLUDED.file_size_limit,
    allowed_mime_types  = EXCLUDED.allowed_mime_types;

-- ─── 3. Media bucket — public read ───────────────────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage'
      AND tablename  = 'objects'
      AND policyname = 'Media public read'
  ) THEN
    CREATE POLICY "Media public read"
      ON storage.objects FOR SELECT
      USING (bucket_id = 'media');
  END IF;
END $$;

-- ─── 4. Media bucket — authenticated upload ───────────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage'
      AND tablename  = 'objects'
      AND policyname = 'Media authenticated upload'
  ) THEN
    CREATE POLICY "Media authenticated upload"
      ON storage.objects FOR INSERT
      WITH CHECK (bucket_id = 'media' AND auth.role() = 'authenticated');
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage'
      AND tablename  = 'objects'
      AND policyname = 'Media authenticated update'
  ) THEN
    CREATE POLICY "Media authenticated update"
      ON storage.objects FOR UPDATE
      USING (bucket_id = 'media' AND auth.role() = 'authenticated');
  END IF;
END $$;

-- Note: Service-role (admin client used by Temporal worker) bypasses RLS by design.
-- No extra policy is needed for server-side uploads from the worker.
