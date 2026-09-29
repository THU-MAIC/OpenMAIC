import { agentRuntimeConfig } from '@/lib/server/agent-runtime/config';

/**
 * Per-file byte caps `POST /api/materials` enforces: media (audio/video)
 * uploads cap at `maxUploadBytes`, documents/images at
 * `min(maxDocumentBytes, maxUploadBytes)`. Read by the upload route and by the
 * classroom generation capabilities endpoint, which advertises them.
 */
export const MATERIAL_MEDIA_UPLOAD_LIMIT = agentRuntimeConfig.maxUploadBytes;
export const MATERIAL_DOCUMENT_UPLOAD_LIMIT = Math.min(
  agentRuntimeConfig.maxDocumentBytes,
  agentRuntimeConfig.maxUploadBytes,
);
