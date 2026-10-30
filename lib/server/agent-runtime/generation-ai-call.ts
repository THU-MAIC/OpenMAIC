import { buildVisionUserContent, type AICallFn } from '@openmaic/generation';

import { backgroundWorkspaceId } from '@/lib/server/model-config/runtime';
import { callLLM } from '@/lib/ai/llm';
import { MAX_EXTRACT_DOCUMENT_FILE_SIZE_BYTES } from '@/lib/constants/generation';
import { resolveOwnedAsset } from '@/lib/persistence/resolve-server-asset';
import { prepareVisionImages } from '@/lib/server/generation/vision-images';
import type { LlmStage } from '@/lib/server/model-routes';
import { resolveModel } from '@/lib/server/resolve-model';

const CONTENT_TYPES = new Set(['slide', 'quiz', 'interactive', 'pbl']);

export function sceneContentStage(type?: string): LlmStage {
  return type && CONTENT_TYPES.has(type) ? (`scene-content:${type}` as LlmStage) : 'scene-content';
}

/** A page media image as the generation package hands it to `AICallFn`. */
export interface VisionImage {
  id: string;
  src: string;
  width?: number;
  height?: number;
}

/** Read one allocated asset's bytes from its owner's partition. */
export type VisionAssetReader = (
  ownerId: string,
  assetId: string,
  maxByteLength: number,
) => ReturnType<typeof resolveOwnedAsset>;

const readOwnedAsset: VisionAssetReader = (ownerId, assetId, maxByteLength) => {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('Agent runtime requires DATABASE_URL');
  return resolveOwnedAsset(assetId, ownerId, connectionString, maxByteLength);
};

/**
 * Turn page media srcs into inline image bytes for a vision call.
 *
 * A data URL or an HTTP(S) URL passes through. An allocated asset id is read
 * from the run owner's asset partition. An image that does not resolve (no
 * owner, missing, over the size bound, or a failed read) is dropped: the page
 * still generates, from that image's text description alone.
 */
export async function resolveVisionImages(
  images: readonly VisionImage[],
  ownerId: string | undefined,
  readAsset: VisionAssetReader = readOwnedAsset,
): Promise<VisionImage[]> {
  const resolved: VisionImage[] = [];
  for (const image of images) {
    if (/^(?:data:|https?:)/i.test(image.src)) {
      resolved.push(image);
      continue;
    }
    if (!ownerId) continue;
    let resolution: Awaited<ReturnType<VisionAssetReader>>;
    try {
      resolution = await readAsset(ownerId, image.src, MAX_EXTRACT_DOCUMENT_FILE_SIZE_BYTES);
    } catch (error) {
      console.warn(`Vision image "${image.id}" could not be read; dropping it:`, error);
      continue;
    }
    if (resolution.status !== 'resolved') continue;
    resolved.push({
      id: image.id,
      src: `data:${resolution.mimeType};base64,${resolution.buffer.toString('base64')}`,
      ...(image.width !== undefined ? { width: image.width } : {}),
      ...(image.height !== undefined ? { height: image.height } : {}),
    });
  }
  // Bound each inline attachment (dimensions and encoded size), as the
  // classic generation path does.
  return prepareVisionImages(resolved, console);
}

/** The generation package's callback seam, bound to server stage routing. */
export interface GenerationAiCallFactory {
  (stage: LlmStage): AICallFn;
  /** Whether the model routed for `stage` accepts image input. */
  supportsVision(stage: LlmStage): Promise<boolean>;
}

/** Bind the generation package's neutral callback seam to server stage routing. */
export function createGenerationAiCallFactory(options?: {
  abortSignal?: AbortSignal;
  /** Whose model settings apply: the run's session owner. */
  ownerId?: string;
  /** Asset reader for vision images; tests inject one. */
  readAsset?: VisionAssetReader;
}): GenerationAiCallFactory {
  const models = new Map<LlmStage, ReturnType<typeof resolveModel>>();
  const modelFor = (stage: LlmStage) => {
    let model = models.get(stage);
    if (!model) {
      model = (async () =>
        resolveModel({
          stage,
          workspaceId: options?.ownerId ? await backgroundWorkspaceId(options.ownerId) : null,
        }))();
      // A failed resolution is not cached, so the next call retries it.
      model.catch(() => models.delete(stage));
      models.set(stage, model);
    }
    return model;
  };
  const calls = new Map<LlmStage, AICallFn>();
  const factory = ((stage: LlmStage) => {
    const cached = calls.get(stage);
    if (cached) return cached;
    const call: AICallFn = async (systemPrompt, userPrompt, images) => {
      const resolved = await modelFor(stage);
      const visionImages =
        images?.length && resolved.modelInfo?.capabilities?.vision
          ? await resolveVisionImages(images, options?.ownerId, options?.readAsset)
          : [];
      const result = await callLLM(
        {
          model: resolved.model,
          system: systemPrompt,
          ...(visionImages.length
            ? {
                messages: [
                  {
                    role: 'user' as const,
                    content: buildVisionUserContent(userPrompt, visionImages),
                  },
                ],
              }
            : { prompt: userPrompt }),
          maxOutputTokens: resolved.modelInfo?.outputWindow,
          maxRetries: 0,
          abortSignal: options?.abortSignal,
        },
        stage,
        undefined,
        resolved.thinkingConfig,
        { serverManaged: resolved.serverManaged },
      );
      return result.text;
    };
    calls.set(stage, call);
    return call;
  }) as GenerationAiCallFactory;
  factory.supportsVision = async (stage) =>
    !!(await modelFor(stage)).modelInfo?.capabilities?.vision;
  return factory;
}
