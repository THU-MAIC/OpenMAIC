/**
 * Prompt loader for packaged Markdown templates and snippets.
 */

import { interactiveLibraryPrompt, interactiveLibraryUrl } from '../interactive-libraries.js';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LoadedPrompt, PromptId, PromptVariableDefaults, SnippetId } from './types.js';

// `src/prompts` and `dist/prompts` have the same depth below the package root.
// Resolve from this module's URL via path operations so app bundlers do not
// mistake the Markdown directory for a statically imported module asset.
const DEFAULT_PROMPTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

const PROMPT_VARIABLE_DEFAULTS = {
  'pbl-actions': {
    projectSummary:
      '(No generated milestones are available; introduce the project topic without inventing any.)',
  },
  /**
   * The short-lesson wording of every block a long-form course replaces.
   *
   * Variables rather than `{{#if shortFormMode}}` blocks: a conditional whose
   * flag is absent deletes the short wording too, so a caller that never heard
   * of long form would silently lose the scene-count and pacing rules. With
   * defaults, an unaware caller keeps the short-lesson wording; only a
   * long-form caller swaps it.
   *
   * Sections that exist *only* for long form (the elaboration contract) stay
   * behind `{{#if longFormMode}}`, where removal loses nothing.
   */
  'requirements-to-outlines': {
    durationGuidance: '- Course duration (default 15-30 minutes if not specified)',
    sceneCountGuidance:
      '- **Scene count**: Based on inferred duration, typically 1-2 scenes per minute',
    longFormBrief: '',
  },
  'slide-actions': {
    segmentCount: '5-10',
    pacingGuidance: '- Generate 5-10 action/text objects for a natural teaching flow',
  },
  'quiz-actions': {
    /**
     * The short-lesson rule, kept as a variable for the same reason as the ones
     * above: a long-form course gives its retrieval pages a real slot, and a
     * hard-coded "1-2 short segments" left each of them with two minutes of
     * budget and ten seconds of speech.
     */
    quizSegmentGuidance:
      '1. **Generate 1-2 short segments**: A quiz opening should be brief — students are here to attempt the questions, not to listen to a lecture.',
    // The same rule appears in user.md as the output shape; both have to move
    // together or the prompt asks for two different lengths.
    quizSegmentCount: '1-2 short text segments',
  },
} satisfies PromptVariableDefaults;

function isMissingFileError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

/** Load a snippet by ID. */
export function loadSnippet(
  snippetId: SnippetId,
  promptsDir: string = DEFAULT_PROMPTS_DIR,
): string {
  const snippetPath = join(promptsDir, 'snippets', `${snippetId}.md`);

  try {
    return readFileSync(snippetPath, 'utf-8')
      .trim()
      .replace('{{interactiveLibraryAllowlist}}', interactiveLibraryPrompt());
  } catch {
    // Fail loud rather than silently shipping `{{snippet:foo}}` to the model.
    throw new Error(`Snippet not found: ${snippetId}`);
  }
}

/** Replace snippet includes with their file content. */
export function processSnippets(
  template: string,
  promptsDir: string = DEFAULT_PROMPTS_DIR,
): string {
  return template.replace(/\{\{snippet:(\w[\w-]*)\}\}/g, (_, snippetId) => {
    return loadSnippet(snippetId as SnippetId, promptsDir);
  });
}

/** Include or remove non-nested conditional blocks according to truthiness. */
export function processConditionalBlocks(
  template: string,
  conditions: Record<string, unknown>,
): string {
  return template.replace(
    /\{\{#if (\w+)\}\}([\s\S]*?)\{\{\/if\}\}/g,
    (_, conditionName: string, content: string) => {
      return conditions[conditionName] ? content : '';
    },
  );
}

/** Load a prompt by ID. */
export function loadPrompt(
  promptId: PromptId,
  promptsDir: string = DEFAULT_PROMPTS_DIR,
): LoadedPrompt | null {
  const promptDir = join(promptsDir, 'templates', promptId);
  const systemPath = join(promptDir, 'system.md');
  let systemPrompt: string;

  try {
    systemPrompt = readFileSync(systemPath, 'utf-8').trim();
  } catch (error) {
    if (isMissingFileError(error)) return null;
    throw error;
  }
  systemPrompt = processSnippets(systemPrompt, promptsDir);

  const userPath = join(promptDir, 'user.md');
  let userPromptTemplate = '';
  try {
    userPromptTemplate = readFileSync(userPath, 'utf-8').trim();
  } catch (error) {
    // user.md is optional, but only when it is genuinely absent.
    if (!isMissingFileError(error)) throw error;
  }
  userPromptTemplate = processSnippets(userPromptTemplate, promptsDir);

  systemPrompt = systemPrompt
    .replaceAll('{{threeModuleUrl}}', interactiveLibraryUrl('three'))
    .replaceAll('{{threeAddonsUrl}}', interactiveLibraryUrl('three', 'examples/jsm/'));

  return {
    id: promptId,
    systemPrompt,
    userPromptTemplate,
  };
}

/** Replace camelCase or snake_case placeholders with supplied values. */
export function interpolateVariables(template: string, variables: Record<string, unknown>): string {
  // `\w+` leaves kebab-case placeholders untouched by design.
  return template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    const value = variables[key];
    if (value === undefined) return match;
    if (typeof value === 'object') return JSON.stringify(value, null, 2);
    return String(value);
  });
}

function applyPromptVariableDefaults(
  promptId: PromptId,
  variables: Record<string, unknown>,
): Record<string, unknown> {
  const defaults = PROMPT_VARIABLE_DEFAULTS[promptId as keyof typeof PROMPT_VARIABLE_DEFAULTS];
  if (!defaults) return variables;

  const resolved = { ...variables };
  for (const [key, value] of Object.entries(defaults)) {
    if (resolved[key] === undefined) resolved[key] = value;
  }
  return resolved;
}

/**
 * Build a complete prompt in this order: snippets, conditionals, variables.
 */
export function buildPrompt(
  promptId: PromptId,
  variables: Record<string, unknown>,
  promptsDir: string = DEFAULT_PROMPTS_DIR,
): { system: string; user: string } | null {
  const prompt = loadPrompt(promptId, promptsDir);
  if (!prompt) return null;
  const resolvedVariables = applyPromptVariableDefaults(promptId, variables);

  return {
    system: interpolateVariables(
      processConditionalBlocks(prompt.systemPrompt, resolvedVariables),
      resolvedVariables,
    ),
    user: interpolateVariables(
      processConditionalBlocks(prompt.userPromptTemplate, resolvedVariables),
      resolvedVariables,
    ),
  };
}
