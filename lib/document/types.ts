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
