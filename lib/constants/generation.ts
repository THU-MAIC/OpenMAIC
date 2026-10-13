/**
 * Constants for PDF content generation
 * Shared between client and server code
 */

// PDF content truncation limit (characters)
export const MAX_PDF_CONTENT_CHARS = 50000;

// Maximum number of images to send as vision content parts
export const MAX_VISION_IMAGES = 20;

// Keep decoded attachments below provider size limits and bound image dimensions.
// Large or unsupported images can crash prompt building or be rejected by providers.
export const MAX_VISION_IMAGE_BYTES = 1024 * 1024;
export const MAX_VISION_IMAGE_DIMENSION = 2048;

// Size cap for one course material document (bytes), enforced by the extract
// route on both the multipart and asset-id forms and by the vision-image
// resolution (`resolveVisionImagesForPrompt`) so an oversized asset is
// rejected at `identify` — before any bytes are materialized.
export const MAX_EXTRACT_DOCUMENT_FILE_SIZE_BYTES = 50 * 1024 * 1024;
