-- Migration: Add audio MIME types to media bucket
-- Date: 2026-04-15
-- Goal:
--   Allow uploading audio assets (e.g. TTS) to the 'media' bucket as well,
--   in addition to the existing images/videos.

UPDATE storage.buckets
SET allowed_mime_types = ARRAY[
  'image/png',
  'image/jpeg',
  'image/webp',
  'video/mp4',
  'audio/mpeg',
  'audio/wav',
  'audio/ogg',
  'audio/aac',
  'audio/mp4',
  'audio/webm',
  'audio/flac'
]
WHERE id = 'media';

