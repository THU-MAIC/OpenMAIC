/**
 * The response-body byte limits moved to `lib/media/bounded-download.ts` so
 * the media adapters (which must not import `@/lib/server`) can share the one
 * mechanism. Server callers keep importing from here.
 */
export {
  MAX_REMOTE_IMAGE_BYTES,
  MAX_REMOTE_IMAGE_BATCH_BYTES,
  MAX_PROVIDER_MEDIA_BYTES,
  DownloadSizeLimitError,
  DownloadByteBudget,
  readResponseBodyWithLimit,
} from '@/lib/media/bounded-download';
