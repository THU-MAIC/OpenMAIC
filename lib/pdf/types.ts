/**
 * PDF Parsing Provider Type Definitions
 */

/**
 * PDF Provider IDs
 */
export type PDFProviderId = 'unpdf' | 'mineru' | 'mineru-cloud' | 'alidocmind' | 'minicpm-ocr';

/**
 * PDF Provider Configuration
 */
export interface PDFProviderConfig {
  id: PDFProviderId;
  name: string;
  requiresApiKey: boolean;
  /** Authenticates with a key pair (`credentials`) rather than one API key. */
  requiresCredentials?: boolean;
  baseUrl?: string;
  icon?: string;
  features: string[]; // ['text', 'images', 'tables', 'formulas', 'layout-analysis', etc.]
  /**
   * The provider offers a hosted API that takes a key and a self-hosted
   * deployment that usually takes none: with an explicit `baseUrl` the key is
   * optional, and without one the hosted API's key is required.
   */
  apiKeyOptionalWithBaseUrl?: boolean;
  /**
   * Legacy environment variables (`<prefix>_API_KEY`, `<prefix>_BASE_URL`).
   * Keeping the mapping here lets the neutral provider loader derive its env
   * map and activation rules without naming any vendor.
   */
  legacyEnv?: {
    prefix: string;
    /** A key alone activates the provider: it has a usable default endpoint. */
    baseUrlOptional?: boolean;
    /** A base URL alone activates the provider without a key (self-hosted). */
    keyless?: boolean;
  };
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
  /** Skip image extraction when the caller needs text only. */
  textOnly?: boolean;
  /**
   * The base URL is server configuration, not caller input: it may reach a
   * local network without ALLOW_LOCAL_NETWORKS (cloud metadata stays refused).
   */
  managed?: boolean;
  /**
   * The caller stopped waiting (a deleted material, a deadline, shutdown): the
   * extractor aborts its requests, polls and commands and rejects.
   */
  signal?: AbortSignal;
}

// Note: ParsedPdfContent is imported from @/lib/types/pdf to avoid duplication
