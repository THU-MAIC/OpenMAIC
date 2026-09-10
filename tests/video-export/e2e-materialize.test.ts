import { describe, it, expect } from 'vitest';
import {
  mkdirSync,
  writeFileSync,
  rmSync,
  cpSync,
  existsSync,
  readFileSync,
  readdirSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import type { Locale } from '@/lib/i18n';
import type { Scene } from '@/lib/types/stage';
import { compileVideoTimeline, emitHyperframes } from '@/lib/video-export';
import type { CompilerScene } from '@/lib/video-export';
import { prepareInteractiveHtmlScenes } from '@/lib/video-export-app/prepare-interactive-html';
import {
  getVideoExportCoverLabels,
  resolveVideoExportCta,
} from '@/lib/video-export-app/cover-config';
import { NO_ASSETS, NO_PROBE, interactive, slide, speech } from './helpers';
import { QUIZ_SCROLL_LAYOUT_720P, quizScrollScene } from './quiz-scroll-fixture';

/**
 * Materializes a fully-emitted Hyperframes project (index.html + manifest +
 * subtitles + README + synthetic asset bytes + vendored GSAP) to a directory so
 * the real pinned Hyperframes lint CLI can be run against it:
 *
 *   HF_E2E_DIR=/tmp/hf-e2e npx vitest run tests/video-export/e2e-materialize.test.ts
 *   for dir in /tmp/hf-e2e/*; do npx --yes hyperframes@0.7.60 lint "$dir"; done
 *
 * The filesystem materializer is skipped unless HF_E2E_DIR is set. CI sets it
 * explicitly before linting every emitted sample.
 */
const OUT_DIR = process.env.HF_E2E_DIR;

// 1x1 transparent PNG — a valid image so a lint/render doesn't choke on the frame.
const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

function pblV2Card(order = 0): CompilerScene {
  return {
    id: `pbl-v2-${order}`,
    stageId: 'stage',
    title: 'PBL v2 fallback',
    order,
    type: 'pbl',
    content: {
      type: 'pbl',
      projectV2: {
        title: '构建一个确定、离线且可验证的渲染器 <Renderer>',
        description:
          '从设计数据建模、实现到真实 720p 渲染，验证超长中文描述与 SupercalifragilisticexpialidociousWithoutBreaks 不会撑破画面。',
        gains: [
          '把设计期数据与运行时状态彻底分离',
          '验证 HTML 转义、时间边界和超长英文单词换行',
          '在无网络条件下生成可复现视频',
        ],
        roles: [
          {
            id: 'instructor',
            type: 'instructor',
            name: 'Export Coach',
            description: '帮助你逐步推理确定性渲染、排查边界并完成发布前验证。',
          },
        ],
        milestones: [
          { id: 'design', microtasks: [{ id: 'model' }, { id: 'test' }] },
          { id: 'verify', microtasks: [{ id: 'render' }] },
        ],
        scenario: {
          characters: [{ id: 'reviewer', name: 'Release Reviewer' }],
        },
      },
    },
    actions: [],
  } as CompilerScene;
}

function pblLegacyCard(order = 0): CompilerScene {
  return {
    id: `pbl-legacy-${order}`,
    stageId: 'stage',
    title: 'Legacy PBL fallback',
    order,
    type: 'pbl',
    content: {
      type: 'pbl',
      projectConfig: {
        projectInfo: {
          title: 'Legacy export project',
          description: 'A stable fallback for packaged v1 projects.',
        },
        // The v1 generator's roster: development roles the learner picks
        // between, plus the issueboard's per-issue bots. No instructor.
        agents: [
          { name: 'Data Analyst', role_division: 'development', is_user_role: false },
          { name: 'Frontend Developer', role_division: 'development', is_user_role: false },
          { name: 'Question Agent - stage', is_system_agent: true },
          { name: 'Judge Agent - stage', is_system_agent: true },
        ],
        issueboard: {
          issues: [
            {
              id: 'stage',
              parent_issue: null,
              question_agent_name: 'Question Agent - stage',
              is_active: true,
            },
            { id: 'task', parent_issue: 'stage', question_agent_name: 'Question Agent - stage' },
          ],
        },
        chat: { messages: [] },
      },
    },
    actions: [],
  } as CompilerScene;
}

/** Every supported PBL field, in long CJK — the densest card the exporter emits. */
function pblDenseCard(order = 0): CompilerScene {
  return {
    id: `pbl-dense-${order}`,
    stageId: 'stage',
    title: 'PBL dense',
    order,
    type: 'pbl',
    content: {
      type: 'pbl',
      projectV2: {
        title: '构建一个确定性、离线可验证且支持超长中文标题排版的课程渲染导出流水线',
        description:
          '本项目要求你从设计数据出发，完成建模、实现与验证三个阶段，并在真实的 720p 与 480p 导出中确认排版不会撑破画面，同时保证字幕与封面共存。',
        gains: [
          '把设计期数据与运行时状态彻底分离，确保导出结果可复现',
          '验证 HTML 转义、时间边界与超长英文单词换行的实际表现',
          '在无网络条件下生成可复现的视频产物并通过 lint 校验',
          '为受限分辨率定义信息优先级，避免面板被静默裁切',
        ],
        roles: [
          {
            id: 'instructor',
            type: 'instructor',
            name: '导出教练',
            description: '帮助你逐步推进确定性渲染、排查边界并完成发布前验证。',
          },
        ],
        milestones: [
          { id: 'design', microtasks: [{ id: 'model' }, { id: 'test' }, { id: 'trace' }] },
          { id: 'build', microtasks: [{ id: 'emit' }, { id: 'lint' }] },
          { id: 'verify', microtasks: [{ id: 'render' }] },
        ],
        scenario: { characters: [{ id: 'reviewer', name: '发布评审员' }] },
      },
    },
    actions: [],
  } as CompilerScene;
}

function arabicPblCard(order = 0): CompilerScene {
  return {
    id: `pbl-arabic-${order}`,
    stageId: 'stage',
    title: 'مشروع تصدير الفيديو التعليمي',
    order,
    type: 'pbl',
    content: {
      type: 'pbl',
      projectV2: {
        title: 'إنشاء مشروع تعليمي قابل للتصدير والتحقق دون اتصال',
        description:
          'يبني المتعلم مساراً واضحاً من بيانات التصميم إلى التنفيذ، ثم يتحقق من ثبات النتيجة وسلامة التخطيط باللغة العربية.',
        gains: [
          'فصل بيانات التأليف عن حالة التشغيل المتغيرة',
          'التحقق من اتجاه النص وحدود بطاقة الغلاف',
          'إنتاج ملفات كاملة قابلة للفحص دون شبكة',
        ],
        roles: [
          {
            id: 'instructor',
            type: 'instructor',
            name: 'مرشد التصدير',
            description: 'يساعدك على التخطيط والتنفيذ والتحقق خطوة بخطوة.',
          },
        ],
        milestones: [
          { id: 'design', microtasks: [{ id: 'model' }] },
          { id: 'verify', microtasks: [{ id: 'lint' }] },
        ],
        scenario: {
          characters: [{ id: 'reviewer', name: 'مراجع الإصدار' }],
        },
      },
    },
    actions: [
      speech(
        `arabic-narration-${order}`,
        'يختبر هذا المثال محتوى عربياً حقيقياً مع اتجاه الصفحة من اليمين إلى اليسار.',
      ),
    ],
  } as CompilerScene;
}

interface MaterializedSample {
  name: string;
  scenes: CompilerScene[];
  width?: number;
  height?: number;
  locale?: Locale;
  marker: string;
  quizQuestionList?: boolean;
}

const DEFAULT_SAMPLE_LOCALE: Locale = 'en-US';
const DEFAULT_SAMPLE_CTA = resolveVideoExportCta(undefined);

function effectiveSampleOptions(sample: MaterializedSample) {
  const locale = sample.locale ?? DEFAULT_SAMPLE_LOCALE;
  return {
    width: sample.width ?? 1280,
    height: sample.height ?? 720,
    locale,
    labels: getVideoExportCoverLabels(locale),
    cta: DEFAULT_SAMPLE_CTA,
  };
}

const EXPECTED_SAMPLE_NAMES = [
  'quiz',
  'pbl-v2',
  'pbl-legacy',
  'pbl-dense',
  'mixed',
  'arabic',
  'interactive-static',
] as const;

const COMPLETE_PROJECT_FILES = [
  'LICENSES/Inter-OFL-1.1.txt',
  'README.md',
  'assets/vendor/gsap.min.js',
  'index.html',
  'openmaic-video-manifest.json',
  'subtitles.srt',
  'subtitles.vtt',
].sort();

const QUIZ_PROJECT_FILES = [
  ...COMPLETE_PROJECT_FILES,
  'LICENSES/KaTeX-MIT.txt',
  'LICENSES/Noto-Sans-KR-OFL-1.1.txt',
  'LICENSES/Noto-Sans-SC-OFL-1.1.txt',
].sort();
const MIXED_SCRIPT_QUIZ_PROJECT_FILES = [
  ...QUIZ_PROJECT_FILES,
  'LICENSES/Noto-Sans-Arabic-OFL-1.1.txt',
  'LICENSES/Noto-Sans-OFL-1.1.txt',
].sort();

const samples: MaterializedSample[] = [
  {
    name: 'quiz',
    scenes: [quizScrollScene()],
    marker: 'Quiz：确定性导出与超长标题排版验证',
    quizQuestionList: true,
  },
  {
    name: 'pbl-v2',
    scenes: [pblV2Card()],
    marker: '构建一个确定、离线且可验证的渲染器',
  },
  {
    name: 'pbl-legacy',
    scenes: [pblLegacyCard()],
    marker: 'Legacy export project',
  },
  {
    name: 'pbl-dense',
    scenes: [pblDenseCard()],
    width: 854,
    height: 480,
    marker: '构建一个确定性、离线可验证且支持超长中文标题排版',
  },
  {
    name: 'mixed',
    scenes: [
      slide('intro', [], {
        title: 'Mixed direction: English ثم العربية',
        order: 0,
        elements: [],
      }),
      quizScrollScene(1),
      pblV2Card(2),
    ],
    marker: 'Mixed direction: English ثم العربية',
  },
  {
    name: 'arabic',
    scenes: [arabicPblCard()],
    locale: 'ar-SA',
    marker: 'إنشاء مشروع تعليمي قابل للتصدير والتحقق دون اتصال',
  },
  {
    name: 'interactive-static',
    scenes: [
      {
        ...interactive(
          'interactive-static-fixture',
          '<!doctype html><html><head></head><body><h1>Frozen interactive fixture</h1></body></html>',
        ),
        title: 'Frozen interactive fixture',
      },
    ],
    marker: 'Frozen interactive fixture',
  },
];

describe('Hyperframes materialized sample contract', () => {
  it('defines the exact seven distinguishable sample directories', () => {
    expect(samples.map((sample) => sample.name)).toEqual(EXPECTED_SAMPLE_NAMES);
  });

  it('keeps the legacy, constrained, mixed-direction, and Arabic inputs genuine', () => {
    const byName = new Map(samples.map((sample) => [sample.name, sample]));
    const legacyContent = byName.get('pbl-legacy')!.scenes[0]!.content as Record<string, unknown>;

    expect(JSON.stringify(byName.get('quiz')!.scenes)).toContain('a^2+b^2=c^2');
    expect(JSON.stringify(byName.get('quiz')!.scenes)).toContain('Русский');
    expect(JSON.stringify(byName.get('quiz')!.scenes)).toContain('العربية');
    expect(legacyContent).toHaveProperty('projectConfig');
    expect(legacyContent).not.toHaveProperty('projectV2');
    expect(byName.get('pbl-dense')).toMatchObject({ width: 854, height: 480 });
    expect(JSON.stringify(byName.get('mixed')!.scenes)).toContain(
      'Mixed direction: English ثم العربية',
    );
    expect(byName.get('arabic')!.locale).toBe('ar-SA');
    expect(JSON.stringify(byName.get('arabic')!.scenes)).toMatch(/[\u0600-\u06ff]{4}/);
  });
});

describe.skipIf(!OUT_DIR)('materialize a Hyperframes project for real-CLI E2E', () => {
  it('writes a complete, self-contained project', async () => {
    const root = OUT_DIR!;

    rmSync(root, { recursive: true, force: true });
    for (const sample of samples) {
      const dir = join(root, sample.name);
      const preparedInteractive = await prepareInteractiveHtmlScenes(sample.scenes as Scene[]);
      const ir = compileVideoTimeline(
        { stage: { id: 'stage', name: `E2E ${sample.name}` }, scenes: sample.scenes },
        {
          timing: NO_PROBE,
          assets: NO_ASSETS,
          interactive: preparedInteractive,
          ...(sample.quizQuestionList
            ? {
                quizLayout: {
                  // This exact shared fixture is asserted against Chromium in
                  // cover-card-layout.browser.test.ts. Production exports use
                  // createQuizLayoutProbe instead of this pinned E2E geometry.
                  measureQuestionList: () => QUIZ_SCROLL_LAYOUT_720P,
                },
              }
            : {}),
        },
      );
      const project = emitHyperframes(ir, effectiveSampleOptions(sample));
      mkdirSync(dir, { recursive: true });

      // Emitted text files.
      for (const file of project.files) {
        const target = join(dir, file.path);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, file.content);
      }

      // Synthetic asset bytes for every present plan entry (frames get a real PNG).
      for (const entry of ir.assets.entries) {
        if (!entry.present || entry.dedupOf) continue;
        const target = join(dir, 'assets', entry.path);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(
          target,
          entry.kind === 'frame'
            ? PNG_1x1
            : entry.kind === 'html'
              ? Buffer.from(preparedInteractive.content(entry.assetId) ?? '')
              : Buffer.from(''),
        );
      }

      // Vendored Quiz fonts use the same committed public bytes as the app-side
      // measurement surface, then land at the project-relative CSS paths.
      for (const asset of project.vendorAssets) {
        const source = join(process.cwd(), 'public', asset.sourceUrl.replace(/^\//, ''));
        const target = join(dir, asset.path);
        mkdirSync(dirname(target), { recursive: true });
        cpSync(source, target);
      }

      // Vendored GSAP from the committed public copy.
      const gsapSrc = join(process.cwd(), 'public/vendor/gsap.min.js');
      const gsapDst = join(dir, project.gsapVendorPath);
      mkdirSync(dirname(gsapDst), { recursive: true });
      cpSync(gsapSrc, gsapDst);

      const expectedFiles = [
        ...(sample.name === 'quiz'
          ? MIXED_SCRIPT_QUIZ_PROJECT_FILES
          : sample.quizQuestionList
            ? QUIZ_PROJECT_FILES
            : COMPLETE_PROJECT_FILES),
        ...project.vendorAssets.map((asset) => asset.path),
      ].sort();
      expect(
        [
          ...project.files.map((file) => file.path),
          ...project.vendorAssets.map((asset) => asset.path),
          project.gsapVendorPath,
        ].sort(),
      ).toEqual(expectedFiles);
      for (const path of expectedFiles) {
        expect(existsSync(join(dir, path)), `${sample.name}/${path}`).toBe(true);
      }
      expect(
        project.files.map((file) => file.content).join('\n'),
        `${sample.name} authored marker`,
      ).toContain(sample.marker);
    }
    expect(readdirSync(root).sort()).toEqual([...EXPECTED_SAMPLE_NAMES].sort());
    const mixedHtml = readFileSync(join(root, 'mixed/index.html'), 'utf8');
    const quizHtml = readFileSync(join(root, 'quiz/index.html'), 'utf8');
    const arabicHtml = readFileSync(join(root, 'arabic/index.html'), 'utf8');
    const mixedLabels = getVideoExportCoverLabels('en-US');
    const arabicLabels = getVideoExportCoverLabels('ar-SA');

    expect(DEFAULT_SAMPLE_CTA).toEqual({ destination: 'open.maic.chat' });
    expect(quizHtml).toContain('data-visual-kind="quiz-question-list"');
    expect(quizHtml).not.toContain('SECRET_SAMPLE_ANALYSIS');
    for (const expected of [
      mixedLabels.quizCtaPrompt,
      mixedLabels.pblCtaPrompt,
      mixedLabels.ctaVisit,
      DEFAULT_SAMPLE_CTA!.destination,
    ]) {
      expect(mixedHtml, `mixed production cover chrome: ${expected}`).toContain(expected);
    }
    expect(arabicHtml).toContain('<html lang="ar-SA">');
    expect(arabicHtml).not.toMatch(/<html[^>]*\sdir=["'](?:rtl|auto)["']/);
    expect(arabicHtml).toContain('<div class="cover-panel cover-pbl-panel" dir="rtl">');
    for (const expected of [
      arabicLabels.pbl,
      arabicLabels.gains,
      arabicLabels.stages,
      arabicLabels.tasks,
      arabicLabels.pblCtaPrompt,
      arabicLabels.ctaVisit,
      DEFAULT_SAMPLE_CTA!.destination,
    ]) {
      expect(arabicHtml, `arabic production cover chrome: ${expected}`).toContain(expected);
    }
    console.log(
      `\n[hf-e2e] projects written to ${root}\n  for dir in ${root}/*; do npx --yes hyperframes@0.7.60 lint "$dir"; done\n`,
    );
  });
});
