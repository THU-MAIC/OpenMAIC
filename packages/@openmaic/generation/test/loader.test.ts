import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, test } from 'vitest';
import {
  PROMPT_IDS,
  buildPrompt,
  interpolateVariables,
  loadPrompt,
  processConditionalBlocks,
  processSnippets,
} from '@openmaic/generation';

function createPromptsFixture(): string {
  const promptsDir = mkdtempSync(join(tmpdir(), 'openmaic-generation-prompts-'));
  mkdirSync(join(promptsDir, 'snippets'));
  mkdirSync(join(promptsDir, 'templates'));
  return promptsDir;
}

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

  test('inlines a snippet exactly once', () => {
    const promptsDir = createPromptsFixture();
    writeFileSync(join(promptsDir, 'snippets', 'example.md'), 'inlined content\n');

    expect(processSnippets('Before {{snippet:example}} after', promptsDir)).toBe(
      'Before inlined content after',
    );
  });

  test('returns null for an unknown prompt', () => {
    // @ts-expect-error -- exercise the runtime failure path.
    expect(loadPrompt('does-not-exist')).toBeNull();
  });

  test('throws when a referenced snippet is missing', () => {
    expect(() => processSnippets('{{snippet:does-not-exist}}')).toThrow(/Snippet not found/);
  });

  test('does not recursively process snippet markers inside snippets', () => {
    const promptsDir = createPromptsFixture();
    writeFileSync(join(promptsDir, 'snippets', 'outer.md'), 'outer {{snippet:inner}}\n');
    writeFileSync(join(promptsDir, 'snippets', 'inner.md'), 'inner\n');

    expect(processSnippets('{{snippet:outer}}', promptsDir)).toBe('outer {{snippet:inner}}');
  });

  test('propagates a missing snippet referenced by user.md', () => {
    const promptsDir = createPromptsFixture();
    const promptDir = join(promptsDir, 'templates', 'fixture');
    mkdirSync(promptDir);
    writeFileSync(join(promptDir, 'system.md'), 'system prompt\n');
    writeFileSync(join(promptDir, 'user.md'), '{{snippet:not-packaged}}\n');

    // @ts-expect-error -- fixture is intentionally outside the public PromptId union.
    expect(() => loadPrompt('fixture', promptsDir)).toThrow(/Snippet not found: not-packaged/);
  });

  test('keeps conditional content when its condition is truthy', () => {
    expect(processConditionalBlocks('A {{#if enabled}}kept{{/if}} B', { enabled: true })).toBe(
      'A kept B',
    );
  });

  test('drops conditional content when its condition is falsey', () => {
    expect(processConditionalBlocks('A {{#if enabled}}dropped{{/if}} B', { enabled: false })).toBe(
      'A  B',
    );
  });

  test('does not recursively process nested conditional blocks', () => {
    const template = '{{#if outer}}outer {{#if inner}}inner{{/if}}{{/if}}';
    expect(processConditionalBlocks(template, { outer: true, inner: true })).toBe(
      'outer {{#if inner}}inner{{/if}}',
    );
  });

  test('interpolates string variables', () => {
    expect(interpolateVariables('Hello {{name}}', { name: 'Ada' })).toBe('Hello Ada');
  });

  test('interpolates object variables as two-space JSON', () => {
    expect(interpolateVariables('{{payload}}', { payload: { nested: true } })).toBe(
      '{\n  "nested": true\n}',
    );
  });

  test('preserves placeholders whose variable is undefined', () => {
    expect(interpolateVariables('{{missing}}', { missing: undefined })).toBe('{{missing}}');
  });

  test('leaves kebab-case placeholders untouched', () => {
    expect(interpolateVariables('{{next-agent}}', { 'next-agent': 'ignored' })).toBe(
      '{{next-agent}}',
    );
  });
});
