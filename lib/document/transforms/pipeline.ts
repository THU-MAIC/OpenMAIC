import type { DocumentArtifact, DocumentDiagnostic, DocumentTransformRecord } from '../types';
import type {
  DocumentTransform,
  DocumentTransformContext,
  DocumentTransformPipelineOptions,
  DocumentTransformResult,
} from './types';
import { cloneDocumentArtifact, documentTextLength, throwIfAborted } from './utils';

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

export async function transformDocument(
  artifact: DocumentArtifact,
  transforms: readonly DocumentTransform[],
  context: DocumentTransformContext,
  options: DocumentTransformPipelineOptions = {},
): Promise<DocumentTransformResult> {
  const pipelineStartedAt = Date.now();
  const inputChars = documentTextLength(artifact);
  const inputAssets = artifact.assets.length;
  const failurePolicy = options.failurePolicy ?? 'fail-fast';
  const pipelineDiagnostics: DocumentDiagnostic[] = [];
  let current = cloneDocumentArtifact(artifact);
  throwIfAborted(context.signal);

  for (const transform of transforms) {
    throwIfAborted(context.signal);
    const stepStartedAt = new Date();
    const inputBlockCount = current.blocks.length;
    const inputAssetCount = current.assets.length;
    const priorTransforms = current.transforms ?? [];
    const priorDiagnostics = current.diagnostics ?? [];
    const recordId = `${transform.id}:${priorTransforms.length + 1}`;

    try {
      const output = await transform.apply(cloneDocumentArtifact(current), context);
      throwIfAborted(context.signal);
      const diagnostics = output.diagnostics ?? [];
      const record: DocumentTransformRecord = {
        id: recordId,
        transformId: transform.id,
        version: transform.version,
        status: output.status ?? 'applied',
        startedAt: stepStartedAt.toISOString(),
        completedAt: new Date().toISOString(),
        inputBlockCount,
        outputBlockCount: output.artifact.blocks.length,
        inputAssetCount,
        outputAssetCount: output.artifact.assets.length,
        options:
          typeof context.options?.[transform.id] === 'object' && context.options[transform.id]
            ? (context.options[transform.id] as Record<string, unknown>)
            : undefined,
        diagnostics,
      };

      current = cloneDocumentArtifact(output.artifact);
      current.transforms = [...priorTransforms, record];
      current.diagnostics = [...priorDiagnostics, ...diagnostics];
      pipelineDiagnostics.push(...diagnostics);
    } catch (error) {
      if (isAbortError(error)) throw error;

      const message = error instanceof Error ? error.message : String(error);
      const diagnostic: DocumentDiagnostic = {
        severity: 'error',
        message: `Document transform "${transform.id}" failed: ${message}`,
        metadata: { transformId: transform.id },
      };
      const failedRecord: DocumentTransformRecord = {
        id: recordId,
        transformId: transform.id,
        version: transform.version,
        status: 'failed',
        startedAt: stepStartedAt.toISOString(),
        completedAt: new Date().toISOString(),
        inputBlockCount,
        outputBlockCount: current.blocks.length,
        inputAssetCount,
        outputAssetCount: current.assets.length,
        diagnostics: [diagnostic],
      };
      current.transforms = [...(current.transforms ?? []), failedRecord];
      current.diagnostics = [...(current.diagnostics ?? []), diagnostic];
      pipelineDiagnostics.push(diagnostic);

      if (failurePolicy === 'fail-fast') throw error;
    }
  }

  return {
    artifact: current,
    diagnostics: pipelineDiagnostics,
    metrics: {
      inputChars,
      outputChars: documentTextLength(current),
      inputAssets,
      outputAssets: current.assets.length,
      durationMs: Date.now() - pipelineStartedAt,
    },
  };
}
