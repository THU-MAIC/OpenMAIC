import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import {
  PROMPT_IDS,
  buildPrompt,
  interpolateVariables,
  loadPrompt,
  loadSnippet,
  processConditionalBlocks,
  processSnippets,
} from '@openmaic/generation';
import type { PromptId } from '@openmaic/generation';

const PACKAGE_ROOT = fileURLToPath(new URL('../', import.meta.url));
const APP_PROMPTS_DIR = resolve(PACKAGE_ROOT, '../../..', 'lib', 'prompts');
const PROMPT_ID_VALUES = Object.values(PROMPT_IDS);

function sourceFor(promptId: PromptId): string {
  const prompt = loadPrompt(promptId, APP_PROMPTS_DIR);
  expect(prompt).not.toBeNull();
  return `${prompt!.systemPrompt}\n${prompt!.userPromptTemplate}`;
}

function conditionalNames(source: string): string[] {
  return [...new Set([...source.matchAll(/\{\{#if (\w+)\}\}/g)].map((match) => match[1]))];
}

function variableNames(source: string): string[] {
  return [...new Set([...source.matchAll(/\{\{(\w+)\}\}/g)].map((match) => match[1]))];
}

function expectParity(promptId: PromptId, variables: Record<string, unknown>) {
  expect(buildPrompt(promptId, variables, PACKAGE_ROOT)).toEqual(
    buildPrompt(promptId, variables, APP_PROMPTS_DIR),
  );
}

describe.each(PROMPT_ID_VALUES)('loader parity: %s', (promptId) => {
  const source = sourceFor(promptId);

  test('with no variables', () => {
    expectParity(promptId, {});
  });

  for (const condition of conditionalNames(source)) {
    test(`with ${condition} absent`, () => {
      expectParity(promptId, { [condition]: false });
    });

    test(`with ${condition} present`, () => {
      expectParity(promptId, { [condition]: true });
    });
  }

  test('with representative string, object, and undefined interpolation', () => {
    const names = variableNames(source);
    const variables: Record<string, unknown> = Object.fromEntries(
      conditionalNames(source).map((condition) => [condition, true]),
    );
    if (names[0]) variables[names[0]] = 'representative value';
    if (names[1]) variables[names[1]] = { nested: ['value'] };
    if (names[2]) variables[names[2]] = undefined;

    expectParity(promptId, variables);
  });
});

describe('loader semantics', () => {
  test('loads and interpolates a known prompt', () => {
    const result = buildPrompt(PROMPT_IDS.SLIDE_ACTIONS, {
      title: 'Test Slide',
      keyPoints: '1. point one',
      description: 'desc',
      elements: '[]',
      courseContext: '',
      agents: '',
      userProfile: '',
      languageDirective: 'en',
    });

    expect(result).not.toBeNull();
    expect(result!.system.length).toBeGreaterThan(100);
    expect(result!.user).toContain('Test Slide');
  });

  test('loads a known snippet', () => {
    expect(loadSnippet('json-output-rules')).toContain('JSON');
  });

  test('returns null for an unknown prompt', () => {
    // @ts-expect-error -- exercise the runtime failure path.
    expect(loadPrompt('does-not-exist')).toBeNull();
  });

  test('throws for an unknown snippet', () => {
    // @ts-expect-error -- exercise the runtime failure path.
    expect(() => loadSnippet('does-not-exist')).toThrow(/Snippet not found/);
  });

  test('processes snippets non-recursively', () => {
    const promptsDir = mkdtempSync(join(tmpdir(), 'openmaic-generation-prompts-'));
    mkdirSync(join(promptsDir, 'snippets'));
    writeFileSync(join(promptsDir, 'snippets', 'outer.md'), 'outer {{snippet:inner}}\n');
    writeFileSync(join(promptsDir, 'snippets', 'inner.md'), 'inner\n');

    expect(processSnippets('{{snippet:outer}}', promptsDir)).toBe('outer {{snippet:inner}}');
  });

  test('processes conditionals before variable interpolation', () => {
    const template = 'A {{#if enabled}}Hello {{name}}{{/if}} B';
    expect(
      interpolateVariables(processConditionalBlocks(template, { enabled: true }), {
        name: 'Ada',
      }),
    ).toBe('A Hello Ada B');
    expect(processConditionalBlocks(template, { enabled: false })).toBe('A  B');
  });

  test('stringifies objects, preserves undefined and kebab-case placeholders', () => {
    expect(
      interpolateVariables('A {{plain}} B {{payload}} C {{missing}} D {{next-agent}}', {
        plain: 7,
        payload: { nested: true },
        missing: undefined,
        'next-agent': 'ignored',
      }),
    ).toBe('A 7 B {\n  "nested": true\n} C {{missing}} D {{next-agent}}');
  });
});
