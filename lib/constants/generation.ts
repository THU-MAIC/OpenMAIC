/**
 * Constants for PDF content generation
 * Shared between client and server code
 */

// PDF content truncation limit (characters)
export const MAX_PDF_CONTENT_CHARS = 50000;

// Maximum number of images to send as vision content parts
export const MAX_VISION_IMAGES = 20;

/** Used when callers omit locale or send an unknown value (matches home-page default). */
export const DEFAULT_GENERATION_LANGUAGE: 'en-US' = 'en-US';

export function resolveGenerationLanguage(
  language: string | undefined | null,
): 'zh-CN' | 'en-US' {
  if (language === 'zh-CN') return 'zh-CN';
  if (language === 'en-US') return 'en-US';
  return DEFAULT_GENERATION_LANGUAGE;
}
