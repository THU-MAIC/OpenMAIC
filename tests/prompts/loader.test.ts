import { describe, test, expect, beforeEach } from 'vitest';
import { loadPrompt, loadSnippet, buildPrompt, clearPromptCache } from '@/lib/prompts';

describe('lib/prompts loader', () => {
  beforeEach(() => clearPromptCache());

  test('loads a known template + interpolates variables', () => {
    const result = buildPrompt('slide-actions', {
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

  test('loads a snippet', () => {
    const s = loadSnippet('json-output-rules');
    expect(s).toContain('JSON');
  });

  test('returns null for unknown promptId', () => {
    // @ts-expect-error — testing runtime behavior with invalid id
    expect(loadPrompt('does-not-exist')).toBeNull();
  });

  test('throws on unknown snippetId instead of passing through literal', () => {
    // @ts-expect-error — testing runtime behavior with invalid id
    expect(() => loadSnippet('does-not-exist')).toThrow(/Snippet not found/);
  });
});
