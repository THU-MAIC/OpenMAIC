import { describe, expect, it, vi } from 'vitest';
import type { AICallFn, GeneratedSlideContent, SceneContentFailure } from '@openmaic/generation';
import { generateSceneContent } from '@openmaic/generation';
import { findMalformedLatex } from '../src/scene-generator.js';
import { slideOutline } from './scene-fixtures.js';

describe('scene generator LaTeX JSON escape validation and recovery', () => {
  it('never accepts raw, incorrectly escaped LaTeX such as \\frac as successfully generated content', async () => {
    // In raw JSON, "\frac{1}{2}" uses a single backslash before 'f' (\f = form feed)
    const rawJson = String.raw`{"elements":[{"id":"latex_1","type":"latex","left":100,"top":100,"width":300,"height":100,"latex":"\frac{1}{2}"}]}`;
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
    const rawJson = String.raw`{"elements":[{"id":"latex_1","type":"latex","left":100,"top":100,"width":300,"height":100,"latex":"\times 4"}]}`;
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
    const rawJson = String.raw`{"elements":[{"id":"latex_1","type":"latex","left":100,"top":100,"width":300,"height":100,"latex":"\nu + \beta"}]}`;
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
    const validJson = String.raw`{"elements":[{"id":"latex_1","type":"latex","left":100,"top":100,"width":300,"height":100,"latex":"\\frac{1}{2} + \\times 4 + \\nu + \\beta"}],"remark":"Formulas intact"}`;
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

  it('correctly parses adjacent raw JSON Unicode escapes such as \\u03c0\\u00b2 without false rejection', async () => {
    const rawJson = String.raw`{"elements":[{"id":"latex_1","type":"latex","left":100,"top":100,"width":300,"height":100,"latex":"\u03c0\u00b2 + \\alpha"}],"remark":"Adjacent unicode"}`;
    const aiCall: AICallFn = vi.fn(async () => rawJson);
    const failures: SceneContentFailure[] = [];

    const content = (await generateSceneContent(slideOutline(), aiCall, {
      onFailure: (failure) => failures.push(failure),
    })) as GeneratedSlideContent;

    expect(content).not.toBeNull();
    expect(failures).toEqual([]);
    const latexEl = content.elements[0] as { type: string; latex: string; html?: string };
    expect(latexEl.latex).toBe('π² + \\alpha');
    expect(latexEl.html).toContain('katex');
    expect(latexEl.html).not.toContain('katex-error');
  });

  it('accepts legitimate JSON whitespace escapes \\n and \\t followed by non-letters', async () => {
    // In raw JSON, "latex":"x\n+ y\t= z" contains \n followed by '+' and \t followed by '='
    const rawJson = String.raw`{"elements":[{"id":"latex_1","type":"latex","left":100,"top":100,"width":300,"height":100,"latex":"x\n+ y\t= z"}],"remark":"Whitespace test"}`;
    const aiCall: AICallFn = vi.fn(async () => rawJson);
    const failures: SceneContentFailure[] = [];

    const content = (await generateSceneContent(slideOutline(), aiCall, {
      onFailure: (failure) => failures.push(failure),
    })) as GeneratedSlideContent;

    expect(content).not.toBeNull();
    expect(failures).toEqual([]);
    const latexEl = content.elements[0] as { type: string; latex: string; html?: string };
    expect(latexEl.latex).toBe('x\n+ y\t= z');
  });

  it('accepts valid JSON candidate when reasoning preamble contains malformed LaTeX JSON', async () => {
    const responseWithReasoning =
      '<think>\n' +
      'Let me consider this formula: {"latex": "\\frac{1}{2}"}\n' +
      'Wait, in unescaped form it might be: {"latex": "\frac{1}{2}"}\n' +
      '</think>\n' +
      '```json\n' +
      String.raw`{"elements":[{"id":"latex_1","type":"latex","left":100,"top":100,"width":300,"height":100,"latex":"\\frac{1}{2}"}],"remark":"Valid JSON candidate"}` +
      '\n```';

    const aiCall: AICallFn = vi.fn(async () => responseWithReasoning);
    const failures: SceneContentFailure[] = [];

    const content = (await generateSceneContent(slideOutline(), aiCall, {
      onFailure: (failure) => failures.push(failure),
    })) as GeneratedSlideContent;

    expect(content).not.toBeNull();
    expect(failures).toEqual([]);
    const latexEl = content.elements[0] as { type: string; latex: string; html?: string };
    expect(latexEl.latex).toBe('\\frac{1}{2}');
    expect(latexEl.html).toContain('katex');
  });

  it('accepts valid JSON candidate without codeblocks when reasoning preamble contains malformed LaTeX JSON', async () => {
    const responseWithReasoning =
      '<think>\n' +
      'Drafting formula with unescaped backslash: {"latex": "\times 4"}\n' +
      '</think>\n' +
      String.raw`{"elements":[{"id":"latex_1","type":"latex","left":100,"top":100,"width":300,"height":100,"latex":"\\times 4"}],"remark":"Valid candidate without fence"}`;

    const aiCall: AICallFn = vi.fn(async () => responseWithReasoning);
    const failures: SceneContentFailure[] = [];

    const content = (await generateSceneContent(slideOutline(), aiCall, {
      onFailure: (failure) => failures.push(failure),
    })) as GeneratedSlideContent;

    expect(content).not.toBeNull();
    expect(failures).toEqual([]);
    const latexEl = content.elements[0] as { type: string; latex: string; html?: string };
    expect(latexEl.latex).toBe('\\times 4');
  });

  it('returns null on malformed output, allowing caller to retry with a valid subsequent response', async () => {
    let callCount = 0;
    const aiCall: AICallFn = vi.fn(async () => {
      callCount += 1;
      if (callCount === 1) {
        // Attempt 1: malformed unescaped LaTeX
        return String.raw`{"elements":[{"id":"latex_1","type":"latex","left":100,"top":100,"width":300,"height":100,"latex":"\frac{1}{2}"}]}`;
      }
      // Attempt 2: valid, correctly escaped LaTeX
      return String.raw`{"elements":[{"id":"latex_1","type":"latex","left":100,"top":100,"width":300,"height":100,"latex":"\\frac{1}{2}"}]}`;
    });

    const firstResult = await generateSceneContent(slideOutline(), aiCall);
    expect(firstResult).toBeNull();
    expect(callCount).toBe(1);

    const secondResult = await generateSceneContent(slideOutline(), aiCall);
    expect(secondResult).not.toBeNull();
    expect(callCount).toBe(2);
    const latexEl = (secondResult as GeneratedSlideContent).elements[0] as { latex: string };
    expect(latexEl.latex).toBe('\\frac{1}{2}');
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

    // Valid parsed LaTeX passes
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
