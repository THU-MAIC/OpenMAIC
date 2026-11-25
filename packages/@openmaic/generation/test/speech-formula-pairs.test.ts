import { describe, expect, it } from 'vitest';
import type { SpeechAction } from '@openmaic/dsl';
import {
  parseActionsFromStructuredOutput,
  speechForTts,
  splitSpeechFormulaPairs,
  stripInlineLatexForPlainTts,
} from '@openmaic/generation';

describe('splitSpeechFormulaPairs', () => {
  it('leaves ordinary prose untouched without setting spokenText', () => {
    expect(splitSpeechFormulaPairs('同学们好，今天我们来看导数的定义。')).toEqual({
      text: '同学们好，今天我们来看导数的定义。',
    });
  });

  it('splits inline [[$LaTeX$ | spoken]] pairs into KaTeX caption text and TTS spokenText', () => {
    const raw =
      "导数的定义是 [[$f'(x) = \\lim_{\\Delta x \\to 0} \\frac{\\Delta y}{\\Delta x}$ | f 撇 x 等于，当德尔塔 x 趋近于零时，德尔塔 y 比德尔塔 x 的极限]]。";
    expect(splitSpeechFormulaPairs(raw)).toEqual({
      text: "导数的定义是 $f'(x) = \\lim_{\\Delta x \\to 0} \\frac{\\Delta y}{\\Delta x}$。",
      spokenText: '导数的定义是 f 撇 x 等于，当德尔塔 x 趋近于零时，德尔塔 y 比德尔塔 x 的极限。',
    });
  });

  it('handles absolute value bars |x| and matrix brackets inside $...$ without mis-splitting', () => {
    const abs = splitSpeechFormulaPairs(
      '不等式 [[$|x - 1| + |x + 1| \\le 4$ | x 减一的绝对值加 x 加一的绝对值小于等于 4]]。',
    );
    expect(abs).toEqual({
      text: '不等式 $|x - 1| + |x + 1| \\le 4$。',
      spokenText: '不等式 x 减一的绝对值加 x 加一的绝对值小于等于 4。',
    });

    const mat = splitSpeechFormulaPairs(
      '矩阵转置 [[$A^T = \\begin{bmatrix} 1 & 2 \\\\ 3 & 4 \\end{bmatrix}$ | A 的转置等于二阶矩阵 1 2 3 4]]。',
    );
    expect(mat).toEqual({
      text: '矩阵转置 $A^T = \\begin{bmatrix} 1 & 2 \\\\ 3 & 4 \\end{bmatrix}$。',
      spokenText: '矩阵转置 A 的转置等于二阶矩阵 1 2 3 4。',
    });
  });

  it('wraps bare LaTeX in $...$ when the model omits dollar delimiters inside [[...|...]]', () => {
    expect(splitSpeechFormulaPairs('比值是 [[\\frac{a}{b} | b 分之 a]]。')).toEqual({
      text: '比值是 $\\frac{a}{b}$。',
      spokenText: '比值是 b 分之 a。',
    });
  });

  it('recovers single-backslash LaTeX commands in JSON (\\frac, \\theta, \\beta, \\to, \\pi)', () => {
    // Raw LLM output with unescaped single backslashes inside a JSON string:
    // \theta, \beta, \rightarrow, \frac are C-escapes; \pi is an invalid JSON escape.
    const response = String.raw`[{"type":"text","content":"角 [[$\theta + \beta \rightarrow \frac{\pi}{2}$ | θ 加 β 趋近于二分之 π]]。"}]`;
    const actions = parseActionsFromStructuredOutput(response, 'slide');
    expect(actions).toHaveLength(1);
    const speech = actions[0] as SpeechAction;
    expect(speech.text).toBe('角 $\\theta + \\beta \\rightarrow \\frac{\\pi}{2}$。');
    expect(speech.spokenText).toBe('角 θ 加 β 趋近于二分之 π。');
    expect(speechForTts(speech)).toBe('角 θ 加 β 趋近于二分之 π。');
  });

  it('unwraps [[$...$]] cleanly if the model omits the spoken half', () => {
    expect(splitSpeechFormulaPairs('面积公式 [[$S = \\pi r^2$]]。')).toEqual({
      text: '面积公式 $S = \\pi r^2$。',
    });
  });

  it('strips bare inline LaTeX for plain non-MOSS TTS engines', () => {
    expect(stripInlineLatexForPlainTts('面积 $S = \\frac{1}{2} r^2$。')).toBe(
      '面积 S = 2 分之 1 r 的平方。',
    );
  });
});

it('repairs an odd backslash without touching already escaped commands in the same JSON string', () => {
  const input = String.raw`[{"type":"text","content":"$\\pi + \sqrt{9}$"},]`;
  const [speech] = parseActionsFromStructuredOutput(input);
  expect(speech).toMatchObject({ text: String.raw`$\pi + \sqrt{9}$` });
});

it('keeps both currency amounts alongside a later formula and handles legacy delimiters', () => {
  expect(stripInlineLatexForPlainTts(String.raw`Pay $5 or $10 for \(x^2\) and $y^3$.`)).toBe(
    'Pay $5 or $10 for x squared and y cubed.',
  );
  expect(stripInlineLatexForPlainTts('Prices are $5, $10, and $20.')).toBe(
    'Prices are $5, $10, and $20.',
  );
  expect(stripInlineLatexForPlainTts('Prices are $5,$10, and $20.')).toBe(
    'Prices are $5,$10, and $20.',
  );
});

it('rewrites exact squares and cubes without corrupting multi-token braced exponents', () => {
  expect(stripInlineLatexForPlainTts('Compare $x^{2}$, $x^{2n}$, and $x^{3n}$.')).toBe(
    'Compare x squared, x^(2n), and x^(3n).',
  );
});
