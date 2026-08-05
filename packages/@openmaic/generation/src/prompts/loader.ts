/**
 * Prompt loader for packaged Markdown templates and snippets.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LoadedPrompt, PromptId, SnippetId } from './types.js';

// `src/prompts` and `dist/prompts` have the same depth below the package root.
const DEFAULT_PROMPTS_DIR = fileURLToPath(new URL('../../', import.meta.url));

/** Load a snippet by ID. */
export function loadSnippet(
  snippetId: SnippetId,
  promptsDir: string = DEFAULT_PROMPTS_DIR,
): string {
  const snippetPath = join(promptsDir, 'snippets', `${snippetId}.md`);

  try {
    return readFileSync(snippetPath, 'utf-8').trim();
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

  try {
    const systemPath = join(promptDir, 'system.md');
    let systemPrompt = readFileSync(systemPath, 'utf-8').trim();
    systemPrompt = processSnippets(systemPrompt, promptsDir);

    const userPath = join(promptDir, 'user.md');
    let userPromptTemplate = '';
    try {
      userPromptTemplate = readFileSync(userPath, 'utf-8').trim();
      userPromptTemplate = processSnippets(userPromptTemplate, promptsDir);
    } catch {
      // user.md is optional.
    }

    return {
      id: promptId,
      systemPrompt,
      userPromptTemplate,
    };
  } catch {
    return null;
  }
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

  return {
    system: interpolateVariables(
      processConditionalBlocks(prompt.systemPrompt, variables),
      variables,
    ),
    user: interpolateVariables(
      processConditionalBlocks(prompt.userPromptTemplate, variables),
      variables,
    ),
  };
}
