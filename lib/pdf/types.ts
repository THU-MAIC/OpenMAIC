/**
 * PDF Parsing Provider Type Definitions
 */

/**
 * PDF Provider IDs
 */
export type PDFProviderId = 'unpdf' | 'mineru' | 'mineru-cloud' | 'alidocmind';

/**
 * PDF Provider Configuration
 */
export interface PDFProviderConfig {
  id: PDFProviderId;
  name: string;
  requiresApiKey: boolean;
  baseUrl?: string;
  icon?: string;
  features: string[]; // ['text', 'images', 'tables', 'formulas', 'layout-analysis', etc.]
}

/**
 * PDF Parser Configuration for API calls
 */
export interface PDFParserConfig {
  providerId: PDFProviderId;
  apiKey?: string;
  baseUrl?: string;
  /** Aliyun AccessKey ID (AliDocMind) */
  accessKeyId?: string;
  /** Aliyun AccessKey Secret (AliDocMind) */
  accessKeySecret?: string;
  /**
   * Allow AliDocMind to fall back to ALIDOCMIND_ACCESS_KEY_ID/SECRET env vars.
   * Off by default; enable only in a trusted server/dev/test context.
   */
  allowEnvFallback?: boolean;
}

// Note: ParsedPdfContent is imported from @/lib/types/pdf to avoid duplication
