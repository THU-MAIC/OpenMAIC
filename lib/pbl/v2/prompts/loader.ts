/**
 * PBL v2 — Prompt loader
 *
 * Loads markdown prompts from `lib/pbl/v2/prompts/*.md` and applies
 * `{{variable}}` substitutions via the existing OpenMAIC interpolator.
 *
 * Kept separate from the main `lib/prompts/` system because that one
 * tracks every prompt id in a fixed TS union (`PromptId`). Adding
 * PBL v2 prompts there would touch a core type that is shared across
 * all of OpenMAIC's generation surfaces, expanding the v2 PR diff
 * without need. The PBL v2 prompts live in their own loader.
 */

import fs from 'fs';
import path from 'path';
import { interpolateVariables } from '@/lib/prompts/loader';

const _cache = new Map<string, string>();

function promptsDir(): string {
  return path.join(process.cwd(), 'lib', 'pbl', 'v2', 'prompts');
}

/** Read a markdown prompt by file name (without extension), cached. */
function readPromptFile(name: string): string {
  const cached = _cache.get(name);
  if (cached !== undefined) return cached;
  const filePath = path.join(promptsDir(), `${name}.md`);
  const text = fs.readFileSync(filePath, 'utf-8').trim();
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
