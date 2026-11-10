import { describe, expect, it, vi } from 'vitest';
import type { AICallFn, GeneratedSlideContent, SceneContentFailure, SceneOutline } from '@openmaic/generation';
import {
  findMalformedLatex,
  generateSceneContent,
  withGenerationRetry,
} from '@openmaic/generation';

function slideOutline(): SceneOutline {
  return {
    id: 'slide-1',
    type: 'slide',
    title: 'LaTeX Formatting',
    description: 'Explain math expressions with correct escaping.',
    keyPoints: ['Valid JSON escaping', 'KaTeX rendering'],
    order: 1,
  };
}

describe('scene generator LaTeX JSON escape validation and recovery', () => {
  it('never accepts raw, incorrectly escaped LaTeX such as \\frac as successfully generated content', async () => {
    // In raw JSON, "\frac{1}{2}" uses a single backslash before 'f' (\f = form feed)
    const rawJson = '{"elements":[{"id":"latex_1","type":"latex","left":100,"top":100,"width":300,"height":100,"latex":"\\frac{1}{2}"}]}';
    const aiCall: AICallFn = vi.fn(async () => rawJson);
    const failures: SceneContentFailure[] = [];

    const content = await generateSceneContent(slideOutline(), aiCall, {
      onFailure: (failure) => failures.push(failure),
    });

    expect(content).toBeNull();
    expect(failures).toEqual([
      {
        code: 'invalid-model-output',
        message: expect.stringContaining('\\frac'),
      },
    ]);
  });

  it('never accepts raw, incorrectly escaped LaTeX such as \\times as successfully generated content', async () => {
    // In raw JSON, "\times 4" uses a single backslash before 't' (\t = tab)
    const rawJson = '{"elements":[{"id":"latex_1","type":"latex","left":100,"top":100,"width":300,"height":100,"latex":"\\times 4"}]}';
    const aiCall: AICallFn = vi.fn(async () => rawJson);
    const failures: SceneContentFailure[] = [];

    const content = await generateSceneContent(slideOutline(), aiCall, {
      onFailure: (failure) => failures.push(failure),
    });

    expect(content).toBeNull();
    expect(failures).toEqual([
      {
        code: 'invalid-model-output',
        message: expect.stringContaining('\\times'),
      },
    ]);
  });

  it('rejects raw, incorrectly escaped \\nu and \\beta commands', async () => {
    // \nu corrupts into newline (\n), \beta corrupts into backspace (\b)
    const rawJson = '{"elements":[{"id":"latex_1","type":"latex","left":100,"top":100,"width":300,"height":100,"latex":"\\nu + \\beta"}]}';
    const aiCall: AICallFn = vi.fn(async () => rawJson);
    const failures: SceneContentFailure[] = [];

    const content = await generateSceneContent(slideOutline(), aiCall, {
      onFailure: (failure) => failures.push(failure),
    });

    expect(content).toBeNull();
    expect(failures).toEqual([
      {
        code: 'invalid-model-output',
        message: expect.stringContaining('\\nu'),
      },
    ]);
  });

  it('preserves correctly JSON-escaped LaTeX such as \\\\frac and \\\\times intact', async () => {
    // In valid JSON, double backslashes survive plain JSON.parse intact as literal backslashes
    const validJson = JSON.stringify({
      elements: [
        {
          id: 'latex_1',
          type: 'latex',
          left: 100,
          top: 100,
          width: 300,
          height: 100,
          latex: '\\frac{1}{2} + \\times 4 + \\nu + \\beta',
        },
      ],
      remark: 'Formulas intact',
    });
    const aiCall: AICallFn = vi.fn(async () => validJson);
    const failures: SceneContentFailure[] = [];

    const content = (await generateSceneContent(slideOutline(), aiCall, {
      onFailure: (failure) => failures.push(failure),
    })) as GeneratedSlideContent;

    expect(content).not.toBeNull();
    expect(failures).toEqual([]);
    expect(content.elements).toHaveLength(1);
    const latexEl = content.elements[0] as { type: string; latex: string; html?: string };
    expect(latexEl.type).toBe('latex');
    expect(latexEl.latex).toBe('\\frac{1}{2} + \\times 4 + \\nu + \\beta');
    expect(latexEl.html).toContain('katex');
    expect(latexEl.html).not.toContain('katex-error');
  });

  it('preserves genuine \\n, \\t, and \\uXXXX JSON escapes with their intended behavior', async () => {
    // Genuine newlines, tabs, and unicode escapes in text elements, remarks, and formulas
    const jsonWithGenuineEscapes = JSON.stringify({
      elements: [
        {
          id: 'text_1',
          type: 'text',
          left: 60,
          top: 60,
          width: 800,
          height: 100,
          content: '<p>Line 1\nLine 2\tIndented \u00A0 \u4E16\u754C</p>',
        },
        {
          id: 'latex_1',
          type: 'latex',
          left: 60,
          top: 180,
          width: 400,
          height: 100,
          latex: '\\frac{\\alpha}{\\beta} + \u03b1',
        },
      ],
      remark: 'Line 1\nLine 2\tTabbed\u2211',
    });
    const aiCall: AICallFn = vi.fn(async () => jsonWithGenuineEscapes);

    const content = (await generateSceneContent(slideOutline(), aiCall)) as GeneratedSlideContent;

    expect(content).not.toBeNull();
    const textEl = content.elements.find((el) => el.type === 'text') as { content: string };
    expect(textEl.content).toContain('Line 1\nLine 2\tIndented \u00A0 世界');

    const latexEl = content.elements.find((el) => el.type === 'latex') as {
      latex: string;
      html?: string;
    };
    expect(latexEl.latex).toBe('\\frac{\\alpha}{\\beta} + α');
    expect(latexEl.html).toContain('katex');
    expect(latexEl.html).not.toContain('katex-error');
    expect(content.remark).toBe('Line 1\nLine 2\tTabbed∑');
  });

  it('regeneration succeeds when given a valid response on retry', async () => {
    let callCount = 0;
    const aiCall: AICallFn = vi.fn(async () => {
      callCount += 1;
      if (callCount === 1) {
        // Attempt 1: malformed unescaped LaTeX
        return '{"elements":[{"id":"latex_1","type":"latex","left":100,"top":100,"width":300,"height":100,"latex":"\\frac{1}{2}"}]}';
      }
      // Attempt 2: valid, correctly escaped LaTeX
      return JSON.stringify({
        elements: [
          {
            id: 'latex_1',
            type: 'latex',
            left: 100,
            top: 100,
            width: 300,
            height: 100,
            latex: '\\frac{1}{2}',
          },
        ],
      });
    });

    const sleep = vi.fn(async () => {});
    const onRetry = vi.fn();

    const result = await withGenerationRetry(
      async () => {
        return await generateSceneContent(slideOutline(), aiCall);
      },
      {
        label: 'scene-content-regeneration',
        maxRetries: 2,
        sleep,
        onRetry,
        shouldRetryResult: (content) => content === null,
      },
    );

    expect(result).not.toBeNull();
    expect(callCount).toBe(2);
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith(
      expect.objectContaining({
        attempt: 1,
        reason: 'empty result',
      }),
    );
  });

  it('regeneration respects the existing retry limit when malformed responses persist', async () => {
    let callCount = 0;
    const aiCall: AICallFn = vi.fn(async () => {
      callCount += 1;
      // Always malformed unescaped LaTeX
      return '{"elements":[{"id":"latex_1","type":"latex","left":100,"top":100,"width":300,"height":100,"latex":"\\times 4"}]}';
    });

    const sleep = vi.fn(async () => {});
    const onRetry = vi.fn();

    const result = await withGenerationRetry(
      async () => {
        return await generateSceneContent(slideOutline(), aiCall);
      },
      {
        label: 'scene-content-exhaustion',
        maxRetries: 2,
        sleep,
        onRetry,
        shouldRetryResult: (content) => content === null,
      },
    );

    // After exhausting 1 initial + 2 retries = 3 attempts, returns null
    expect(result).toBeNull();
    expect(callCount).toBe(3);
    expect(onRetry).toHaveBeenCalledTimes(2);
  });

  it('schema-aware validation inspects parsed elements when raw response is unavailable', () => {
    // When plain JSON.parse was run without raw text, corrupted control characters are caught
    const parsedCorruptedFrac = [
      {
        type: 'latex',
        left: 0,
        top: 0,
        width: 100,
        height: 50,
        latex: '\x0crac{1}{2}',
      },
    ];
    expect(findMalformedLatex(parsedCorruptedFrac as never)).toContain('control characters');

    const parsedCorruptedTimes = [
      {
        type: 'latex',
        left: 0,
        top: 0,
        width: 100,
        height: 50,
        latex: '\times 4',
      },
    ];
    expect(findMalformedLatex(parsedCorruptedTimes as never)).toContain('tab character');

    const parsedCorruptedNu = [
      {
        type: 'latex',
        left: 0,
        top: 0,
        width: 100,
        height: 50,
        latex: '\nu = 1',
      },
    ];
    expect(findMalformedLatex(parsedCorruptedNu as never)).toContain('newline');

    const parsedCorruptedBeta = [
      {
        type: 'latex',
        left: 0,
        top: 0,
        width: 100,
        height: 50,
        latex: '\x08eta = 2',
      },
    ];
    expect(findMalformedLatex(parsedCorruptedBeta as never)).toContain('control characters');

    // Valid parsed LaTeX without control characters passes
    const parsedValid = [
      {
        type: 'latex',
        left: 0,
        top: 0,
        width: 100,
        height: 50,
        latex: '\\frac{1}{2} + \\times 4 + \\nu + \\beta',
      },
    ];
    expect(findMalformedLatex(parsedValid as never)).toBeUndefined();
  });
});
