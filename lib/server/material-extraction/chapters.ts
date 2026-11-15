import { callLLM } from '@/lib/ai/llm';
import { buildChapterInput, type ChapterSource } from '@/lib/document/chapter-source';
import { DOCUMENT_MIME_TYPES, normalizeDocumentMimeType } from '@/lib/document/mime';
import { getMinerUChunkPages } from '@/lib/pdf/mineru-chunks';
import { createLogger } from '@/lib/logger';
import { loadPrompt, PROMPT_IDS } from '@/lib/prompts';
import { resolveStageModel } from '@/lib/server/model-config/llm';
import { backgroundWorkspaceId } from '@/lib/server/model-config/runtime';
import type { MaterialChapter, MaterialSection } from '@/lib/types/material-chapters';

const log = createLogger('MaterialChapters');
export const CHAPTER_TIMEOUT_MS = 120_000;

/** Reject the entire tree on any invalid node; never repair or retain a subset. */
export function validateChapters(value: unknown, pages: number): MaterialChapter[] {
  function object(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('Expected object');
    return value as Record<string, unknown>;
  }
  function nodes(value: unknown, chapters: boolean): (MaterialChapter | MaterialSection)[] {
    if (!Array.isArray(value)) throw new Error('Expected array');
    let previous = 1;
    return value.map((item) => {
      const node = object(item);
      if (
        typeof node.title !== 'string' ||
        !node.title.trim() ||
        typeof node.start !== 'number' ||
        !Number.isInteger(node.start) ||
        node.start < previous ||
        node.start > pages
      )
        throw new Error('Invalid chapter node');
      previous = node.start;
      return {
        title: node.title,
        startPage: node.start,
        ...(chapters ? { sections: nodes(node.sections, false) } : {}),
      };
    });
  }
  return nodes(object(value).chapters, true) as MaterialChapter[];
}

/** Accept a JSON response or a single complete JSON code fence, without repairing its contents. */
export function decodeChapterResponse(text: string, pages: number): MaterialChapter[] {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/i.exec(trimmed);
  let value: unknown;
  try {
    value = JSON.parse(fenced ? fenced[1] : trimmed);
  } catch {
    // Native JSON errors may quote document content from the response.
    throw new SyntaxError('Invalid chapter response JSON');
  }
  return validateChapters(value, pages);
}

export interface ChapterRecognitionInput {
  source?: ChapterSource;
  providerId?: string;
  pageCount: number;
  mimeType: string;
  ownerId: string;
  signal?: AbortSignal;
}

/** Optional enrichment after provider success, outside every provider fallback loop. */
export async function recognizeMaterialChapters(
  input: ChapterRecognitionInput,
): Promise<MaterialChapter[] | undefined> {
  const mime = normalizeDocumentMimeType({ mimeType: input.mimeType });
  const format = Object.entries(DOCUMENT_MIME_TYPES).find(([, value]) => value === mime)?.[0];
  if (
    input.providerId !== 'mineru' ||
    !input.source?.titles.length ||
    !format ||
    !['pdf', 'doc', 'docx', 'ppt', 'pptx'].includes(format)
  )
    return undefined;
  if (input.pageCount <= getMinerUChunkPages()) return undefined;
  // Skipped enrichment must not cancel publication of an already parsed document.
  input.signal?.throwIfAborted();

  const timeout = new AbortController();
  const timer = setTimeout(
    () => timeout.abort(new Error('Chapter recognition timed out')),
    CHAPTER_TIMEOUT_MS,
  );
  timer.unref?.();
  const signal = input.signal ? AbortSignal.any([input.signal, timeout.signal]) : timeout.signal;
  const state: { phase: 'model_configuration' | 'call' | 'decode' } = {
    phase: 'model_configuration',
  };
  try {
    const work = async () => {
      const workspaceId = await backgroundWorkspaceId(input.ownerId);
      const resolved = await resolveStageModel({ stage: 'material-chapters', workspaceId });
      signal.throwIfAborted();
      const template = loadPrompt(PROMPT_IDS.MATERIAL_CHAPTERS);
      if (!template) throw new Error('Chapter prompt unavailable');
      state.phase = 'call';
      const result = await callLLM(
        {
          model: resolved.model,
          system: template.systemPrompt,
          prompt: buildChapterInput(input.source!, format, input.pageCount),
          temperature: 0,
          maxOutputTokens: 16_384,
          maxRetries: 0,
          abortSignal: signal,
        },
        'material-chapters',
        { retries: 0 },
        resolved.thinkingConfig,
        { enabled: false },
      );
      signal.throwIfAborted();
      state.phase = 'decode';
      return decodeChapterResponse(result.text, input.pageCount);
    };
    // Also bounds model configuration lookup and providers that ignore abort.
    return await new Promise<MaterialChapter[]>((resolve, reject) => {
      const abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      work()
        .then(resolve, reject)
        .finally(() => signal.removeEventListener('abort', abort));
    });
  } catch (error) {
    input.signal?.throwIfAborted();
    const reason = timeout.signal.aborted
      ? 'timeout'
      : state.phase === 'decode'
        ? error instanceof SyntaxError
          ? 'json_decode'
          : 'validation'
        : state.phase;
    log.warn('Chapter recognition unavailable; keeping the successful document extraction.', {
      reason,
      errorType: error instanceof Error ? error.name.slice(0, 64) : 'UnknownError',
      message: error instanceof Error ? error.message.slice(0, 320) : 'Non-Error failure',
    });
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}
