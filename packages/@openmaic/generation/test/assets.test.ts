import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { loadSnippet } from '@openmaic/generation';
import type { SnippetId } from '@openmaic/generation';

const PACKAGE_ROOT = fileURLToPath(new URL('../', import.meta.url));
const PBL_PROMPT_FILES = [
  'planner-system.md',
  'planner-scenario-single-call-system.md',
  'planner-single-call-system.md',
] as const;

const PROMPT_IDS = [
  'requirements-to-outlines',
  'slide-content',
  'quiz-content',
  'simulation-content',
  'diagram-content',
  'code-content',
  'game-content',
  'visualization3d-content',
  'procedural-skill-content',
  'slide-actions',
  'quiz-actions',
  'interactive-actions',
  'pbl-actions',
] as const;

const SNIPPET_IDS = [
  'json-output-rules',
  'image-instructions',
  'video-instructions',
  'media-safety-guidelines',
  'slide-image-instructions',
  'slide-generated-image-instructions',
  'slide-video-instructions',
] as const satisfies readonly SnippetId[];

const GRANDFATHERED_NON_CAMEL_CASE_PLACEHOLDERS = [
  'slide-content/system.md: {{canvas_height}}',
  'slide-content/system.md: {{canvas_height}}',
  'slide-content/system.md: {{canvas_width}}',
  'slide-content/system.md: {{canvas_width}}',
  'slide-content/system.md: {{canvas_width}}',
  'slide-content/system.md: {{canvas_width}}',
  'slide-content/user.md: {{canvas_height}}',
  'slide-content/user.md: {{canvas_width}}',
].sort();

function listFiles(directory: string): string[] {
  return readdirSync(directory)
    .flatMap((name) => {
      const entry = join(directory, name);
      return statSync(entry).isDirectory() ? listFiles(entry) : [entry];
    })
    .sort();
}

describe('packaged prompt assets', () => {
  const expectedTemplateFiles = PROMPT_IDS.flatMap((promptId) => [
    `templates/${promptId}/system.md`,
    `templates/${promptId}/user.md`,
  ]).sort();
  const expectedSnippetFiles = SNIPPET_IDS.map((snippetId) => `snippets/${snippetId}.md`).sort();
  const expectedFiles = [...expectedTemplateFiles, ...expectedSnippetFiles].sort();

  test('contains exactly the generation-owned templates and referenced snippets', () => {
    const actualFiles = [
      ...listFiles(join(PACKAGE_ROOT, 'templates')),
      ...listFiles(join(PACKAGE_ROOT, 'snippets')),
    ]
      .map((file) => relative(PACKAGE_ROOT, file))
      .sort();

    expect(actualFiles).toEqual(expectedFiles);
  });

  test('instructs Pyodide widgets to load micropip before importing it', () => {
    const source = readFileSync(
      join(PACKAGE_ROOT, 'templates', 'code-content', 'system.md'),
      'utf8',
    );
    const loadIndex = source.search(
      /await pyodide\.loadPackage\(\s*(?:['"]micropip['"]|\[[^\]]*['"]micropip['"][^\]]*\])\s*\)/,
    );
    const firstImportIndex = source.indexOf('import micropip');
    const orderedExample =
      /await pyodide\.loadPackage\(\s*(?:['"]micropip['"]|\[[^\]]*['"]micropip['"][^\]]*\])\s*\);\s*await pyodide\.runPythonAsync\(`\s*import micropip\b/;

    expect(loadIndex).toBeGreaterThanOrEqual(0);
    expect(firstImportIndex).toBeGreaterThan(loadIndex);
    expect(source).toMatch(orderedExample);
  });

  test.each(PBL_PROMPT_FILES)('ships prompts-pbl/%s', (filename) => {
    expect(
      readFileSync(join(PACKAGE_ROOT, 'prompts-pbl', filename), 'utf8').length,
    ).toBeGreaterThan(100);
  });

  test('every referenced snippet is packaged and represented by SnippetId', () => {
    const references = new Set<string>();
    for (const templateFile of expectedTemplateFiles) {
      const source = readFileSync(join(PACKAGE_ROOT, templateFile), 'utf8');
      for (const match of source.matchAll(/\{\{snippet:(\w[\w-]*)\}\}/g)) {
        references.add(match[1]);
      }
    }

    expect([...references].sort()).toEqual([...SNIPPET_IDS].sort());
    for (const snippetId of SNIPPET_IDS) {
      expect(loadSnippet(snippetId, PACKAGE_ROOT).length).toBeGreaterThan(0);
    }
  });

  // The loader only interpolates `\w+` names. Pin the app's grandfathered
  // slide dimensions exactly, while preventing any new non-camelCase names.
  test('templates use the supported placeholder naming convention', () => {
    const offenders: string[] = [];
    for (const promptId of PROMPT_IDS) {
      for (const filename of ['system.md', 'user.md']) {
        const source = readFileSync(join(PACKAGE_ROOT, 'templates', promptId, filename), 'utf8');
        const matches = source.match(/\{\{(?!snippet:|#if |\/if)([^}]+)\}\}/g) ?? [];
        for (const placeholder of matches) {
          const name = placeholder.slice(2, -2);
          if (!/^[a-z][a-zA-Z0-9]*$/.test(name)) {
            offenders.push(`${promptId}/${filename}: ${placeholder}`);
          }
        }
      }
    }

    expect(offenders.sort()).toEqual(GRANDFATHERED_NON_CAMEL_CASE_PLACEHOLDERS);
  });
});
