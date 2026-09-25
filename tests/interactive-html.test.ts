import { describe, expect, it } from 'vitest';
import type { Scene } from '@/lib/types/stage';
import {
  buildInteractiveCourseFilename,
  buildInteractiveCourseHtml,
} from '@/lib/export/interactive-html';
import { buildJupyterNotebook } from '@/lib/export/jupyter';

describe('interactive HTML course export', () => {
  it('builds a self-contained offline handout with the required interaction surfaces', () => {
    const scene = {
      id: 'scene-1',
      stageId: 'stage-1',
      title: '变量与状态',
      order: 1,
      type: 'quiz',
      actions: [{ type: 'speech', text: '理解变量，就能描述数据的变化。' }],
      content: {
        type: 'quiz',
        questions: [
          {
            id: 'q-1',
            type: 'single',
            question: '变量最重要的作用是什么？',
            options: [{ label: '保存状态', value: 'A' }],
            answer: ['A'],
            analysis: '变量让程序能够记住并更新数据。',
          },
        ],
      },
    } as unknown as Scene;

    const html = buildInteractiveCourseHtml({
      courseName: '数据 <实验>',
      courseDescription: '从状态开始理解程序。',
      scenes: [scene],
      outlines: [
        {
          id: 'outline-1',
          type: 'quiz',
          title: '变量与状态',
          description: '建立变量的直觉。',
          keyPoints: ['变量', '状态'],
          order: 1,
        },
      ],
      generatedAt: 0,
    });

    expect(html).toContain('<!doctype html>');
    expect(html).toContain('实验课件预览版');
    expect(html).toContain('实验目标');
    expect(html).toContain('断言判分规则');
    expect(html).toContain('复制代码');
    expect(html).toContain('data-copy-code="code-1"');
    expect(html).toContain('data-copy-code="exercise-1"');
    expect(html).toContain('练习与断言判分');
    expect(html).toContain('TODO');
    expect(html).toContain('<details class="quiz-item">');
    expect(html).toContain('navigator.clipboard');
    expect(html).toContain('数据 &lt;实验&gt;');
    expect(html).not.toContain('数据 <实验>');
  });

  it('creates the requested Chinese HTML filename and removes unsafe characters', () => {
    expect(buildInteractiveCourseFilename('我的/课程:入门')).toBe('我的课程入门_互动实验课件.html');
    expect(buildInteractiveCourseFilename('')).toBe('互动实验课_互动实验课件.html');
  });

  it('exports runnable Fourier experiments to both HTML and Notebook formats', () => {
    const notebook = buildJupyterNotebook({
      title: '信号处理实验',
      outlines: [
        {
          title: '傅里叶波形与频谱',
          description: '观察正弦波叠加后的频域峰值。',
          keyPoints: ['傅里叶变换', '频域', '采样'],
        },
      ],
    });
    const code = notebook.cells.find((cell) => cell.cell_type === 'code');
    const source = code?.source.join('') ?? '';
    const codeCells = notebook.cells.filter((cell) => cell.cell_type === 'code');
    const exerciseSource = codeCells[1]?.source.join('') ?? '';

    expect(source).toContain('import numpy as np');
    expect(source).toContain('import matplotlib.pyplot as plt');
    expect(source).toContain('np.fft.rfft');
    expect(source).toContain('assert len(wave) == expected_samples');
    expect(source).toContain('plt.figure(');
    expect(source).toContain('plt.plot(t, wave');
    expect(source).toContain('plt.plot(frequencies, amplitude_spectrum');
    expect(source).toContain('plt.show()');
    expect(source).not.toContain('正在演示');
    expect(codeCells).toHaveLength(2);
    expect(codeCells[0]?.metadata).toMatchObject({ tags: ['experiment'] });
    expect(codeCells[1]?.metadata).toMatchObject({ tags: ['exercise', 'assertions'] });
    expect(exerciseSource).toContain('TODO');
    expect(exerciseSource).toContain('assert len(wave) == 1_000');
    expect(exerciseSource).toContain('assert np.isclose(freq, 50.0');
    expect(exerciseSource).toContain('🎉 所有断言测试通过！');
    expect(notebook.metadata.kernelspec?.name).toBe('python3');
  });
});
