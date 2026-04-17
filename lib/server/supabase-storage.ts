/**
 * Supabase Storage adapter for binary files (TTS audio, images).
 *
 * Used when SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are set.
 * Falls back to Vercel Blob when not configured.
 *
 * Bucket: openmaic-media (public) — create once in Supabase dashboard:
 *   Storage → New bucket → name: openmaic-media → Public: on
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { createLogger } from '@/lib/logger';

const log = createLogger('SupabaseStorage');

export const USE_SUPABASE_STORAGE =
  !!process.env.SUPABASE_URL && !!process.env.SUPABASE_SERVICE_ROLE_KEY;

const BUCKET = 'openmaic-media';

let _client: SupabaseClient | null = null;

function getClient(): SupabaseClient {
  if (!_client) {
    _client = createClient(
      process.env.SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    );
  }
  return _client;
}

export async function supabaseWriteBinary(
  key: string,
  data: Buffer,
  contentType: string,
): Promise<string> {
  const { error } = await getClient()
    .storage.from(BUCKET)
    .upload(key, data, { contentType, upsert: true });

  if (error) {
    log.error(`Supabase upload failed for "${key}":`, error);
    throw new Error(`Supabase upload failed: ${error.message}`);
  }

  const { data: urlData } = getClient().storage.from(BUCKET).getPublicUrl(key);
  return urlData.publicUrl;
}

export async function supabaseGetBinaryUrl(key: string): Promise<string | null> {
  try {
    const { data, error } = await getClient()
      .storage.from(BUCKET)
      .list(key.split('/').slice(0, -1).join('/'), {
        search: key.split('/').pop(),
        limit: 1,
      });

    if (error || !data?.length) return null;
    const { data: urlData } = getClient().storage.from(BUCKET).getPublicUrl(key);
    return urlData.publicUrl;
  } catch {
    return null;
  }
}
