import katex from 'katex';

export interface LatexEditorResult {
  readonly latex: string;
  readonly html: string;
  readonly width: number;
  readonly height: number;
}

export type LatexRenderResult = { readonly html: string } | { readonly error: string };

export function renderLatexSource(source: string): LatexRenderResult {
  try {
    return {
      html: katex.renderToString(source, {
        displayMode: true,
        output: 'html',
        throwOnError: true,
      }),
    };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : 'Invalid LaTex source.',
    };
  }
}

export function insertLatexAtSelection(
  source: string,
  selectionStart: number,
  selectionEnd: number,
  insertion: string,
): { value: string; cursor: number } {
  const start = Math.max(0, Math.min(selectionStart, source.length));
  const end = Math.max(start, Math.min(selectionEnd, source.length));
  return {
    value: `${source.slice(0, start)}${insertion}${source.slice(end)}`,
    cursor: start + insertion.length,
  };
}
