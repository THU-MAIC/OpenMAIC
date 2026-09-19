import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Action } from '@openmaic/dsl';
import {
  compileVideoTimeline,
  emitHyperframes,
  type CompilerScene,
  type QuizLayoutProbe,
} from '@/lib/video-export';
import {
  KATEX_EXPORT_CSS,
  KATEX_MIT_LICENSE,
} from '@/lib/video-export/emit-hyperframes/katex-assets';
import { NO_ASSETS, stubProbe } from './helpers';

const layout = (contentHeightPx: number, viewportHeightPx: number): QuizLayoutProbe => ({
  measureQuestionList: () => ({ contentHeightPx, viewportHeightPx, frameHeightPx: 720 }),
});

function projectDigest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function compile(layoutProbe?: QuizLayoutProbe, visibleScriptText = '') {
  const quiz = {
    id: 'quiz',
    stageId: 'stage',
    title: 'Checkpoint <safe>',
    order: 0,
    type: 'quiz',
    content: {
      type: 'quiz',
      questions: [
        {
          id: 'single',
          type: 'single',
          question: `Which <script>bad()</script> value solves $x^2=4$? ${visibleScriptText}`,
          options: [
            { value: 'A', label: '<img src=x onerror=bad()>' },
            { value: 'B', label: '$2$' },
          ],
          answer: ['B'],
          analysis: 'SECRET_ANALYSIS',
        },
        {
          id: 'multiple',
          type: 'multiple',
          question: '选择所有满足 $a^2+b^2=c^2$ 的选项',
          options: [
            { value: 'A', label: '三、四、五' },
            { value: 'B', label: '5, 12, 13' },
          ],
          submission: 'SECRET_SUBMISSION',
        },
        {
          id: 'short',
          type: 'short_answer',
          question: 'Explain why $\\sqrt{4}=2$.',
          commentPrompt: 'SECRET_RUBRIC',
        },
      ],
    },
    actions: [{ id: 'speech', type: 'speech', text: 'Quiz narration' } as Action],
  } as CompilerScene;
  return compileVideoTimeline(
    { stage: { id: 'stage', name: 'Quiz list' }, scenes: [quiz] },
    {
      timing: stubProbe({ speech: 2400 }),
      assets: NO_ASSETS,
      ...(layoutProbe ? { quizLayout: layoutProbe } : {}),
    },
  );
}

const labels = {
  singleChoice: 'Single choice',
  multipleChoice: 'Multiple choice',
  shortAnswer: 'Short answer',
  answerPlaceholder: 'Write your answer',
};

describe('Quiz question-list KaTeX bundle', () => {
  it('contains complete offline KaTeX CSS, exactly 20 project-local WOFF2 faces, and the MIT license', () => {
    expect(KATEX_EXPORT_CSS).toContain('.katex');
    expect(KATEX_EXPORT_CSS.match(/url\("assets\/fonts\//g)).toHaveLength(20);
    expect(KATEX_EXPORT_CSS).not.toContain('data:font/woff2;base64,');
    expect(KATEX_MIT_LICENSE).toContain('The MIT License (MIT)');
    expect(KATEX_MIT_LICENSE).toContain('Copyright (c) 2013-2020 Khan Academy');
  });
});

describe('Quiz question-list Hyperframes emission', () => {
  it('declares no Quiz font assets when layout falls back to the cover-only path', () => {
    const project = emitHyperframes(compile(), { width: 1280, height: 720, labels });
    const html = project.files.find((file) => file.path === 'index.html')!.content;

    expect(project.vendorAssets).toEqual([]);
    expect(html).not.toContain('assets/fonts/');
    expect(project.files.map((file) => file.path)).not.toContain('LICENSES/KaTeX-MIT.txt');
    expect(
      project.files
        .map((file) => file.path)
        .filter((path) => /Noto-Sans(?:-Arabic)?-OFL-1\.1\.txt$/.test(path)),
    ).toEqual([]);
  });

  it('renders escaped static questions with shared math parsing and no learner controls/state', () => {
    const project = emitHyperframes(compile(layout(1001, 401)), {
      width: 1280,
      height: 720,
      labels,
    });
    const html = project.files.find((file) => file.path === 'index.html')!.content;

    expect(html).toContain('data-visual-kind="quiz-question-list"');
    expect(html).toContain('Which &lt;script&gt;bad()&lt;/script&gt; value solves');
    expect(html).not.toContain('<script>bad()</script>');
    expect(html).toContain('&lt;img src=x onerror=bad()&gt;');
    expect(html).toContain('class="katex"');
    expect(html).toContain('Single choice');
    expect(html).toContain('Multiple choice');
    expect(html).toContain('Short answer');
    expect(html).toContain('Write your answer');
    expect(html).not.toMatch(/<(?:input|textarea|button)\b/);
    expect(html).not.toMatch(/SECRET_(?:ANALYSIS|SUBMISSION|RUBRIC)/);
    expect(html).not.toMatch(/(?:scrollHeight|clientHeight|requestAnimationFrame)/);
    expect(html).toContain('url("assets/fonts/noto-sans-sc-chinese-simplified-400-normal.woff2")');
    expect(html).toContain('url("assets/fonts/noto-sans-kr-korean-400-normal.woff2")');
    expect(html).toContain(
      'font-family:"OpenMAIC Noto Sans Cyrillic","OpenMAIC Noto Sans Arabic",Inter,"OpenMAIC Noto Sans SC","OpenMAIC Noto Sans KR",sans-serif',
    );
  });

  it('keeps the committed script-font catalog complete and valid', () => {
    const expected = [
      'noto-sans-cyrillic-400-normal.woff2',
      'noto-sans-cyrillic-ext-400-normal.woff2',
      'noto-sans-arabic-arabic-400-normal.woff2',
    ];
    const publicNames = readdirSync(join(process.cwd(), 'public/vendor/video-export/fonts'));

    expect(publicNames).toEqual(expect.arrayContaining(expected));
  });

  it('does not select Cyrillic or Arabic files for a Latin/CJK-only question list', () => {
    const project = emitHyperframes(compile(layout(1001, 401)), {
      width: 1280,
      height: 720,
      labels,
    });
    const html = project.files.find((file) => file.path === 'index.html')!.content;
    const cssPaths = Array.from(
      html.matchAll(/url\("(assets\/fonts\/[^"?]+\.woff2)"\)/g),
      (match) => match[1],
    );
    const declaredPaths = project.vendorAssets.map((asset) => asset.path);

    expect(cssPaths).toHaveLength(new Set(cssPaths).size);
    expect(declaredPaths).toHaveLength(new Set(declaredPaths).size);
    expect(new Set(cssPaths)).toEqual(new Set(declaredPaths));
    expect(declaredPaths.filter((path) => /noto-sans-(?:cyrillic|arabic)/.test(path))).toEqual([]);
    expect(
      project.vendorAssets.every(
        ({ path, sourceUrl }) =>
          path === sourceUrl.replace('/vendor/video-export/fonts/', 'assets/fonts/'),
      ),
    ).toBe(true);
    expect(html).not.toMatch(/url\(["']?https?:\/\//);
    expect(project.files.map((file) => file.path)).toEqual(
      expect.arrayContaining([
        'LICENSES/KaTeX-MIT.txt',
        'LICENSES/Noto-Sans-SC-OFL-1.1.txt',
        'LICENSES/Noto-Sans-KR-OFL-1.1.txt',
      ]),
    );
    expect(
      project.files
        .map((file) => file.path)
        .filter((path) => /Noto-Sans(?:-Arabic)?-OFL-1\.1\.txt$/.test(path)),
    ).toEqual([]);
  });

  it('selects only the mixed surface script assets, CSS, licenses, and README entries', () => {
    const project = emitHyperframes(compile(layout(1001, 401), 'Привет, мир. مرحباً بالعالم.'), {
      width: 1280,
      height: 720,
      labels,
    });
    const html = project.files.find((file) => file.path === 'index.html')!.content;
    const readme = project.files.find((file) => file.path === 'README.md')!.content;
    const cssPaths = Array.from(
      html.matchAll(/url\("(assets\/fonts\/[^"?]+\.woff2)"\)/g),
      (match) => match[1],
    );
    const declaredPaths = project.vendorAssets.map((asset) => asset.path);
    const scriptPaths = declaredPaths.filter((path) => /noto-sans-(?:cyrillic|arabic)/.test(path));

    expect(scriptPaths).toEqual([
      'assets/fonts/noto-sans-cyrillic-400-normal.woff2',
      'assets/fonts/noto-sans-cyrillic-ext-400-normal.woff2',
      'assets/fonts/noto-sans-arabic-arabic-400-normal.woff2',
    ]);
    expect(new Set(cssPaths)).toEqual(new Set(declaredPaths));
    expect(html).not.toMatch(/url\(["']?https?:/);
    for (const asset of project.vendorAssets) {
      const bytes = readFileSync(join(process.cwd(), 'public', asset.sourceUrl.slice(1)));
      expect(bytes.subarray(0, 4)).toEqual(Buffer.from('wOF2'));
    }
    expect(project.files.map((file) => file.path)).toEqual(
      expect.arrayContaining([
        'LICENSES/Noto-Sans-OFL-1.1.txt',
        'LICENSES/Noto-Sans-Arabic-OFL-1.1.txt',
      ]),
    );
    expect(readme).toContain('Noto-Sans-OFL-1.1.txt');
    expect(readme).toContain('Noto-Sans-Arabic-OFL-1.1.txt');
    expect(readme).toContain('Quiz question-list CJK (Han/Kana/Hangul)');
    expect(projectDigest(project)).toBe(
      projectDigest(
        emitHyperframes(compile(layout(1001, 401), 'Привет, мир. مرحباً بالعالم.'), {
          width: 1280,
          height: 720,
          labels,
        }),
      ),
    );
  });
});
