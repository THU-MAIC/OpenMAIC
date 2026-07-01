/**
 * Scene Outlines Streaming API (SSE)
 *
 * Streams outline generation via Server-Sent Events.
 * Emits individual outline objects as they're parsed from the LLM response,
 * so the frontend can display them incrementally.
 *
 * SSE events:
 *   { type: 'languageDirective', data: string }
 *   { type: 'courseTitle', data: string }
 *   { type: 'outline', data: SceneOutline, index: number }
 *   { type: 'done', outlines: SceneOutline[], languageDirective: string, courseTitle?: string }
 *   { type: 'error', error: string }
 */

import { NextRequest } from 'next/server';
import { streamLLM } from '@/lib/ai/llm';
import { buildPrompt, PROMPT_IDS } from '@/lib/prompts';
import {
  formatImageDescription,
  formatImagePlaceholder,
  buildVisionUserContent,
  uniquifyMediaElementIds,
  formatTeacherPersonaForPrompt,
} from '@/lib/generation/generation-pipeline';
import type { AgentInfo } from '@/lib/generation/generation-pipeline';
import { DEFAULT_LANGUAGE_DIRECTIVE } from '@/lib/generation/outline-generator';
import { MAX_PDF_CONTENT_CHARS, MAX_VISION_IMAGES } from '@/lib/constants/generation';
import { nanoid } from 'nanoid';
import type {
  UserRequirements,
  PdfImage,
  SceneOutline,
  ImageMapping,
} from '@/lib/types/generation';
import { apiError } from '@/lib/server/api-response';
import { createLogger } from '@/lib/logger';
import { resolveModelFromRequest } from '@/lib/server/resolve-model';
import { resolveVocationalActive } from '@/lib/config/feature-flags';
const log = createLogger('Outlines Stream');

export const maxDuration = 300;

/**
 * Extract the languageDirective from the streamed wrapper JSON.
 * Matches `"languageDirective":"<value>"` in partial JSON like:
 *   {"languageDirective":"用中文授课...","outlines":[...
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
// (lib/generation/outline-generator.ts): ignore whitespace-only titles and cap
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

export async function POST(req: NextRequest) {
  let requirementSnippet: string | undefined;
  let resolvedModelString: string | undefined;
  try {
    const body = await req.json();

    // Get API configuration from request headers/body
    const {
      model: languageModel,
      modelInfo,
      modelString,
      thinkingConfig,
    } = await resolveModelFromRequest(req, body, 'scene-outlines-stream');
    resolvedModelString = modelString;

    if (!body.requirements) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'Requirements are required');
    }

    const { requirements, pdfText, pdfImages, imageMapping, researchContext, agents } = body as {
      requirements: UserRequirements;
      pdfText?: string;
      pdfImages?: PdfImage[];
      imageMapping?: ImageMapping;
      researchContext?: string;
      agents?: AgentInfo[];
    };
    requirementSnippet = requirements?.requirement?.substring(0, 60);

    // Build user profile string for language inference context
    const userProfileText =
      requirements.userNickname || requirements.userBio
        ? `## Student Profile\n\nStudent: ${requirements.userNickname || 'Unknown'}${requirements.userBio ? ` — ${requirements.userBio}` : ''}\n\nConsider this student's background when designing the course. Adapt difficulty, examples, and teaching approach accordingly.\n\n---`
        : '';

    // Detect vision capability
    const hasVision = !!modelInfo?.capabilities?.vision;

    // Build prompt (same logic as generateSceneOutlinesFromRequirements)
    let availableImagesText = 'No images available';
    let visionImages: Array<{ id: string; src: string }> | undefined;

    if (pdfImages && pdfImages.length > 0) {
      if (hasVision && imageMapping) {
        // Vision mode: split into vision images (first N) and text-only (rest)
        const allWithSrc = pdfImages.filter((img) => imageMapping[img.id]);
        const visionSlice = allWithSrc.slice(0, MAX_VISION_IMAGES);
        const textOnlySlice = allWithSrc.slice(MAX_VISION_IMAGES);
        const noSrcImages = pdfImages.filter((img) => !imageMapping[img.id]);

        const visionDescriptions = visionSlice.map((img) => formatImagePlaceholder(img));
        const textDescriptions = [...textOnlySlice, ...noSrcImages].map((img) =>
          formatImageDescription(img),
        );
        availableImagesText = [...visionDescriptions, ...textDescriptions].join('\n');

        visionImages = visionSlice.map((img) => ({
          id: img.id,
          src: imageMapping[img.id],
          width: img.width,
          height: img.height,
        }));
      } else {
        // Text-only mode: full descriptions
        availableImagesText = pdfImages.map((img) => formatImageDescription(img)).join('\n');
      }
    }

    // Build media snippet conditions based on enabled flags.
    const imageGenerationEnabled = req.headers.get('x-image-generation-enabled') === 'true';
    const videoGenerationEnabled = req.headers.get('x-video-generation-enabled') === 'true';
    const mediaGenerationEnabled = imageGenerationEnabled || videoGenerationEnabled;
    const hasSourceImages = (pdfImages?.length ?? 0) > 0;

    // Build teacher context from agents (if available)
    const teacherContext = formatTeacherPersonaForPrompt(agents);

    // Check if Interactive Mode or server-enabled Task Engine mode is enabled.
    const interactiveMode = requirements.interactiveMode ?? false;
    const taskEngineMode = resolveVocationalActive(requirements);
    const promptId = taskEngineMode
      ? PROMPT_IDS.TASK_ENGINE_OUTLINES
      : interactiveMode
        ? PROMPT_IDS.INTERACTIVE_OUTLINES
        : PROMPT_IDS.REQUIREMENTS_TO_OUTLINES;

    const prompts = buildPrompt(promptId, {
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

    if (!prompts) {
      return apiError('INTERNAL_ERROR', 500, 'Prompt template not found');
    }

    log.info(
      `Generating outlines: "${requirements.requirement.substring(0, 50)}" [model=${modelString}]`,
    );

    // Create SSE stream with heartbeat to prevent connection timeout
    const encoder = new TextEncoder();
    const HEARTBEAT_INTERVAL_MS = 15_000;
    const stream = new ReadableStream({
      async start(controller) {
        // Heartbeat: periodically send SSE comments to keep the connection alive.
        let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
        const startHeartbeat = () => {
          stopHeartbeat();
          heartbeatTimer = setInterval(() => {
            try {
              controller.enqueue(encoder.encode(`:heartbeat\n\n`));
            } catch {
              stopHeartbeat();
            }
          }, HEARTBEAT_INTERVAL_MS);
        };
        const stopHeartbeat = () => {
          if (heartbeatTimer) {
            clearInterval(heartbeatTimer);
            heartbeatTimer = null;
          }
        };

        const MAX_STREAM_RETRIES = 2;
        // Hard ceiling on the accumulated stream buffer. Legitimate outline
        // JSON is small (tens of KB); anything past this is a runaway/degenerate
        // generation and must not be allowed to grow the heap unbounded.
        const MAX_OUTLINE_STREAM_BYTES = 512 * 1024;

        try {
          startHeartbeat();

          const streamParams = visionImages?.length
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
                // Tear down the upstream LLM request when the client disconnects,
                // instead of letting it run to completion for a dead connection.
                abortSignal: req.signal,
              }
            : {
                model: languageModel,
                system: prompts.system,
                prompt: prompts.user,
                maxOutputTokens: modelInfo?.outputWindow,
                abortSignal: req.signal,
              };

          let parsedOutlines: SceneOutline[] = [];
          let languageDirective: string | null = null;
          let courseTitle: string | null = null;
          let lastError: string | undefined;

          for (let attempt = 1; attempt <= MAX_STREAM_RETRIES + 1; attempt++) {
            try {
              let fullText = '';
              let scanFrom = 0;
              parsedOutlines = [];
              languageDirective = null;
              courseTitle = null;
              const usedOutlineIds = new Set<string>();
              const textStream = streamLLM(
                streamParams,
                'scene-outlines-stream',
                thinkingConfig,
              ).textStream;

              for await (const chunk of textStream) {
                // Stop doing work the moment the client goes away — otherwise
                // generation keeps running and buffering for a dead connection.
                if (req.signal?.aborted) {
                  stopHeartbeat();
                  return;
                }

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
                  if (languageDirective) {
                    const ldEvent = JSON.stringify({
                      type: 'languageDirective',
                      data: languageDirective,
                    });
                    controller.enqueue(encoder.encode(`data: ${ldEvent}\n\n`));
                  }
                }

                // Try to extract course title early (same pattern as languageDirective)
                if (!courseTitle) {
                  courseTitle = extractCourseTitle(fullText);
                  if (courseTitle) {
                    const ctEvent = JSON.stringify({
                      type: 'courseTitle',
                      data: courseTitle,
                    });
                    controller.enqueue(encoder.encode(`data: ${ctEvent}\n\n`));
                  }
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
                    ? normalizeTaskEngineOutline(enrichedBase, requirements.requirement)
                    : sanitizeNonTaskEngineOutline(enrichedBase);
                  const enriched = ensureUniqueOutlineId(normalized, usedOutlineIds);
                  parsedOutlines.push(enriched);

                  const event = JSON.stringify({
                    type: 'outline',
                    data: enriched,
                    index: parsedOutlines.length - 1,
                  });
                  controller.enqueue(encoder.encode(`data: ${event}\n\n`));
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

              // Empty result — retry if we have attempts left
              lastError = fullText.trim()
                ? 'LLM response could not be parsed into outlines'
                : 'LLM returned empty response';
              log.warn(
                `Outlines attempt ${attempt} diagnostics: textLen=${fullText.length}, outlines=${parsedOutlines.length}, languageDirective=${languageDirective ? 'yes' : 'no'}, preview=${JSON.stringify(fullText.slice(0, 240))}`,
              );

              if (attempt <= MAX_STREAM_RETRIES) {
                log.warn(
                  `Empty outlines (attempt ${attempt}/${MAX_STREAM_RETRIES + 1}), retrying...`,
                );
                // Notify client a retry is happening
                const retryEvent = JSON.stringify({
                  type: 'retry',
                  attempt,
                  maxAttempts: MAX_STREAM_RETRIES + 1,
                });
                controller.enqueue(encoder.encode(`data: ${retryEvent}\n\n`));
              }
            } catch (error) {
              // Client disconnected (AbortError from the now-propagated signal):
              // stop immediately, don't burn retries re-running generation.
              if (req.signal?.aborted) {
                stopHeartbeat();
                return;
              }
              lastError = error instanceof Error ? error.message : String(error);
              log.warn(
                `Outlines stream error detail (attempt ${attempt}/${MAX_STREAM_RETRIES + 1}): ${lastError}`,
              );

              if (attempt <= MAX_STREAM_RETRIES) {
                log.warn(
                  `Stream error (attempt ${attempt}/${MAX_STREAM_RETRIES + 1}), retrying...`,
                  error,
                );
                const retryEvent = JSON.stringify({
                  type: 'retry',
                  attempt,
                  maxAttempts: MAX_STREAM_RETRIES + 1,
                });
                controller.enqueue(encoder.encode(`data: ${retryEvent}\n\n`));
                continue;
              }
            }
          }

          if (parsedOutlines.length > 0) {
            // Replace sequential gen_img_N/gen_vid_N with globally unique IDs
            const uniquifiedOutlines = uniquifyMediaElementIds(parsedOutlines);
            // Send done event with all outlines
            const doneEvent = JSON.stringify({
              type: 'done',
              outlines: uniquifiedOutlines,
              languageDirective: languageDirective || DEFAULT_LANGUAGE_DIRECTIVE,
              courseTitle: courseTitle || undefined,
              taskEngineMode,
            });
            controller.enqueue(encoder.encode(`data: ${doneEvent}\n\n`));
          } else {
            // All retries exhausted, no outlines produced
            log.error(
              `Outline generation failed after ${MAX_STREAM_RETRIES + 1} attempts: ${lastError}`,
            );
            const errorEvent = JSON.stringify({
              type: 'error',
              error: lastError || 'Failed to generate outlines',
            });
            controller.enqueue(encoder.encode(`data: ${errorEvent}\n\n`));
          }
        } catch (error) {
          const errorEvent = JSON.stringify({
            type: 'error',
            error: error instanceof Error ? error.message : String(error),
          });
          controller.enqueue(encoder.encode(`data: ${errorEvent}\n\n`));
        } finally {
          stopHeartbeat();
          // The controller may already be closed if the client disconnected.
          try {
            controller.close();
          } catch {
            // already closed — ignore
          }
        }
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    });
  } catch (error) {
    log.error(
      `Outline streaming failed [requirement="${requirementSnippet ?? 'unknown'}...", model=${resolvedModelString ?? 'unknown'}]:`,
      error,
    );
    return apiError('INTERNAL_ERROR', 500, error instanceof Error ? error.message : String(error));
  }
}
