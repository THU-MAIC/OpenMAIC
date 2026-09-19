import type { DocumentArtifact, DocumentDiagnostic } from '../types';

export type DocumentTransformPurpose = 'course-generation' | 'question-bank' | 'reference' | 'rag';

export interface DocumentTransformContext {
  purpose: DocumentTransformPurpose;
  requirement?: string;
  budget: {
    maxTextChars: number;
    maxVisionImages: number;
    maxSummaryOutputTokens?: number;
  };
  ai?: {
    textModel?: string;
    visionModel?: string;
  };
  signal?: AbortSignal;
  options?: Record<string, unknown>;
}

export interface DocumentTransformCapabilities {
  requiresTextModel?: boolean;
  requiresVisionModel?: boolean;
  supportsSelection?: boolean;
}

export interface DocumentTransformOutput {
  artifact: DocumentArtifact;
  diagnostics?: DocumentDiagnostic[];
  status?: 'applied' | 'skipped' | 'partial';
}

export interface DocumentTransform {
  id: string;
  displayName: string;
  version: string;
  capabilities: DocumentTransformCapabilities;
  apply(
    artifact: DocumentArtifact,
    context: DocumentTransformContext,
  ): Promise<DocumentTransformOutput> | DocumentTransformOutput;
}

export interface DocumentTransformMetrics {
  inputChars: number;
  outputChars: number;
  inputAssets: number;
  outputAssets: number;
  durationMs: number;
}

export interface DocumentTransformResult {
  artifact: DocumentArtifact;
  diagnostics: DocumentDiagnostic[];
  metrics: DocumentTransformMetrics;
}

export interface DocumentTransformPipelineOptions {
  failurePolicy?: 'fail-fast' | 'best-effort';
}
