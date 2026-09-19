/**
 * Media Parse Provider Type Definitions
 *
 * Parallel to lib/pdf/types.ts. Media parsers accept audio/video buffers and
 * return timestamp-anchored transcript + keyframes as MediaArtifact.
 */

import type { MediaArtifact } from '@/lib/document';

export type MediaParseProviderId = 'alidocmind';

export interface MediaParseProviderConfig {
  id: MediaParseProviderId;
  name: string;
  requiresApiKey: boolean;
  baseUrl?: string;
  icon?: string;
  features: string[]; // 'transcript' | 'keyframes' | 'synopsis' | 'ocr' | ...
  supportedMimeTypes: readonly string[];
}

export interface MediaParserConfig {
  providerId: MediaParseProviderId;
  apiKey?: string;
  baseUrl?: string;
  /** Aliyun AccessKey ID (AliDocMind). */
  accessKeyId?: string;
  /** Aliyun AccessKey Secret (AliDocMind). */
  accessKeySecret?: string;
  /**
   * Allow AliDocMind to fall back to ALIDOCMIND_ACCESS_KEY_ID/SECRET env vars.
   * Off by default; enable only in a trusted server/dev/test context.
   */
  allowEnvFallback?: boolean;
}

export interface MediaParseInput {
  buffer: Buffer;
  fileName: string;
  mimeType: string;
  config: MediaParserConfig;
}

export type MediaParseResult = MediaArtifact;
