/**
 * `fixInteractiveHtml` — surgical bug-fix for an interactive scene's HTML.
 *
 * Interactive scenes (`InteractiveContent.html`) are self-contained single-file
 * HTML pages rendered in a sandboxed iframe. They occasionally ship with small
 * bugs (a dead button, a typo'd id, a handler that throws). This runs ONE LLM
 * round-trip that returns the full corrected document, then reuses the same
 * extraction + post-processing as fresh widget generation so the result drops
 * straight back into `content.html`.
 *
 * Trust/IO boundary: the caller (the `fix_interactive_html` tool) supplies the
 * current HTML from the server-injected scene context and a natural-language bug
 * description; the model never authors the page from scratch.
 *
 * Returns the fixed HTML, or `null` when the prompt template is missing or the
 * model response carries no extractable HTML — callers fail loud (no silent
 * fallback to the original page).
 */

import { buildPrompt, PROMPT_IDS } from '@/lib/prompts';
import { extractHtml } from '@/lib/generation/scene-generator';
import { postProcessInteractiveHtml } from '@/lib/generation/interactive-post-processor';
import { createLogger } from '@/lib/logger';

const log = createLogger('FixInteractiveHtml');

export async function fixInteractiveHtml(
  currentHtml: string,
  bugDescription: string,
  aiCall: (systemPrompt: string, userPrompt: string) => Promise<string>,
): Promise<string | null> {
  const prompts = buildPrompt(PROMPT_IDS.FIX_INTERACTIVE_HTML, {
    bugDescription,
    currentHtml,
  });
  if (!prompts) {
    // Missing template is a config/typo bug — surface it, do not ship the
    // raw placeholder or silently no-op.
    log.error('fix-interactive-html prompt template failed to load');
    return null;
  }

  const response = await aiCall(prompts.system, prompts.user);
  const html = extractHtml(response);
  if (!html) {
    log.error('Could not extract fixed HTML from model response');
    return null;
  }

  return postProcessInteractiveHtml(html);
}
