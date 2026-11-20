import { describe, expect, it } from 'vitest';
import type { Action, SpeechAction } from '@/lib/types/action';
import { setSpeechTextClearAudioById } from '@/components/edit/ActionsBar/actions-edit';
import { narrationSpokenText, precedingSpeechTexts } from '@/lib/audio/moss-tts';
import { hasCaptionMath, renderCaptionMathText } from '@/lib/quiz/math-text';

describe('speech caption KaTeX and spokenText decoupling', () => {
  it('renders derivatives, ±, and matrices in captions as KaTeX HTML', () => {
    const segs = renderCaptionMathText(
      "求根公式 $x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}$，导数 $f'(x)$。",
    );
    const mathSegs = segs.filter((s) => s.type === 'math');
    expect(mathSegs).toHaveLength(2);
    expect(mathSegs[0]?.html).toContain('katex');
    expect(mathSegs[1]?.html).toContain('katex');
    expect(hasCaptionMath("导数 $f'(x)$")).toBe(true);
  });

  it('unwraps unparsed [[$LaTeX$ | spoken]] pairs cleanly when rendering captions', () => {
    const segs = renderCaptionMathText('面积是 [[$S = \\pi r^2$ | S 等于 π r 的平方]]。');
    expect(segs.some((s) => s.type === 'math')).toBe(true);
    expect(segs.map((s) => s.value).join('')).not.toContain('[[');
    expect(segs.map((s) => s.value).join('')).not.toContain('平方');
  });

  it('does not mis-render plain prose currency as math', () => {
    for (const line of [
      'Tickets cost $5 and $10 today.',
      'Prices are $5, $10, and $20.',
      'Prices are $5,$10, and $20.',
    ]) {
      expect(renderCaptionMathText(line)).toEqual([{ type: 'text', value: line }]);
      expect(hasCaptionMath(line)).toBe(false);
    }
  });

  it('uses spokenText for TTS and preceding 3-line context while keeping LaTeX in text', () => {
    const s1: SpeechAction = {
      id: 'a1',
      type: 'speech',
      text: '转置记作 $A^T$。',
      spokenText: '转置记作矩阵 A 的转置。',
    };
    const s2: SpeechAction = {
      id: 'a2',
      type: 'speech',
      text: '下一句。',
    };
    expect(narrationSpokenText(s1)).toBe('转置记作矩阵 A 的转置。');
    expect(precedingSpeechTexts([{ id: 'sc1', actions: [s1, s2] }], 'sc1', 'a2')).toEqual([
      '转置记作矩阵 A 的转置。',
    ]);
  });

  it('clears stale spokenText on manual edit and re-splits when [[...|...]] is entered', () => {
    const initial: Action[] = [
      {
        id: 'a1',
        type: 'speech',
        text: '旧公式 $A^T$',
        spokenText: '旧公式矩阵 A 的转置',
        audioId: 'ast_old',
      },
    ];
    const editedPlain = setSpeechTextClearAudioById(initial, 'a1', '手改后的新文本 $x^2$');
    expect(editedPlain[0]).toMatchObject({
      id: 'a1',
      type: 'speech',
      text: '手改后的新文本 $x^2$',
      audioInvalidated: true,
    });
    expect(editedPlain[0]).not.toHaveProperty('spokenText');
    expect(editedPlain[0]).not.toHaveProperty('audioId');

    const editedPaired = setSpeechTextClearAudioById(
      editedPlain,
      'a1',
      '反函数 [[$f^{-1}(x)$ | f 的反函数 x]]',
    );
    expect(editedPaired[0]).toMatchObject({
      id: 'a1',
      type: 'speech',
      text: '反函数 $f^{-1}(x)$',
      spokenText: '反函数 f 的反函数 x',
    });
  });
});
