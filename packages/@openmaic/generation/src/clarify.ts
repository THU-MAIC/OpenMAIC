/**
 * Pre-outline ask_user clarification.
 *
 * A lightweight preflight that runs BEFORE outline generation: the model either
 * returns `{ needsClarification: false }` (proceed straight to outlines) or a
 * small set of structured questions. User answers are re-injected into the
 * outline prompt as authoritative requirements. Outline generation itself never
 * asks — clarification happens at most once per run, before outlines.
 */

import { formatClarificationQAForPrompt } from './clarify-qa.js';
import type { AskUserOption, AskUserQuestion, ClarificationQA } from './clarify-qa.js';
import { parseJsonResponse } from './json-repair.js';
import { noopGenerationLogger, type GenerationLogger } from './logger.js';
import type { UserRequirements } from './outline-types.js';
import type { AICallFn, GenerationResult } from './pipeline-types.js';
import { buildPrompt, PROMPT_IDS } from './prompts/index.js';

/** Maximum questions the model may ask in one clarification round. */
export const MAX_CLARIFICATION_QUESTIONS = 5;

/** Truncation budgets keeping the clarify call lightweight. */
export const CLARIFY_MAX_PDF_CHARS = 6000;
export const CLARIFY_MAX_RESEARCH_CHARS = 6000;

/** The model's clarification verdict. */
export interface ClarificationResult {
  needsClarification: boolean;
  questions: AskUserQuestion[];
}

export interface ClarifyPromptContext {
  pdfText?: string;
  researchContext?: string;
}

export interface ClarifyGenerationOptions extends ClarifyPromptContext {
  logger?: GenerationLogger;
}

function truncate(value: string | undefined, maxChars: number): string {
  if (!value) return 'None';
  return value.length > maxChars ? value.substring(0, maxChars) : value;
}

/** Build the byte-stable system and user prompts for the clarify preflight. */
export function buildClarificationPrompt(
  requirements: UserRequirements,
  context: ClarifyPromptContext = {},
): { system: string; user: string } {
  const prompts = buildPrompt(PROMPT_IDS.REQUIREMENTS_CLARIFY, {
    requirement: requirements.requirement,
    pdfContent: truncate(context.pdfText, CLARIFY_MAX_PDF_CHARS),
    researchContext: truncate(context.researchContext, CLARIFY_MAX_RESEARCH_CHARS),
  });

  if (!prompts) {
    throw new Error('Prompt template not found');
  }

  return prompts;
}

function normalizeOptionId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const id = raw.trim();
  return id ? id : null;
}

function normalizeOptionLabel(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const label = raw.trim();
  return label ? label : null;
}

function normalizeQuestion(raw: unknown, index: number): AskUserQuestion | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  if (typeof record.question !== 'string' || !record.question.trim()) return null;

  let options: AskUserOption[] | undefined;
  if (Array.isArray(record.options)) {
    const seen = new Set<string>();
    const normalized: AskUserOption[] = [];
    for (const option of record.options) {
      if (!option || typeof option !== 'object') continue;
      const candidate = option as Record<string, unknown>;
      const id = normalizeOptionId(candidate.id);
      const label = normalizeOptionLabel(candidate.label);
      if (!id || !label || seen.has(id)) continue;
      seen.add(id);
      normalized.push({ id, label });
    }
    if (normalized.length > 0) options = normalized;
  }

  const fallbackId = `q${index + 1}`;
  const rawId = normalizeOptionId(record.id);

  return {
    id: rawId ?? fallbackId,
    question: record.question.trim(),
    ...(options ? { options } : {}),
    multiSelect: record.multiSelect === true,
    allowFreeText: record.allowFreeText === true,
  };
}

/**
 * Parse a raw clarify response into a verdict. Returns null when the response
 * is not parseable JSON so callers can fail open deliberately; returns
 * `{ needsClarification: false }` when the model asked nothing usable.
 */
export function parseClarificationResponse(
  response: string,
  options: { logger?: GenerationLogger } = {},
): ClarificationResult | null {
  const logger = options.logger ?? noopGenerationLogger;
  const parsed = parseJsonResponse<{ needsClarification?: unknown; questions?: unknown }>(
    response,
    { logger },
  );
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

  if (parsed.needsClarification !== true || !Array.isArray(parsed.questions)) {
    return { needsClarification: false, questions: [] };
  }

  const seenIds = new Set<string>();
  const questions: AskUserQuestion[] = [];
  for (const raw of parsed.questions) {
    if (questions.length >= MAX_CLARIFICATION_QUESTIONS) break;
    const normalized = normalizeQuestion(raw, questions.length);
    if (!normalized) continue;
    if (seenIds.has(normalized.id)) {
      normalized.id = `q${questions.length + 1}`;
    }
    seenIds.add(normalized.id);
    questions.push(normalized);
  }

  if (questions.length === 0) {
    return { needsClarification: false, questions: [] };
  }

  return { needsClarification: true, questions };
}

/** Run the clarify preflight: prompt, call, parse. */
export async function generateClarificationQuestions(
  requirements: UserRequirements,
  aiCall: AICallFn,
  options?: ClarifyGenerationOptions,
): Promise<GenerationResult<ClarificationResult>> {
  const logger = options?.logger ?? noopGenerationLogger;
  let prompts: { system: string; user: string };

  try {
    prompts = buildClarificationPrompt(requirements, options ?? {});
  } catch (error) {
    if (error instanceof Error && error.message === 'Prompt template not found') {
      return { success: false, error: 'Prompt template not found' };
    }
    throw error;
  }

  try {
    const response = await aiCall(prompts.system, prompts.user);
    const parsed = parseClarificationResponse(response, { logger });
    if (!parsed) {
      return { success: false, error: 'Failed to parse clarification response' };
    }
    return { success: true, data: parsed };
  } catch (error) {
    return { success: false, error: String(error) };
  }
}
