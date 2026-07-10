export type DocumentExtractorProviderId = string;

export interface DocumentExtractorCapabilities {
  text: boolean;
  images: boolean;
  tables: boolean;
  formulas: boolean;
  layout: boolean;
  ocr: boolean;
  async: boolean;
}

export interface DocumentExtractorConfig {
  providerId: DocumentExtractorProviderId;
  apiKey?: string;
  baseUrl?: string;
  /** Aliyun AccessKey ID (AliDocMind). */
  accessKeyId?: string;
  /** Aliyun AccessKey Secret (AliDocMind). */
  accessKeySecret?: string;
  /** Allow AliDocMind to use server env credentials (trusted context only). */
  allowEnvFallback?: boolean;
}

export interface DocumentExtractorInput {
  buffer: Buffer;
  fileName?: string;
  fileSize?: number;
  mimeType: string;
  config: DocumentExtractorConfig;
}

export interface DocumentExtractorProvider {
  id: DocumentExtractorProviderId;
  displayName: string;
  supportedMimeTypes: readonly string[];
  capabilities: DocumentExtractorCapabilities;
  extract(input: DocumentExtractorInput): Promise<DocumentArtifact>;
}

/**
 * Media extractor — symmetric to DocumentExtractorProvider but for audio/video.
 * Returns MediaArtifact (timestamp-anchored transcript + keyframes).
 */
export type MediaExtractorProviderId = string;

export interface MediaExtractorCapabilities {
  transcript: boolean;
  keyframes: boolean;
  synopsis: boolean;
  ocr: boolean;
  async: boolean;
}

export interface MediaExtractorInput {
  buffer: Buffer;
  fileName?: string;
  fileSize?: number;
  mimeType: string;
  config: DocumentExtractorConfig;
}

export interface MediaExtractorProvider {
  id: MediaExtractorProviderId;
  displayName: string;
  supportedMimeTypes: string[];
  capabilities: MediaExtractorCapabilities;
  extract(input: MediaExtractorInput): Promise<MediaArtifact>;
}

export type DocumentBlockType = 'text' | 'markdown' | 'image' | 'table' | 'formula' | 'layout';

export interface DocumentBlock {
  id: string;
  type: DocumentBlockType;
  text?: string;
  html?: string;
  pageNumber?: number;
  bbox?: { x: number; y: number; width: number; height: number };
  metadata?: Record<string, unknown>;
}

export interface DocumentAsset {
  id: string;
  type: 'image' | 'file';
  mimeType?: string;
  data?: string;
  pageNumber?: number;
  description?: string;
  width?: number;
  height?: number;
  metadata?: Record<string, unknown>;
}

export interface DocumentCitation {
  id: string;
  blockId?: string;
  assetId?: string;
  pageNumber?: number;
  label?: string;
  metadata?: Record<string, unknown>;
}

export interface DocumentDiagnostic {
  severity: 'info' | 'warning' | 'error';
  message: string;
  providerId?: string;
  metadata?: Record<string, unknown>;
}

export interface DocumentArtifact {
  metadata: {
    fileName?: string;
    fileSize?: number;
    mimeType?: string;
    pageCount?: number;
    providerId?: string;
    processingTime?: number;
  };
  blocks: DocumentBlock[];
  assets: DocumentAsset[];
  citations?: DocumentCitation[];
  diagnostics?: DocumentDiagnostic[];
  providerRaw?: unknown;
}

export interface MediaTranscriptSegment {
  id: string;
  startMs: number;
  endMs: number;
  text: string;
  speaker?: string;
  confidence?: number;
  metadata?: Record<string, unknown>;
}

export interface MediaKeyframe {
  id: string;
  timeMs: number;
  assetId?: string;
  ocrText?: string;
  description?: string;
  metadata?: Record<string, unknown>;
}

export interface MediaArtifact {
  metadata: {
    fileName?: string;
    fileSize?: number;
    mimeType?: string;
    durationMs?: number;
    providerId?: string;
    processingTime?: number;
  };
  transcript?: MediaTranscriptSegment[];
  keyframes?: MediaKeyframe[];
  assets?: DocumentAsset[];
  diagnostics?: DocumentDiagnostic[];
  providerRaw?: unknown;
}

export type ExtractionArtifact = DocumentArtifact | MediaArtifact;

export interface ExtractionError {
  code: string;
  message: string;
  providerId?: string;
  retryable?: boolean;
  metadata?: Record<string, unknown>;
}

export type ExtractionResult =
  | {
      status: 'succeeded';
      artifact: ExtractionArtifact;
      diagnostics?: DocumentDiagnostic[];
    }
  | {
      status: 'failed';
      error: ExtractionError;
      diagnostics?: DocumentDiagnostic[];
    };

export interface ExtractionJob {
  id: string;
  status: 'pending' | 'running' | 'succeeded' | 'failed';
  createdAt: string;
  updatedAt: string;
  result?: ExtractionResult;
  providerId?: string;
  metadata?: Record<string, unknown>;
}
