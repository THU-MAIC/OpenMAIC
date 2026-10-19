/**
 * Structural assertion tests for the prompt templates.
 *
 * These replace the byte-equal snapshot suite that was initially added — the
 * goal here is catching real regressions (missing variables, broken
 * placeholder naming) without forcing a snapshot update for every intentional
 * prompt-content tweak.
 */

import { describe, test, expect } from 'vitest';
import { loadPrompt } from '@openmaic/generation';

describe('PBL action workflow', () => {
  test('previews the v2 instructor-guided milestone workspace', () => {
    const prompt = loadPrompt('pbl-actions');

    expect(prompt?.systemPrompt).toContain(
      'complete project configuration with milestones and a guided project workspace led by an instructor',
    );
    expect(prompt?.systemPrompt).toContain(
      'Briefly previews what the project involves, including its driving goal and key milestones',
    );
    expect(prompt?.systemPrompt).toContain(
      'Encourages students to enter the project workspace and start the first task',
    );
    expect(prompt?.systemPrompt).toContain('## Project Plan');
    expect(prompt?.systemPrompt).toContain('{{projectSummary}}');
    expect(prompt?.systemPrompt).toContain('do not invent or rename them');
    expect(prompt?.systemPrompt).not.toContain('available roles');
    expect(prompt?.systemPrompt).not.toContain('select a role');
  });
});

describe('placeholder naming convention lint', () => {
  // The `interpolateVariables` regex is /\{\{(\w+)\}\}/, which is
  // strictly [A-Za-z0-9_]. Kebab-case placeholders would silently pass
  // through. Convention (per README) is camelCase. This test scans every
  // template for non-conforming placeholders.
  //
  // slide-content/{system,user}.md predates the convention and still uses
  // snake_case ({{canvas_width}}, {{canvas_height}}). Grandfather it here;
  // new templates must be camelCase.
  test('templates (excluding grandfathered) use camelCase placeholders', async () => {
    const { readdirSync, readFileSync, statSync } = await import('fs');
    const { join } = await import('path');

    const templatesDir = join(process.cwd(), 'lib', 'prompts', 'templates');
    const GRANDFATHERED = new Set(['slide-content']);

    const offenders: string[] = [];
    for (const promptId of readdirSync(templatesDir)) {
      if (GRANDFATHERED.has(promptId)) continue;
      const promptDir = join(templatesDir, promptId);
      if (!statSync(promptDir).isDirectory()) continue;

      for (const file of ['system.md', 'user.md']) {
        const p = join(promptDir, file);
        try {
          const content = readFileSync(p, 'utf-8');
          // Match {{placeholder}} but NOT {{snippet:name}}, {{#if}}, or {{/if}}
          const matches = content.match(/\{\{(?!snippet:|#if |\/if)([^}]+)\}\}/g) || [];
          for (const m of matches) {
            const name = m.slice(2, -2);
            // camelCase: starts with lowercase, rest alphanumeric; reject _ and -
            if (!/^[a-z][a-zA-Z0-9]*$/.test(name)) {
              offenders.push(`${promptId}/${file}: ${m}`);
            }
          }
        } catch {
          // user.md is optional
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
