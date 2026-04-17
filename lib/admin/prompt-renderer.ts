/**
 * Prompt renderer - fetch, substitute variables, and render prompts
 * Phase 3: AI Prompt Dynamic Injection
 */

import { prisma } from '@/lib/auth/prisma';
import { getDefaultPrompt } from './default-prompts';
import { buildPromptContext, contextToVariables, PromptContext } from './prompt-context';

/**
 * Fetch active prompt template from database by key
 */
export async function getActivePrompt(key: string) {
  try {
    const prompt = await prisma.promptTemplate.findFirst({
      where: {
        key,
        isActive: true,
      },
      select: {
        id: true,
        key: true,
        displayName: true,
        content: true,
        category: true,
        version: true,
      },
    });
    return prompt;
  } catch (err) {
    console.error('[getActivePrompt] Error fetching prompt:', err);
    return null;
  }
}

/**
 * Substitute variables in template string
 * {{variable}} → value
 */
export function substituteVariables(template: string, variables: Record<string, string>): string {
  let result = template;

  Object.entries(variables).forEach(([key, value]) => {
    const regex = new RegExp(`{{${key}}}`, 'g');
    result = result.replace(regex, String(value ?? ''));
  });

  // Clean up any remaining unfilled variables
  result = result.replace(/{{[^}]+}}/g, '');

  return result;
}

/**
 * Get and render prompt with context
 * Fetches from DB, falls back to default if not found
 */
export async function renderPrompt(key: string, context: PromptContext): Promise<string> {
  // Get active prompt from database
  const dbPrompt = await getActivePrompt(key);

  // Determine which template to use
  const template = dbPrompt?.content || getDefaultPrompt(key);
  if (!template) {
    console.warn(`[renderPrompt] No prompt found for key: ${key}`);
    return '';
  }

  // Convert context to variables
  const variables = contextToVariables(context);

  // Substitute and return
  const rendered = substituteVariables(template, variables);

  return rendered;
}

/**
 * Render prompt directly from a key and custom context
 * Shorthand for common use case
 */
export async function renderPromptFromKey(
  key: string,
  classroomId?: string,
  language: 'en' | 'zh' = 'en',
  customFields?: Record<string, string>
): Promise<string> {
  // Build context
  let context: PromptContext | null = null;
  try {
    context = await buildPromptContext(classroomId, language, undefined, customFields);
  } catch (err) {
    console.error('[renderPromptFromKey] Error building context:', err);
  }

  if (!context) {
    // Fallback to default if context building failed
    const template = getDefaultPrompt(key);
    if (!template) {
      console.warn(`[renderPromptFromKey] No prompt or context for key: ${key}`);
      return '';
    }
    return template;
  }

  return renderPrompt(key, context);
}

/**
 * Get multiple prompts at once
 * Useful for building system with multiple prompt types
 */
export async function renderPrompts(
  keys: string[],
  context: PromptContext
): Promise<Record<string, string>> {
  const results: Record<string, string> = {};

  for (const key of keys) {
    results[key] = await renderPrompt(key, context);
  }

  return results;
}
