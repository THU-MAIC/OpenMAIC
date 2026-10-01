/**
 * Outline: plan a course's scenes from the requirements, the material and
 * the research, streaming each scene outline as the model writes it. Moved
 * from POST /api/generate/scene-outlines-stream, which keeps resolving the
 * model and turning the step's events into its server-sent event stream.
 *
 * Interactive mode and the server-enabled task engine mode keep their own
 * prompt templates; standard generation is byte-identical to the generation
 * package's outline prompt. The stream is retried on the same model, then
 * once on the stage's fallback model, and every retry is reported as an event.
 */
import { attachedModelFallback } from '@/lib/ai/model-fallbacks';
import { streamLLM } from '@/lib/ai/llm';
import {
  resolveFallbackModel,
  shouldFallbackFor,
  logFallbackFired,
} from '@/lib/server/llm-fallback';
import { buildPrompt, PROMPT_IDS } from '@/lib/prompts';
import {
  formatImageDescription,
  formatImagePlaceholder,
  buildVisionUserContent,
  buildOutlinePrompt,
  uniquifyMediaElementIds,
  formatTeacherPersonaForPrompt,
} from '@openmaic/generation';
import type { AgentInfo } from '@openmaic/generation';
import { DEFAULT_LANGUAGE_DIRECTIVE } from '@openmaic/generation';
import { MAX_PDF_CONTENT_CHARS, MAX_VISION_IMAGES } from '@/lib/constants/generation';
import { nanoid } from 'nanoid';
import type {
  UserRequirements,
  PdfImage,
  SceneOutline,
  ImageMapping,
} from '@/lib/types/generation';
import { resolveServerGenerationCapabilities } from '@/lib/server/generation-capabilities';
import { sortDocumentImagesForVision } from '@/lib/document/bundle';
import { resolveVocationalActive } from '@/lib/config/feature-flags';

import {
  StepAbortedError,
  StepRefusal,
  type OwnerStepContext,
  type StepContext,
  type StepLanguageModel,
  type WorkspaceStepContext,
} from './context';

const MAX_STREAM_RETRIES = 2;
// Hard ceiling on the accumulated stream buffer. Legitimate outline JSON is
// small (tens of KB); anything past this is a runaway/degenerate generation
// and must not be allowed to grow the heap unbounded.
const MAX_OUTLINE_STREAM_BYTES = 512 * 1024;

/**
 * Extract the languageDirective from the streamed wrapper JSON.
 * Matches `"languageDirective":"<value>"` in partial JSON like:
 *   {"languageDirective":"Teach in English...","outlines":[...
 */
function extractLanguageDirective(buffer: string): string | null {
  // The directive is the first key of the wrapper object, so it can only ever
  // appear in the head of the buffer. Bound the scan to keep this O(1) per
  // streamed chunk — it is called on the full, growing buffer on every chunk,
  // which is otherwise O(n²) over the stream.
  const head = buffer.length > 8192 ? buffer.slice(0, 8192) : buffer;
  const match = head.match(/"languageDirective"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (!match) return null;
  try {
    return JSON.parse(`"${match[1]}"`);
  } catch {
    return match[1];
  }
}

/**
 * Extract the courseTitle from the streamed wrapper JSON.
 * Same head-bound scan as `extractLanguageDirective` — the title is a
 * top-level key near the start of the wrapper object, so it only appears in
 * the buffer head. Returns the decoded title, or null if not yet streamed.
 */
const COURSE_TITLE_RE = /"courseTitle"\s*:\s*"((?:[^"\\]|\\.)*)"/;

// Normalize a captured title identically to the non-streaming parser
// (@openmaic/generation outline parser): ignore whitespace-only titles and cap
// length defensively so a hallucinating model cannot push a blank or unbounded
// value into the stage name. Returning null lets callers fall back / keep scanning.
function normalizeStreamedTitle(raw: string): string | null {
  let title: string;
  try {
    title = JSON.parse(`"${raw}"`);
  } catch {
    title = raw;
  }
  const normalized = title.trim();
  return normalized ? normalized.slice(0, 120) : null;
}

function extractCourseTitle(buffer: string): string | null {
  const head = buffer.length > 8192 ? buffer.slice(0, 8192) : buffer;
  const match = head.match(COURSE_TITLE_RE);
  return match ? normalizeStreamedTitle(match[1]) : null;
}

/**
 * Full-buffer fallback, run once after the stream completes: recovers a title
 * the model emitted after the `outlines` array or beyond the 8KB head window —
 * cases the head-bound `extractCourseTitle` scan would miss. Only invoked when
 * the streaming scan produced nothing, so the extra full-buffer regex is paid once.
 */
function extractCourseTitleFromComplete(buffer: string): string | null {
  const match = buffer.match(COURSE_TITLE_RE);
  return match ? normalizeStreamedTitle(match[1]) : null;
}

/**
 * Incremental JSON array parser.
 * Extracts complete top-level objects from a partially-streamed JSON array,
 * resuming from `scanFrom` (an index into `buffer`) so the growing buffer is
 * scanned only ONCE across the whole stream — O(n) total instead of O(n²).
 * Supports both a flat array `[{...},{...}]` and a wrapper object
 * `{"languageDirective":"...","outlines":[{...},{...}]}`, with or without a
 * markdown ```json fence (the array is located by content, not by stripping).
 * Returns newly found objects plus the index to resume scanning from next time.
 */
function extractNewOutlines(
  buffer: string,
  scanFrom: number,
): { outlines: SceneOutline[]; scanFrom: number } {
  const results: SceneOutline[] = [];

  let i: number;
  if (scanFrom > 0) {
    // Resume just past the last fully-parsed object (between array elements,
    // so not inside a string and at brace depth 0).
    i = scanFrom;
  } else {
    // Locate the outlines array opening once.
    const outlinesKeyIdx = buffer.indexOf('"outlines"');
    const arrayStart =
      outlinesKeyIdx >= 0 ? buffer.indexOf('[', outlinesKeyIdx) : buffer.indexOf('[');
    if (arrayStart === -1) return { outlines: results, scanFrom: 0 };
    i = arrayStart + 1;
  }

  let depth = 0;
  let objectStart = -1;
  let inString = false;
  let escaped = false;
  let consumed = i; // index just past the last fully-parsed object

  for (; i < buffer.length; i++) {
    const char = buffer[i];

    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\' && inString) {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (char === '{') {
      if (depth === 0) objectStart = i;
      depth++;
    } else if (char === '}') {
      depth--;
      if (depth === 0 && objectStart >= 0) {
        try {
          results.push(JSON.parse(buffer.substring(objectStart, i + 1)));
        } catch {
          // Incomplete or invalid JSON — skip
        }
        objectStart = -1;
        consumed = i + 1;
      }
    }
  }

  return { outlines: results, scanFrom: consumed };
}

function normalizeTaskEngineProceduralOutline(
  outline: SceneOutline,
  requirement: string,
): SceneOutline {
  const widgetOutline = outline.widgetOutline ?? {};

  return {
    ...outline,
    type: 'interactive',
    widgetType: 'procedural-skill',
    widgetOutline: {
      ...widgetOutline,
      procedureType: widgetOutline.procedureType ?? 'inspection',
      task: widgetOutline.task || requirement,
      tools:
        widgetOutline.tools && widgetOutline.tools.length > 0
          ? widgetOutline.tools
          : ['required PPE', 'task checklist'],
      steps:
        widgetOutline.steps && widgetOutline.steps.length > 0
          ? widgetOutline.steps
          : ['Confirm task conditions', 'Select required tools', 'Complete safety check'],
      successCriteria:
        widgetOutline.successCriteria && widgetOutline.successCriteria.length > 0
          ? widgetOutline.successCriteria
          : ['Required checks completed', 'Unsafe conditions are not ignored'],
      errorConsequences:
        widgetOutline.errorConsequences && widgetOutline.errorConsequences.length > 0
          ? widgetOutline.errorConsequences
          : ['Unsafe or incorrect actions require stopping and rechecking'],
    },
  };
}

function normalizeTaskEngineSlideOutline(outline: SceneOutline): SceneOutline {
  const normalized: SceneOutline = {
    ...outline,
    type: 'slide',
  };
  delete normalized.widgetType;
  delete normalized.widgetOutline;
  delete normalized.interactiveConfig;
  return normalized;
}

const ORDINARY_WIDGET_TYPES = new Set(['simulation', 'diagram', 'code', 'game', 'visualization3d']);

function normalizeTaskEngineOutline(outline: SceneOutline, requirement: string): SceneOutline {
  if (outline.type === 'slide') {
    return normalizeTaskEngineSlideOutline(outline);
  }

  if (outline.type === 'interactive' && outline.widgetType === 'procedural-skill') {
    return normalizeTaskEngineProceduralOutline(outline, requirement);
  }

  if (
    outline.type === 'interactive' &&
    outline.widgetType &&
    ORDINARY_WIDGET_TYPES.has(outline.widgetType)
  ) {
    return outline;
  }

  return normalizeTaskEngineSlideOutline(outline);
}

function sanitizeNonTaskEngineOutline(outline: SceneOutline): SceneOutline {
  if (outline.widgetType !== 'procedural-skill') {
    return outline;
  }

  const widgetOutline = { ...(outline.widgetOutline ?? {}) };
  delete widgetOutline.procedureType;
  delete widgetOutline.task;
  delete widgetOutline.tools;
  delete widgetOutline.steps;
  delete widgetOutline.successCriteria;
  delete widgetOutline.errorConsequences;

  // procedural-skill is gated behind taskEngineMode to protect ordinary MAIC generation.
  return {
    ...outline,
    type: 'interactive',
    widgetType: 'diagram',
    description: outline.description
      ? `${outline.description} Present this as a process or structure diagram.`
      : 'Present this topic as a process or structure diagram.',
    widgetOutline,
  };
}

function ensureUniqueOutlineId(outline: SceneOutline, usedIds: Set<string>): SceneOutline {
  const candidate = typeof outline.id === 'string' && outline.id.trim() ? outline.id : undefined;
  if (candidate && !usedIds.has(candidate)) {
    usedIds.add(candidate);
    return outline;
  }

  let id = nanoid();
  while (usedIds.has(id)) {
    id = nanoid();
  }
  usedIds.add(id);
  return { ...outline, id };
}

export interface OutlineInput {
  requirements: UserRequirements;
  pdfText?: string;
  pdfImages?: PdfImage[];
  imageMapping?: ImageMapping;
  researchContext?: string;
  agents?: AgentInfo[];
  /** The scene-outlines-stream stage's model. */
  model: StepLanguageModel;
  /**
   * Whether the outline may plan generated images and videos, as far as the
   * caller is concerned (default true). It only opts out: the workspace's
   * image and video slots decide whether media is offered at all.
   */
  allowImageGeneration?: boolean;
  allowVideoGeneration?: boolean;
}

/** The prompts and attachments one outline generation streams from. */
export interface PreparedOutline {
  model: StepLanguageModel;
  requirement: string;
  taskEngineMode: boolean;
  prompts: { system: string; user: string };
  /** The images attached to the prompt, resolved to data URLs or concrete URLs. */
  visionImages?: Array<{ id: string; src: string; width?: number; height?: number }>;
}

/** What the outline step reports while the model writes. */
export type OutlineEvent =
  | { type: 'languageDirective'; data: string }
  | { type: 'courseTitle'; data: string }
  | { type: 'outline'; data: SceneOutline; index: number }
  /** A retry of the stream; `fallback` names the fallback model when it switched to one. */
  | { type: 'retry'; attempt: number; maxAttempts: number; fallback?: string };

export interface OutlineResult {
  outlines: SceneOutline[];
  languageDirective: string;
  courseTitle: string | undefined;
  taskEngineMode: boolean;
}

export type OutlineRefusal = 'prompt-unavailable';

/** Every attempt failed to produce an outline; the message is the last failure. */
export class OutlineGenerationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OutlineGenerationError';
  }
}

/**
 * Build the outline prompts: resolve the vision images, read whether the
 * slots offer media, and pick the template for the mode.
 */
export async function prepareOutline(
  input: OutlineInput,
  ctx: OwnerStepContext & WorkspaceStepContext,
): Promise<PreparedOutline> {
  const { requirements, pdfText, pdfImages, imageMapping, researchContext, agents, model } = input;
  const { modelInfo, modelString } = model;

  // Build user profile string for language inference context
  const userProfileText =
    requirements.userNickname || requirements.userBio
      ? `## Student Profile\n\nStudent: ${requirements.userNickname || 'Unknown'}${requirements.userBio ? ` — ${requirements.userBio}` : ''}\n\nConsider this student's background when designing the course. Adapt difficulty, examples, and teaching approach accordingly.\n\n---`
      : '';

  // Detect vision capability
  const hasVision = !!modelInfo?.capabilities?.vision;

  // Build prompt (same logic as generateSceneOutlinesFromRequirements)
  let availableImagesText = 'No images available';
  let visionImages: PreparedOutline['visionImages'];
  // N3: the RESOLVED slice, threaded into the standard buildOutlinePrompt
  // branch below. The vision resolution drops images the server cannot
  // resolve; the standard branch must rebuild its placeholder text from the
  // same resolved set so a dropped image drops its text mention AND its
  // attachment there too.
  let resolvedPdfImages: PdfImage[] | undefined;
  let resolvedImageMapping: ImageMapping | undefined;

  if (pdfImages && pdfImages.length > 0) {
    if (hasVision && imageMapping) {
      // Vision mode: split into vision images (first N) and text-only (rest)
      const sortedImages = sortDocumentImagesForVision(pdfImages);
      const allWithSrc = sortedImages.filter((img) => imageMapping[img.id]);
      const visionSlice = allWithSrc.slice(0, MAX_VISION_IMAGES);
      const textOnlySlice = allWithSrc.slice(MAX_VISION_IMAGES);
      const noSrcImages = sortedImages.filter((img) => !imageMapping[img.id]);

      // Server-backed transport: `imageMapping` values are allocated asset
      // ids, so the vision srcs reach here as ids. Resolve them to the same
      // bytes the base64 path would send BEFORE prompt assembly, keeping the
      // vision prompt byte-identical in both modes (RFC #1153 part 2 B). An
      // id the server cannot resolve is dropped here, so the placeholder
      // text below never promises an image that will not be attached.
      const resolvedVisionImages = await ctx.resolveVisionImages(
        visionSlice.map((img) => ({
          id: img.id,
          src: imageMapping[img.id],
          ...(img.width !== undefined ? { width: img.width } : {}),
          ...(img.height !== undefined ? { height: img.height } : {}),
        })),
      );
      const resolvedIds = new Set(resolvedVisionImages.map((img) => img.id));
      const visionImageById = new Map(sortedImages.map((img) => [img.id, img] as const));
      const visionDescriptions = resolvedVisionImages.map((img) =>
        formatImagePlaceholder(visionImageById.get(img.id) ?? { ...img, pageNumber: 1, src: '' }),
      );
      const textDescriptions = [...textOnlySlice, ...noSrcImages].map((img) =>
        formatImageDescription(img),
      );
      availableImagesText = [...visionDescriptions, ...textDescriptions].join('\n');

      visionImages = resolvedVisionImages.map((img) => ({
        id: img.id,
        src: img.src,
        ...(img.width !== undefined ? { width: img.width } : {}),
        ...(img.height !== undefined ? { height: img.height } : {}),
      }));

      // N3: the standard branch (buildOutlinePrompt) rebuilds its own
      // placeholder text from pdfImages × imageMapping — feed it the RESOLVED
      // set: unresolvable vision images removed from the slice and a mapping
      // naming only the resolved ids, so its `[see attached]` promises match
      // the attachments this step attaches exactly.
      const visionSliceIds = new Set(visionSlice.map((img) => img.id));
      resolvedPdfImages = pdfImages.filter(
        (img) => !visionSliceIds.has(img.id) || resolvedIds.has(img.id),
      );
      resolvedImageMapping = Object.fromEntries(
        Object.entries(imageMapping).filter(([id]) => resolvedIds.has(id)),
      );
      // Shift-in is IMPOSSIBLE here by construction (unlike the scene-content
      // step's re-slice): `visionImages` — the ONLY attachments this step
      // sends — IS the resolved slice, resolved once from the original
      // `visionSlice` and never re-sliced, so a dropped image admits NO new
      // image into the attachments; and `resolvedImageMapping` names only
      // the resolved slice's ids, so the standard branch's `[see attached]`
      // text matches the attachments exactly (images beyond the slice and
      // no-src images keep plain descriptions because their mapping entries
      // are stripped).
    } else {
      // Text-only mode: full descriptions
      availableImagesText = pdfImages.map((img) => formatImageDescription(img)).join('\n');
    }
  }

  // Build media snippet conditions based on enabled flags.
  // The workspace's image and video slots decide whether the outline may
  // plan media (the same facts the generation pipeline and the capabilities
  // endpoint read). The caller may still opt out; it never turns on what the
  // slots do not offer.
  const capabilities = await resolveServerGenerationCapabilities(ctx.workspaceId);
  const imageGenerationEnabled =
    capabilities.imageGeneration && input.allowImageGeneration !== false;
  const videoGenerationEnabled =
    capabilities.videoGeneration && input.allowVideoGeneration !== false;
  const mediaGenerationEnabled = imageGenerationEnabled || videoGenerationEnabled;
  const hasSourceImages = (pdfImages?.length ?? 0) > 0;

  // Build teacher context from agents (if available)
  const teacherContext = formatTeacherPersonaForPrompt(agents);

  // Check if Interactive Mode or server-enabled Task Engine mode is enabled.
  const interactiveMode = requirements.interactiveMode ?? false;
  const taskEngineMode = resolveVocationalActive(requirements);
  // Standard outline generation is byte-identical to the package path. The
  // two app-only modes retain their own templates but share the same inputs.
  // The standard branch receives the N3 RESOLVED slice (unresolvable vision
  // images removed, mapping naming only resolved ids) so its placeholder
  // text never promises an image this step will not attach.
  let prompts: { system: string; user: string } | null = buildOutlinePrompt(requirements, {
    pdfText,
    pdfImages: resolvedPdfImages ?? pdfImages,
    visionEnabled: hasVision,
    imageMapping: resolvedImageMapping ?? imageMapping,
    imageGenerationEnabled,
    videoGenerationEnabled,
    researchContext,
    teacherContext,
  });

  if (taskEngineMode || interactiveMode) {
    const promptId = taskEngineMode
      ? PROMPT_IDS.TASK_ENGINE_OUTLINES
      : PROMPT_IDS.INTERACTIVE_OUTLINES;
    prompts = buildPrompt(promptId, {
      requirement: requirements.requirement,
      pdfContent: pdfText ? pdfText.substring(0, MAX_PDF_CONTENT_CHARS) : 'None',
      availableImages: availableImagesText,
      researchContext: researchContext || 'None',
      hasSourceImages,
      imageEnabled: imageGenerationEnabled,
      videoEnabled: videoGenerationEnabled,
      mediaEnabled: mediaGenerationEnabled,
      teacherContext,
      userProfile: userProfileText,
    });
  }

  if (!prompts) {
    throw new StepRefusal<OutlineRefusal>('prompt-unavailable', 'Prompt template not found');
  }

  ctx.log.info(
    `Generating outlines: "${requirements.requirement.substring(0, 50)}" [model=${modelString}]`,
  );

  return {
    model,
    requirement: requirements.requirement,
    taskEngineMode,
    prompts,
    ...(visionImages ? { visionImages } : {}),
  };
}

/**
 * Stream the outline generation: report the language directive, the course
 * title and each outline as they appear, retry an empty or failed stream, and
 * return the outlines, or throw OutlineGenerationError when every attempt
 * failed (StepAbortedError when the caller went away).
 */
export async function streamOutlines(
  prepared: PreparedOutline,
  ctx: StepContext<OutlineEvent>,
): Promise<OutlineResult> {
  const { model, prompts, visionImages, taskEngineMode, requirement } = prepared;
  const { model: languageModel, modelInfo, thinkingConfig } = model;
  const { log, signal } = ctx;
  const emit = (event: OutlineEvent) => ctx.emit?.(event);

  // Retryable-failure fallback: after the same-model retries are
  // exhausted, retry once on the stage's configured fallback model.
  let streamParams = visionImages?.length
    ? {
        model: languageModel,
        system: prompts.system,
        messages: [
          {
            role: 'user' as const,
            content: buildVisionUserContent(prompts.user, visionImages),
          },
        ],
        maxOutputTokens: modelInfo?.outputWindow,
        // Tear down the upstream LLM request when the caller goes away,
        // instead of letting it run to completion for nobody.
        abortSignal: signal,
      }
    : {
        model: languageModel,
        system: prompts.system,
        prompt: prompts.user,
        maxOutputTokens: modelInfo?.outputWindow,
        abortSignal: signal,
      };
  let fellBack = false;
  // Shared decision (shared retryable-error + empty-output check) and the
  // shared log line live in lib/server/llm-fallback.ts — one place, same
  // semantics as the non-streaming callLLM path.
  const maybeFallback = async (error: unknown, text?: string): Promise<boolean> => {
    if (fellBack) return false;
    // The fallback only protects primaries the SERVER resolved (routed
    // stage or server-configured provider). A client-supplied x-model
    // with a garbage key must never be allowed to burn the operator's
    // fallback key by failing on purpose.
    if (!model.serverManaged) return false;
    if (!shouldFallbackFor(error, text)) return false;
    let fallback: Awaited<ReturnType<typeof resolveFallbackModel>>;
    try {
      // The slot's own fallback when the model came from a slot.
      const attached = attachedModelFallback(languageModel);
      fallback = attached ? await attached() : await resolveFallbackModel();
    } catch {
      // Misconfigured fallback provider — keep the real error instead of
      // surfacing e.g. "API key required for provider: …" to the caller.
      return false;
    }
    if (!fallback) return false;
    streamParams = { ...streamParams, model: fallback.model };
    fellBack = true;
    logFallbackFired(
      'scene-outlines-stream',
      error !== undefined ? 'retryable failure' : 'empty output',
      model.modelString ?? '?',
      fallback.modelString,
    );
    emit({
      type: 'retry',
      attempt: MAX_STREAM_RETRIES + 1,
      maxAttempts: MAX_STREAM_RETRIES + 1,
      fallback: fallback.modelString,
    });
    return true;
  };

  let parsedOutlines: SceneOutline[] = [];
  let languageDirective: string | null = null;
  let courseTitle: string | null = null;
  let lastError: string | undefined;

  for (
    let attempt = 1;
    attempt <= MAX_STREAM_RETRIES + 1 && !(fellBack && attempt > 1);
    attempt++
  ) {
    try {
      let fullText = '';
      let scanFrom = 0;
      parsedOutlines = [];
      languageDirective = null;
      courseTitle = null;
      const usedOutlineIds = new Set<string>();
      // Consume the FULL stream, not just textStream: errors that
      // happen before the stream starts (a 401, an invalid key) and
      // the finish reason (content-filter) are surfaced as stream
      // parts, NOT as throws — with textStream alone they silently
      // look like an empty response and would reach the empty-output
      // fallback path.
      let streamError: unknown = undefined;
      let finishReason: string | undefined = undefined;
      // This step retries and falls back itself (maybeFallback).
      const fullStream = streamLLM(streamParams, 'scene-outlines-stream', thinkingConfig, {
        enabled: false,
      }).fullStream;

      for await (const part of fullStream) {
        // Stop doing work the moment the caller goes away — otherwise
        // generation keeps running and buffering for nobody.
        if (signal?.aborted) throw new StepAbortedError();

        if (part.type === 'error') {
          streamError = part.error;
          continue;
        }
        if (part.type === 'finish') {
          finishReason = part.finishReason;
          continue;
        }
        if (part.type !== 'text-delta') continue;
        const chunk = part.text;

        fullText += chunk;

        if (fullText.length > MAX_OUTLINE_STREAM_BYTES) {
          log.warn(
            `Outline stream exceeded ${MAX_OUTLINE_STREAM_BYTES} bytes (len=${fullText.length}); stopping read and finalizing with ${parsedOutlines.length} outline(s)`,
          );
          break;
        }

        // Try to extract language directive early
        if (!languageDirective) {
          languageDirective = extractLanguageDirective(fullText);
          if (languageDirective) emit({ type: 'languageDirective', data: languageDirective });
        }

        // Try to extract course title early (same pattern as languageDirective)
        if (!courseTitle) {
          courseTitle = extractCourseTitle(fullText);
          if (courseTitle) emit({ type: 'courseTitle', data: courseTitle });
        }

        // Try to extract new outlines from the accumulated text,
        // resuming the scan from where the previous chunk left off.
        const { outlines: newOutlines, scanFrom: nextScanFrom } = extractNewOutlines(
          fullText,
          scanFrom,
        );
        scanFrom = nextScanFrom;
        for (const outline of newOutlines) {
          // Ensure ID and order
          const enrichedBase = {
            ...outline,
            order: parsedOutlines.length + 1,
          };
          const normalized = taskEngineMode
            ? normalizeTaskEngineOutline(enrichedBase, requirement)
            : sanitizeNonTaskEngineOutline(enrichedBase);
          const enriched = ensureUniqueOutlineId(normalized, usedOutlineIds);
          parsedOutlines.push(enriched);
          emit({ type: 'outline', data: enriched, index: parsedOutlines.length - 1 });
        }
      }

      // Validate: got outlines?
      if (parsedOutlines.length > 0) {
        if (!courseTitle) {
          // The head-bound streaming scan can miss a title the model
          // placed after the outlines array or past the 8KB head window;
          // recover it from the now-complete response before finalizing.
          courseTitle = extractCourseTitleFromComplete(fullText);
        }
        break;
      }

      // Classify before treating anything as an "empty output": a
      // stream error (a 401 that failed before the stream started) is
      // a real failure that must surface to the caller, and a
      // content-filter finish is a safety refusal — neither may reach
      // the empty-output fallback path.
      if (streamError !== undefined) {
        lastError = streamError instanceof Error ? streamError.message : String(streamError);
        log.warn(
          `Outlines attempt ${attempt} stream error: ${lastError}, finishReason=${finishReason ?? 'none'}`,
        );

        if (attempt <= MAX_STREAM_RETRIES) {
          emit({ type: 'retry', attempt, maxAttempts: MAX_STREAM_RETRIES + 1 });
          continue;
        }

        // Same-model retries exhausted: retry once on the fallback
        // model when the failure is retryable.
        if (await maybeFallback(streamError)) {
          attempt = 0;
          continue;
        }
      } else if (finishReason === 'content-filter') {
        lastError = 'LLM response blocked by content filter';
        log.warn(
          `Outlines attempt ${attempt}: content-filter finish — not retrying, not falling back`,
        );
        break;
      } else {
        // Empty result — retry if we have attempts left
        lastError = fullText.trim()
          ? 'LLM response could not be parsed into outlines'
          : 'LLM returned empty response';
        log.warn(
          `Outlines attempt ${attempt} diagnostics: textLen=${fullText.length}, outlines=${parsedOutlines.length}, languageDirective=${languageDirective ? 'yes' : 'no'}, preview=${JSON.stringify(fullText.slice(0, 240))}`,
        );

        if (attempt <= MAX_STREAM_RETRIES) {
          log.warn(`Empty outlines (attempt ${attempt}/${MAX_STREAM_RETRIES + 1}), retrying...`);
          // Report that a retry is happening
          emit({ type: 'retry', attempt, maxAttempts: MAX_STREAM_RETRIES + 1 });
        } else if (await maybeFallback(undefined, fullText)) {
          // Same-model retries exhausted and the response was empty:
          // retry once on the fallback model (loop is re-entered via
          // attempt reset below).
          attempt = 0;
          continue;
        }
      }
    } catch (error) {
      // The caller went away (AbortError from the propagated signal):
      // stop immediately, don't burn retries re-running generation.
      if (signal?.aborted) throw new StepAbortedError();
      lastError = error instanceof Error ? error.message : String(error);
      log.warn(
        `Outlines stream error detail (attempt ${attempt}/${MAX_STREAM_RETRIES + 1}): ${lastError}`,
      );

      if (attempt <= MAX_STREAM_RETRIES) {
        log.warn(`Stream error (attempt ${attempt}/${MAX_STREAM_RETRIES + 1}), retrying...`, error);
        emit({ type: 'retry', attempt, maxAttempts: MAX_STREAM_RETRIES + 1 });
        continue;
      }

      // Same-model retries exhausted: retry once on the fallback model
      // when the failure is retryable.
      if (await maybeFallback(error)) {
        attempt = 0;
        continue;
      }
    }
  }

  if (parsedOutlines.length === 0) {
    // All retries exhausted, no outlines produced
    log.error(`Outline generation failed after ${MAX_STREAM_RETRIES + 1} attempts: ${lastError}`);
    throw new OutlineGenerationError(lastError || 'Failed to generate outlines');
  }

  return {
    // Replace sequential gen_img_N/gen_vid_N with globally unique IDs
    outlines: uniquifyMediaElementIds(parsedOutlines),
    languageDirective: languageDirective || DEFAULT_LANGUAGE_DIRECTIVE,
    courseTitle: courseTitle || undefined,
    taskEngineMode,
  };
}

/** Prepare and stream one outline generation. */
export async function generateOutlines(
  input: OutlineInput,
  ctx: OwnerStepContext<OutlineEvent> & WorkspaceStepContext<OutlineEvent>,
): Promise<OutlineResult> {
  return streamOutlines(await prepareOutline(input, ctx), ctx);
}
