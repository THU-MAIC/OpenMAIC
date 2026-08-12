/**
 * PBL v2 — Prompt loader
 *
 * Loads packaged markdown prompts and applies `{{variable}}` substitutions.
 *
 * Kept separate from the main `lib/prompts/` system because that one
 * tracks every prompt id in a fixed TS union (`PromptId`). Adding
 * PBL v2 prompts there would touch a core type that is shared across
 * all of OpenMAIC's generation surfaces, expanding the v2 PR diff
 * without need. The PBL v2 prompts live in their own loader.
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { interpolateVariables } from '../../prompts/loader.js';

const _cache = new Map<string, string>();

// `src/pbl/prompts` and `dist/pbl/prompts` have the same depth below the package root.
// Resolve from this module's URL via path operations so app bundlers do not
// mistake the Markdown directory for a statically imported module asset.
const PROMPTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../prompts-pbl');

/** Read a markdown prompt by file name (without extension), cached. */
function readPromptFile(name: string): string {
  const cached = _cache.get(name);
  if (cached !== undefined) return cached;
  const filePath = join(PROMPTS_DIR, `${name}.md`);
  const text = readFileSync(filePath, 'utf-8').trim();
  _cache.set(name, text);
  return text;
}

/**
 * Load a PBL v2 prompt by name and interpolate `{{variable}}` slots.
 *
 * Snippet/conditional syntax from `lib/prompts/` is not supported here —
 * PBL v2 prompts are simple variable templates.
 */
export function loadPBLV2Prompt(name: string, variables: Record<string, unknown> = {}): string {
  const template = readPromptFile(name);
  return interpolateVariables(template, variables);
}
