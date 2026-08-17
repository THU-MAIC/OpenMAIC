/**
 * Cover-card layout guardrail — the estimator, checked against Chromium.
 *
 * The emitter plans optional PBL content without laying it out. This suite is
 * the browser proof that every planned card fits at the two supported compact
 * frame sizes, keeps core counts/CTA content, and preserves bidi boundaries.
 *
 * Run with `COVER_LAYOUT_BROWSER=1`; missing Chromium is then a hard failure.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Browser, type Page, type Request } from '@playwright/test';
import { compileVideoTimeline, emitHyperframes, prepareQuizQuestionList } from '@/lib/video-export';
import type { CompilerScene, QuizLayoutProbe, VideoExportCta } from '@/lib/video-export';
import { PBL_PANEL_DESIGN_BOX } from '@/lib/video-export/emit-hyperframes';
import {
  getVideoExportCoverLabels,
  resolveVideoExportCta,
} from '@/lib/video-export-app/cover-config';
import {
  createQuizQuestionListMeasurementSurface,
  measureQuizQuestionList,
} from '@/lib/video-export-app/quiz-layout';
import type { Locale } from '@/lib/i18n';
import { NO_ASSETS, NO_PROBE, speech } from './helpers';
import {
  QUIZ_SCROLL_LAYOUT_720P,
  QUIZ_SCROLL_QUESTIONS,
  QUIZ_SCROLL_TITLE,
  quizScrollScene,
} from './quiz-scroll-fixture';

const REQUIRED = process.env.COVER_LAYOUT_BROWSER === '1';

const FRAMES = {
  '720p': { width: 1280, height: 720 },
  '480p': { width: 854, height: 480 },
} as const;

const QUIZ_LIST_FRAMES = {
  '720p': { width: 1280, height: 720 },
  '1080p': { width: 1920, height: 1080 },
  '4k': { width: 3840, height: 2160 },
} as const;

interface CoverContent {
  title: string;
  description: string;
  gains: string[];
}

const CONTENT = {
  compactFive: {
    title: 'Compact deterministic project',
    description: '',
    gains: ['Model data', 'Implement output', 'Verify layout', 'Explain tradeoffs', 'Ship safely'],
  },
  cjk: {
    title: '构建一个确定性、离线可验证且支持超长中文标题排版的课程渲染导出流水线',
    description:
      '本项目要求你从设计数据出发，完成建模、实现与验证三个阶段，并在真实的 720p 与 480p 导出中确认排版不会撑破画面，同时保证字幕与封面共存。',
    gains: [
      '把设计期数据与运行时状态彻底分离，确保导出结果可复现',
      '验证 HTML 转义、时间边界与超长英文单词换行的实际表现',
      '在无网络条件下生成可复现的视频产物并通过 lint 校验',
      '为受限分辨率定义信息优先级，避免面板被静默裁切',
      '记录完整有效选项，让后续导出可以逐项核对',
    ],
  },
  repeatedM: {
    title: 'mmmm '.repeat(18),
    description: 'mmmm '.repeat(56),
    gains: Array.from({ length: 5 }, () => 'mmmm'.repeat(18)),
  },
  repeatedW: {
    title: 'wwww '.repeat(18),
    description: 'wwww '.repeat(56),
    gains: Array.from({ length: 5 }, () => 'wwww'.repeat(18)),
  },
  uppercaseW: {
    title: 'W'.repeat(40),
    description: 'WWWW '.repeat(48),
    gains: Array.from({ length: 5 }, () => 'W'.repeat(36)),
  },
  uppercaseM: {
    title: 'M'.repeat(40),
    description: 'MMMM '.repeat(48),
    gains: Array.from({ length: 5 }, () => 'M'.repeat(36)),
  },
  digits: {
    title: '0123456789'.repeat(4),
    description: '',
    gains: [],
  },
  emoji: {
    title: '🚀'.repeat(17),
    description: '🚀'.repeat(86),
    gains: Array.from({ length: 5 }, () => '🚀'.repeat(31)),
  },
  english: {
    title: 'Build a deterministic offline learning-video export',
    description:
      'Move from authored design data through implementation and browser verification without relying on learner runtime state.',
    gains: Array.from(
      { length: 5 },
      (_, index) => `Verify deterministic learner-facing output ${index + 1}`,
    ),
  },
  arabic: {
    title: 'مرحبا بك في مشروع التصدير الحتمي للفيديو التعليمي المفتوح المصدر',
    description:
      'يتطلب هذا المشروع منك الانتقال من بيانات التصميم إلى النمذجة والتنفيذ والتحقق، والتأكد من أن التخطيط لا يتجاوز حدود الإطار عند التصدير.',
    gains: Array.from(
      { length: 5 },
      () => 'افصل بيانات التصميم عن حالة التشغيل لضمان إمكانية إعادة إنتاج المخرجات',
    ),
  },
} satisfies Record<string, CoverContent>;

const DEFAULT_CTA = resolveVideoExportCta(undefined)!;
const WWW_CTA = resolveVideoExportCta('https://www.example.test/learn/')!;
const MAX_WIDTH_CTA = resolveVideoExportCta(`a.co/${'W'.repeat(91)}`)!;
const MAX_UNICODE_CTA_RAW = `a.co/${'学'.repeat(91)}`;
const MAX_UNICODE_CTA = resolveVideoExportCta(MAX_UNICODE_CTA_RAW)!;

interface CoverOptions {
  kind: 'quiz' | 'pbl';
  locale: Locale;
  cta: VideoExportCta;
  burnInSubtitles?: boolean;
}

function coverHtml(
  content: CoverContent,
  frame: { width: number; height: number },
  options: CoverOptions,
): string {
  const scene =
    options.kind === 'quiz'
      ? {
          id: 'quiz',
          stageId: 'stage',
          title: content.title,
          order: 0,
          type: 'quiz',
          content: {
            type: 'quiz',
            questions: [
              { id: 'q1', type: 'single', question: 'Hidden', points: 3, answer: ['Hidden'] },
              { id: 'q2', type: 'short_answer', question: 'Hidden', points: 2 },
            ],
          },
          actions: options.burnInSubtitles
            ? [speech('narration', 'A two-line subtitle must remain clear of the cover panel.')]
            : [],
        }
      : {
          id: 'pbl',
          stageId: 'stage',
          title: 'PBL',
          order: 0,
          type: 'pbl',
          content: {
            type: 'pbl',
            projectV2: {
              ...content,
              roles: [
                {
                  id: 'instructor',
                  type: 'instructor',
                  name: 'Export Coach 导出教练',
                  description: '帮助你逐步推理确定性渲染、排查边界并完成发布前验证。',
                },
              ],
              milestones: [
                { id: 'design', microtasks: [{ id: 'model' }, { id: 'test' }] },
                { id: 'verify', microtasks: [{ id: 'render' }] },
              ],
              scenario: {
                characters: [{ id: 'reviewer', name: 'Release Reviewer 发布评审员' }],
              },
            },
          },
          actions: options.burnInSubtitles
            ? [
                speech(
                  'narration',
                  '字幕与封面同时出现时，面板必须停在字幕带上方，而不是被它盖住。',
                ),
              ]
            : [],
        };

  const ir = compileVideoTimeline(
    { stage: { id: 'stage', name: 'cover-layout' }, scenes: [scene as CompilerScene] },
    { timing: NO_PROBE, assets: NO_ASSETS },
  );

  return emitHyperframes(ir, {
    ...frame,
    locale: options.locale,
    labels: getVideoExportCoverLabels(options.locale),
    cta: options.cta,
    burnInSubtitles: options.burnInSubtitles === true,
  }).files.find((file) => file.path === 'index.html')!.content;
}

const LONG_QUIZ_QUESTIONS = QUIZ_SCROLL_QUESTIONS;

function quizListHtml(
  frame: { width: number; height: number },
  questions: readonly unknown[],
  measurement: { contentHeightPx: number; viewportHeightPx: number },
): {
  html: string;
  scrollDistancePx: number;
  timing: {
    transitionStartMs: number;
    transitionEndMs: number;
    topHoldEndMs: number;
    scrollEndMs: number;
    bottomHoldEndMs: number;
  };
} {
  const source = {
    id: 'quiz-list',
    stageId: 'stage',
    title: QUIZ_SCROLL_TITLE,
    order: 0,
    type: 'quiz',
    content: { type: 'quiz', questions },
    actions: [speech('quiz-list-narration', 'Question-list narration')],
  } as CompilerScene;
  const probe: QuizLayoutProbe = {
    measureQuestionList: () => ({ ...measurement, frameHeightPx: frame.height }),
  };
  const ir = compileVideoTimeline(
    { stage: { id: 'stage', name: 'quiz-list-layout' }, scenes: [source] },
    { timing: NO_PROBE, assets: NO_ASSETS, quizLayout: probe },
  );
  const visual = ir.scenes[0].visuals.find((item) => item.kind === 'quiz-question-list');
  if (!visual || visual.kind !== 'quiz-question-list') throw new Error('Quiz list not planned');
  return {
    html: emitHyperframes(ir, {
      ...frame,
      locale: 'en-US',
      labels: getVideoExportCoverLabels('en-US'),
    }).files.find((file) => file.path === 'index.html')!.content,
    scrollDistancePx: visual.scrollDistancePx,
    timing: {
      transitionStartMs: visual.startMs,
      transitionEndMs: visual.startMs + visual.transitionDurationMs,
      topHoldEndMs: visual.startMs + visual.transitionDurationMs + visual.topHoldDurationMs,
      scrollEndMs:
        visual.startMs +
        visual.transitionDurationMs +
        visual.topHoldDurationMs +
        visual.scrollDurationMs,
      bottomHoldEndMs: visual.startMs + visual.durationMs,
    },
  };
}

const SCRIPT_FONT_MATRIX = [
  {
    name: 'Cyrillic',
    locale: 'ru-RU' as Locale,
    family: 'OpenMAIC Noto Sans Cyrillic',
    text: 'Привет Ёж Ԁ',
    expectedFontFiles: [
      'noto-sans-cyrillic-400-normal.woff2',
      'noto-sans-cyrillic-ext-400-normal.woff2',
    ],
  },
  {
    name: 'Arabic',
    locale: 'ar-SA' as Locale,
    family: 'OpenMAIC Noto Sans Arabic',
    text: 'العربية',
    expectedFontFiles: ['noto-sans-arabic-arabic-400-normal.woff2'],
  },
] as const;

function scriptFontQuizSource(script: (typeof SCRIPT_FONT_MATRIX)[number]): CompilerScene {
  return {
    id: `quiz-script-${script.name.toLowerCase()}`,
    stageId: 'stage',
    title: `${script.name} visible Quiz`,
    order: 0,
    type: 'quiz',
    content: {
      type: 'quiz',
      questions: Array.from({ length: 9 }, (_, index) => ({
        id: `${script.name.toLowerCase()}-${index + 1}`,
        type: 'single',
        question:
          script.name === 'Arabic'
            ? `اقرأ النص ${script.text} ثم قارن العربية مع الع\u200Cربية.`
            : `Прочитайте ${script.text} и выберите верный ответ.`,
        options: [
          { value: 'A', label: script.text },
          { value: 'B', label: `Question ${index + 1}` },
        ],
      })),
    },
    actions: [speech(`script-${script.name}`, `${script.name} Quiz narration`)],
  } as CompilerScene;
}

function scriptFontQuizHtml(
  frame: { width: number; height: number },
  script: (typeof SCRIPT_FONT_MATRIX)[number],
  measurement: { contentHeightPx: number; viewportHeightPx: number },
): { html: string; scrollEndMs: number; bottomHoldEndMs: number } {
  const source = scriptFontQuizSource(script);
  const ir = compileVideoTimeline(
    { stage: { id: 'stage', name: `${script.name} Quiz` }, scenes: [source] },
    {
      timing: NO_PROBE,
      assets: NO_ASSETS,
      quizLayout: {
        measureQuestionList: () => ({ ...measurement, frameHeightPx: frame.height }),
      },
    },
  );
  const visual = ir.scenes[0].visuals.find((item) => item.kind === 'quiz-question-list');
  if (!visual || visual.kind !== 'quiz-question-list') throw new Error('Quiz list not planned');
  return {
    html: emitHyperframes(ir, {
      ...frame,
      locale: script.locale,
      labels: getVideoExportCoverLabels(script.locale),
    }).files.find((file) => file.path === 'index.html')!.content,
    scrollEndMs:
      visual.startMs +
      visual.transitionDurationMs +
      visual.topHoldDurationMs +
      visual.scrollDurationMs,
    bottomHoldEndMs: visual.startMs + visual.durationMs,
  };
}

const GSAP = readFileSync(join(process.cwd(), 'public/vendor/gsap.min.js'), 'utf8');
const HARNESS_URL = 'http://cover-layout.test/index.html';

interface Measurement {
  overflow: number;
  panelTop: number;
  panelBottom: number;
  stageHeight: number;
  captionTop: number | null;
  statTiles: Array<{ count: string; label: string }>;
  ctaDirection: string | null;
  ctaLineTexts: string[];
  ctaLineHorizontalOverflows: number[];
  ctaLineVerticalOverflows: number[];
  destinationFragmentHorizontalOverflows: number[];
  interactiveCtaCount: number;
  gainCount: number;
  peopleCount: number;
  descriptionCount: number;
  titleDirection: string;
  chromeDirection: string;
  panelWidth: number;
  panelPaddingY: number;
  panelContentWidth: number;
}

async function loadEmittedHtml(page: Page, html: string): Promise<void> {
  const pageErrors: string[] = [];
  const gsapRequests: string[] = [];
  const recordPageError = (error: Error) => pageErrors.push(error.message);
  const recordRequest = (request: Request) => {
    if (request.url().endsWith('/assets/vendor/gsap.min.js')) gsapRequests.push(request.url());
  };
  page.on('pageerror', recordPageError);
  page.on('request', recordRequest);

  try {
    // `setContent` keeps the current document URL. Establish a controlled HTTP
    // base first so the production-relative vendored GSAP path is actually
    // requested and executed, just as it is from an unpacked export ZIP.
    await page.goto(HARNESS_URL, { waitUntil: 'load' });
    await page.setContent(html, { waitUntil: 'load' });
    await page.evaluate(async () => {
      await document.fonts.ready;
    });
    const runtime = await page.evaluate(() => {
      const globals = window as typeof window & {
        gsap?: unknown;
        __timelines?: Record<string, { duration?: unknown }>;
      };
      return {
        gsap: typeof globals.gsap,
        timelineKeys: Object.keys(globals.__timelines ?? {}),
        openmaicTimeline: typeof globals.__timelines?.openmaic?.duration === 'function',
      };
    });

    expect(pageErrors).toEqual([]);
    expect(gsapRequests).toEqual(['http://cover-layout.test/assets/vendor/gsap.min.js']);
    expect(runtime).toEqual({
      gsap: 'object',
      timelineKeys: ['openmaic'],
      openmaicTimeline: true,
    });
  } finally {
    page.off('pageerror', recordPageError);
    page.off('request', recordRequest);
  }
}

async function measure(
  page: Page,
  html: string,
  frame: { width: number; height: number },
): Promise<Measurement> {
  await page.setViewportSize(frame);
  await loadEmittedHtml(page, html);

  return page.evaluate(() => {
    const stage = document.querySelector<HTMLElement>('[data-composition-id]')!;
    const panel = document.querySelector<HTMLElement>('.cover-panel')!;
    const title = document.querySelector<HTMLElement>('.cover-title')!;
    const chrome = document.querySelector<HTMLElement>('.cover-eyebrow')!;
    const destination = document.querySelector<HTMLElement>('.cover-cta bdi');
    const cue = document.querySelector<HTMLElement>('#subtitle-cue-0');
    if (cue) cue.style.display = '-webkit-box';
    const stageBox = stage.getBoundingClientRect();
    const panelBox = panel.getBoundingClientRect();
    const panelStyle = getComputedStyle(panel);
    const ctaLines = Array.from(document.querySelectorAll<HTMLElement>('.cover-cta-line'));
    const destinationLine = destination?.closest<HTMLElement>('.cover-cta-line') ?? null;
    const destinationLineBox = destinationLine?.getBoundingClientRect() ?? null;

    let captionTop: number | null = null;
    if (cue) {
      const cueStyle = getComputedStyle(cue);
      const reserved =
        parseFloat(cueStyle.maxHeight) +
        parseFloat(cueStyle.paddingTop) +
        parseFloat(cueStyle.paddingBottom);
      captionTop = cue.getBoundingClientRect().bottom - stageBox.top - reserved;
    }

    return {
      overflow: panel.scrollHeight - panel.clientHeight,
      panelTop: panelBox.top - stageBox.top,
      panelBottom: panelBox.bottom - stageBox.top,
      stageHeight: stageBox.height,
      captionTop,
      statTiles: Array.from(document.querySelectorAll<HTMLElement>('.cover-stat')).map((tile) => ({
        count: tile.querySelector('strong')?.textContent ?? '',
        label: tile.querySelector('span')?.textContent ?? '',
      })),
      ctaDirection: destination ? getComputedStyle(destination).direction : null,
      ctaLineTexts: ctaLines.map((line) => (line.textContent ?? '').replace(/\s+/g, ' ').trim()),
      ctaLineHorizontalOverflows: ctaLines.map((line) =>
        Math.max(0, line.scrollWidth - line.clientWidth),
      ),
      ctaLineVerticalOverflows: ctaLines.map((line) =>
        Math.max(0, line.scrollHeight - line.clientHeight),
      ),
      destinationFragmentHorizontalOverflows:
        destination && destinationLineBox
          ? Array.from(destination.getClientRects()).map((fragment) =>
              Math.max(
                0,
                destinationLineBox.left - fragment.left,
                fragment.right - destinationLineBox.right,
              ),
            )
          : [],
      interactiveCtaCount: document.querySelectorAll('.cover-cta a, .cover-cta button').length,
      gainCount: document.querySelectorAll('.cover-gain-text').length,
      peopleCount: document.querySelectorAll('.cover-person').length,
      descriptionCount: document.querySelectorAll('.cover-description').length,
      titleDirection: getComputedStyle(title).direction,
      chromeDirection: getComputedStyle(chrome).direction,
      panelWidth: panelBox.width,
      panelPaddingY: parseFloat(panelStyle.paddingTop),
      panelContentWidth:
        panelBox.width -
        2 * parseFloat(panelStyle.borderLeftWidth) -
        2 * parseFloat(panelStyle.paddingLeft),
    };
  });
}

interface Scenario {
  name: string;
  kind: 'quiz' | 'pbl';
  frame: keyof typeof FRAMES;
  locale: Locale;
  content: CoverContent;
  cta: VideoExportCta;
  titleDirection: 'ltr' | 'rtl';
  chromeDirection: 'ltr' | 'rtl';
  burnInSubtitles?: boolean;
  expectedGainCount?: number;
  expectedDestination?: string;
}

const SCENARIOS: Scenario[] = [
  {
    name: 'Quiz default CTA',
    kind: 'quiz',
    frame: '720p',
    locale: 'en-US',
    content: CONTENT.english,
    cta: DEFAULT_CTA,
    titleDirection: 'ltr',
    chromeDirection: 'ltr',
  },
  {
    name: 'Quiz Arabic authored text in English UI with www override',
    kind: 'quiz',
    frame: '480p',
    locale: 'en-US',
    content: CONTENT.arabic,
    cta: WWW_CTA,
    titleDirection: 'rtl',
    chromeDirection: 'ltr',
  },
  {
    name: 'Quiz English authored text in real Arabic UI',
    kind: 'quiz',
    frame: '720p',
    locale: 'ar-SA',
    content: CONTENT.english,
    cta: DEFAULT_CTA,
    titleDirection: 'ltr',
    chromeDirection: 'rtl',
  },
  {
    name: 'Quiz real Arabic at compact resolution',
    kind: 'quiz',
    frame: '480p',
    locale: 'ar-SA',
    content: CONTENT.arabic,
    cta: WWW_CTA,
    titleDirection: 'rtl',
    chromeDirection: 'rtl',
  },
  ...(['720p', '480p'] as const).map(
    (frame): Scenario => ({
      name: `Quiz burn-in subtitles at ${frame}`,
      kind: 'quiz',
      frame,
      locale: 'en-US',
      content: CONTENT.english,
      cta: DEFAULT_CTA,
      titleDirection: 'ltr',
      chromeDirection: 'ltr',
      burnInSubtitles: true,
    }),
  ),
  {
    name: 'PBL retains five gains',
    kind: 'pbl',
    frame: '720p',
    locale: 'en-US',
    content: CONTENT.compactFive,
    cta: DEFAULT_CTA,
    titleDirection: 'ltr',
    chromeDirection: 'ltr',
    expectedGainCount: 5,
  },
  ...(['720p', '480p'] as const).flatMap((frame): Scenario[] => [
    {
      name: `Quiz accepted 96-character wide ASCII CTA at ${frame}`,
      kind: 'quiz',
      frame,
      locale: 'en-US',
      content: CONTENT.english,
      cta: MAX_WIDTH_CTA,
      titleDirection: 'ltr',
      chromeDirection: 'ltr',
    },
    {
      name: `Quiz maximum Unicode CTA in real Arabic UI at ${frame}`,
      kind: 'quiz',
      frame,
      locale: 'ar-SA',
      content: CONTENT.arabic,
      cta: MAX_UNICODE_CTA,
      expectedDestination: MAX_UNICODE_CTA_RAW,
      titleDirection: 'rtl',
      chromeDirection: 'rtl',
    },
    {
      name: `PBL accepted 96-character wide ASCII CTA at ${frame}`,
      kind: 'pbl',
      frame,
      locale: 'en-US',
      content: CONTENT.english,
      cta: MAX_WIDTH_CTA,
      titleDirection: 'ltr',
      chromeDirection: 'ltr',
    },
    {
      name: `PBL maximum Unicode CTA in real Arabic UI at ${frame}`,
      kind: 'pbl',
      frame,
      locale: 'ar-SA',
      content: CONTENT.arabic,
      cta: MAX_UNICODE_CTA,
      expectedDestination: MAX_UNICODE_CTA_RAW,
      titleDirection: 'rtl',
      chromeDirection: 'rtl',
    },
    {
      name: `PBL CJK at ${frame}`,
      kind: 'pbl',
      frame,
      locale: 'zh-CN',
      content: CONTENT.cjk,
      cta: DEFAULT_CTA,
      titleDirection: 'ltr',
      chromeDirection: 'ltr',
    },
    {
      name: `PBL repeated mmmm at ${frame}`,
      kind: 'pbl',
      frame,
      locale: 'en-US',
      content: CONTENT.repeatedM,
      cta: WWW_CTA,
      titleDirection: 'ltr',
      chromeDirection: 'ltr',
    },
    {
      name: `PBL repeated wwww at ${frame}`,
      kind: 'pbl',
      frame,
      locale: 'en-US',
      content: CONTENT.repeatedW,
      cta: DEFAULT_CTA,
      titleDirection: 'ltr',
      chromeDirection: 'ltr',
    },
    {
      name: `PBL uppercase W at ${frame}`,
      kind: 'pbl',
      frame,
      locale: 'en-US',
      content: CONTENT.uppercaseW,
      cta: DEFAULT_CTA,
      titleDirection: 'ltr',
      chromeDirection: 'ltr',
    },
    {
      name: `PBL uppercase M at ${frame}`,
      kind: 'pbl',
      frame,
      locale: 'en-US',
      content: CONTENT.uppercaseM,
      cta: WWW_CTA,
      titleDirection: 'ltr',
      chromeDirection: 'ltr',
    },
    {
      name: `PBL digits at ${frame}`,
      kind: 'pbl',
      frame,
      locale: 'en-US',
      content: CONTENT.digits,
      cta: DEFAULT_CTA,
      titleDirection: 'ltr',
      chromeDirection: 'ltr',
    },
    {
      name: `PBL emoji at ${frame}`,
      kind: 'pbl',
      frame,
      locale: 'en-US',
      content: CONTENT.emoji,
      cta: WWW_CTA,
      titleDirection: 'ltr',
      chromeDirection: 'ltr',
    },
    {
      name: `PBL Arabic authored text in English UI at ${frame}`,
      kind: 'pbl',
      frame,
      locale: 'en-US',
      content: CONTENT.arabic,
      cta: WWW_CTA,
      titleDirection: 'rtl',
      chromeDirection: 'ltr',
    },
    {
      name: `PBL English authored text in real Arabic UI at ${frame}`,
      kind: 'pbl',
      frame,
      locale: 'ar-SA',
      content: CONTENT.english,
      cta: DEFAULT_CTA,
      titleDirection: 'ltr',
      chromeDirection: 'rtl',
    },
    {
      name: `PBL burn-in subtitles at ${frame}`,
      kind: 'pbl',
      frame,
      locale: 'zh-CN',
      content: CONTENT.cjk,
      cta: WWW_CTA,
      titleDirection: 'ltr',
      chromeDirection: 'ltr',
      burnInSubtitles: true,
    },
  ]),
];

describe('Quiz/PBL cover cards in a real browser', () => {
  let browser: Browser | undefined;
  let page: Page | undefined;

  beforeAll(async () => {
    try {
      browser = await chromium.launch();
      page = await browser.newPage();
      await page.route(HARNESS_URL, (route) =>
        route.fulfill({
          body: '<!doctype html><html><body></body></html>',
          contentType: 'text/html',
        }),
      );
      await page.route('**/gsap.min.js', (route) =>
        route.fulfill({ body: GSAP, contentType: 'text/javascript' }),
      );
      await page.route('**/*.woff2', (route) => {
        const filename = new URL(route.request().url()).pathname.split('/').at(-1)!;
        route.fulfill({
          body: readFileSync(join(process.cwd(), 'public/vendor/video-export/fonts', filename)),
          contentType: 'font/woff2',
        });
      });
    } catch (error) {
      if (REQUIRED) throw error;
    }
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
  });

  const check = (name: string, run: (page: Page) => Promise<void>) =>
    it(name, async (ctx) => {
      if (!page) return ctx.skip();
      await run(page);
    });

  check('scopes Arabic direction below the document and composition roots', async (page) => {
    const html = coverHtml(CONTENT.arabic, FRAMES['720p'], {
      kind: 'pbl',
      locale: 'ar-SA',
      cta: WWW_CTA,
    });
    await loadEmittedHtml(page, html);

    expect(
      await page.evaluate(() => ({
        html: document.documentElement.getAttribute('dir'),
        body: document.body.getAttribute('dir'),
        composition: document
          .querySelector<HTMLElement>('[data-composition-id]')!
          .getAttribute('dir'),
        frame: document.querySelector<HTMLElement>('.cover-card')!.getAttribute('dir'),
        panel: document.querySelector<HTMLElement>('.cover-panel')!.getAttribute('dir'),
        title: document.querySelector<HTMLElement>('.cover-title')!.getAttribute('dir'),
        destination: document.querySelector<HTMLElement>('.cover-cta bdi')!.getAttribute('dir'),
        chromeDirection: getComputedStyle(document.querySelector<HTMLElement>('.cover-eyebrow')!)
          .direction,
      })),
    ).toEqual({
      html: null,
      body: null,
      composition: null,
      frame: null,
      panel: 'rtl',
      title: 'auto',
      destination: 'ltr',
      chromeDirection: 'rtl',
    });
  });

  for (const scenario of SCENARIOS) {
    check(`fits ${scenario.name}`, async (page) => {
      const frame = FRAMES[scenario.frame];
      const result = await measure(page, coverHtml(scenario.content, frame, scenario), frame);
      const labels = getVideoExportCoverLabels(scenario.locale);
      const expectedStats =
        scenario.kind === 'quiz'
          ? [
              { count: '2', label: labels.questions },
              { count: '5', label: labels.points },
            ]
          : [
              { count: '2', label: labels.stages },
              { count: '3', label: labels.tasks },
            ];
      const expectedPrompt = scenario.kind === 'quiz' ? labels.quizCtaPrompt : labels.pblCtaPrompt;
      const expectedDestination = scenario.expectedDestination ?? scenario.cta.destination;

      expect(
        result.overflow,
        JSON.stringify({
          scenario: scenario.name,
          destination: scenario.cta.destination,
          result,
        }),
      ).toBeLessThanOrEqual(0);
      expect(result.panelTop).toBeGreaterThanOrEqual(0);
      expect(result.panelBottom).toBeLessThanOrEqual(result.stageHeight);
      expect(result.statTiles).toEqual(expectedStats);
      expect(result.ctaLineTexts).toEqual([
        expectedPrompt,
        `${labels.ctaVisit} ${expectedDestination}`,
      ]);
      expect(result.ctaDirection).toBe('ltr');
      expect(result.ctaLineHorizontalOverflows).toEqual([0, 0]);
      expect(result.ctaLineVerticalOverflows).toEqual([0, 0]);
      expect(result.destinationFragmentHorizontalOverflows.length).toBeGreaterThan(0);
      expect(
        result.destinationFragmentHorizontalOverflows.every((overflow) => overflow === 0),
      ).toBe(true);
      expect(result.interactiveCtaCount).toBe(0);
      expect(result.titleDirection).toBe(scenario.titleDirection);
      expect(result.chromeDirection).toBe(scenario.chromeDirection);
      if (scenario.expectedGainCount !== undefined) {
        expect(result.gainCount).toBe(scenario.expectedGainCount);
      }
      if (scenario.burnInSubtitles) {
        expect(result.captionTop).not.toBeNull();
        expect(result.panelBottom).toBeLessThanOrEqual(result.captionTop!);
      }
    });
  }

  check('uses the same PBL design box in the planner and Chromium', async (page) => {
    const frame = FRAMES['720p'];
    const result = await measure(
      page,
      coverHtml(CONTENT.compactFive, frame, {
        kind: 'pbl',
        locale: 'en-US',
        cta: DEFAULT_CTA,
      }),
      frame,
    );

    expect(result.panelWidth).toBeCloseTo(PBL_PANEL_DESIGN_BOX.width, 1);
    expect(result.panelPaddingY).toBeCloseTo(PBL_PANEL_DESIGN_BOX.paddingY, 1);
    expect(result.panelContentWidth).toBeCloseTo(PBL_PANEL_DESIGN_BOX.contentWidth, 1);
  });

  check('retains a people row at its conservative height threshold', async (page) => {
    const frame = { width: 1280, height: 486 };
    const locale = 'en-US';
    const labels = getVideoExportCoverLabels(locale);
    const result = await measure(
      page,
      coverHtml({ title: 'People threshold', description: '', gains: [] }, frame, {
        kind: 'pbl',
        locale,
        cta: DEFAULT_CTA,
      }),
      frame,
    );

    expect(result.peopleCount).toBe(2);
    expect(result.gainCount).toBe(0);
    expect(result.descriptionCount).toBe(0);
    expect(result.overflow).toBeLessThanOrEqual(0);
    expect(result.panelBottom).toBeLessThanOrEqual(result.stageHeight);
    expect(result.statTiles).toEqual([
      { count: '2', label: labels.stages },
      { count: '3', label: labels.tasks },
    ]);
    expect(result.ctaLineTexts).toEqual([
      labels.pblCtaPrompt,
      `${labels.ctaVisit} ${DEFAULT_CTA.destination}`,
    ]);
  });

  for (const [name, frame] of Object.entries(QUIZ_LIST_FRAMES)) {
    check(
      `measures and reaches the real Quiz list bottom consistently at ${name}`,
      async (page) => {
        const initial = quizListHtml(frame, LONG_QUIZ_QUESTIONS, {
          contentHeightPx: frame.height * 2,
          viewportHeightPx: frame.height / 2,
        });
        await page.setViewportSize(frame);
        await loadEmittedHtml(page, initial.html);

        const reads = await page.evaluate(async () => {
          const values: Array<{ contentHeightPx: number; viewportHeightPx: number }> = [];
          for (let index = 0; index < 3; index += 1) {
            await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
            const content = document.querySelector<HTMLElement>('.quiz-list-content')!;
            const viewport = document.querySelector<HTMLElement>('.quiz-list-viewport')!;
            values.push({
              contentHeightPx: Math.ceil(content.scrollHeight),
              viewportHeightPx: Math.ceil(viewport.clientHeight),
            });
          }
          return values;
        });
        expect(reads[1]).toEqual(reads[0]);
        expect(reads[2]).toEqual(reads[0]);
        expect(reads[0].contentHeightPx).toBeGreaterThan(reads[0].viewportHeightPx);

        const resolved = quizListHtml(frame, LONG_QUIZ_QUESTIONS, reads[0]);
        await loadEmittedHtml(page, resolved.html);
        const geometry = await page.evaluate((distance) => {
          const viewport = document.querySelector<HTMLElement>('.quiz-list-viewport')!;
          const content = document.querySelector<HTMLElement>('.quiz-list-content')!;
          const first = document.querySelector<HTMLElement>('.quiz-list-question')!;
          const cards = document.querySelectorAll<HTMLElement>('.quiz-list-question');
          const last = cards[cards.length - 1]!;
          const viewportBox = viewport.getBoundingClientRect();
          const firstTop = first.getBoundingClientRect().top;
          const fontReady = document.fonts.check('16px KaTeX_Math');
          const math = document.querySelector<HTMLElement>('.katex .mathnormal');
          content.style.transform = `translateY(-${distance}px)`;
          const lastBottom = last.getBoundingClientRect().bottom;
          return {
            firstOffsetPx: firstTop - viewportBox.top,
            lastOffsetPx: lastBottom - viewportBox.bottom,
            fontReady,
            mathFontFamily: math ? getComputedStyle(math).fontFamily : '',
            externalFontUrls: Array.from(document.styleSheets)
              .flatMap((sheet) => {
                try {
                  return Array.from(sheet.cssRules, (rule) => rule.cssText);
                } catch {
                  return [];
                }
              })
              .filter((rule) => /url\(["']?https?:\/\//.test(rule)),
          };
        }, resolved.scrollDistancePx);

        expect(geometry.firstOffsetPx).toBeCloseTo(0, 0);
        expect(Math.abs(geometry.lastOffsetPx)).toBeLessThanOrEqual(1);
        expect(geometry.fontReady).toBe(true);
        expect(geometry.mathFontFamily).toContain('KaTeX_Math');
        expect(geometry.externalFontUrls).toEqual([]);
      },
    );
  }

  for (const script of SCRIPT_FONT_MATRIX) {
    for (const frame of [QUIZ_LIST_FRAMES['720p'], QUIZ_LIST_FRAMES['1080p']]) {
      check(
        `keeps ${script.name} Quiz font measurement and emitted geometry deterministic at ${frame.width}x${frame.height}`,
        async (page) => {
          const source = scriptFontQuizSource(script);
          const surface = createQuizQuestionListMeasurementSurface({
            content: { title: source.title, questions: prepareQuizQuestionList(source) },
            width: frame.width,
            height: frame.height,
            locale: script.locale,
            labels: getVideoExportCoverLabels(script.locale),
          });
          const measurementFontRequests: string[] = [];
          const emissionFontRequests: string[] = [];
          let fontRequestPhase: 'measurement' | 'emission' = 'measurement';
          const recordFontRequest = (request: Request) => {
            if (request.resourceType() !== 'font') return;
            (fontRequestPhase === 'measurement'
              ? measurementFontRequests
              : emissionFontRequests
            ).push(request.url());
          };
          page.on('request', recordFontRequest);
          try {
            await page.setViewportSize(frame);
            await page.goto(HARNESS_URL, { waitUntil: 'load' });
            const measured = await page.evaluate(
              async ({ source: measureSource, input }) => {
                const measure = (0, eval)(`(${measureSource})`) as (
                  value: typeof input,
                ) => Promise<{ contentHeightPx: number; viewportHeightPx: number } | null>;
                const first = await measure(input);
                const second = await measure(input);
                return {
                  first,
                  second,
                  remainingHosts: document.querySelectorAll('#quiz-layout-measurement').length,
                };
              },
              { source: measureQuizQuestionList.toString(), input: surface },
            );

            expect(measured.first).not.toBeNull();
            expect(measured.second).toEqual(measured.first);
            expect(measured.remainingHosts).toBe(0);
            expect(
              new Set(
                measurementFontRequests
                  .map((url) => new URL(url).pathname)
                  .filter((path) => /noto-sans-(?:cyrillic|arabic)/.test(path)),
              ),
            ).toEqual(
              new Set(script.expectedFontFiles.map((file) => `/vendor/video-export/fonts/${file}`)),
            );

            const emitted = scriptFontQuizHtml(frame, script, measured.first!);
            fontRequestPhase = 'emission';
            await loadEmittedHtml(page, emitted.html);
            const browserProof = await page.evaluate(
              async ({ family, text, arabic, scrollEndMs, bottomHoldEndMs }) => {
                const loaded = await document.fonts.load(`40px "${family}"`, text);
                const signature = (value: string, font: string): number => {
                  const canvas = document.createElement('canvas');
                  canvas.width = 320;
                  canvas.height = 80;
                  const context = canvas.getContext('2d')!;
                  context.font = `40px ${font}`;
                  context.fillText(value, 0, 56);
                  let result = 0;
                  for (const channel of context.getImageData(0, 0, 320, 80).data) {
                    result = (result * 31 + channel) >>> 0;
                  }
                  return result;
                };
                const timeline = (
                  window as typeof window & {
                    __timelines: Record<
                      string,
                      { time(value: number, suppressEvents?: boolean): unknown }
                    >;
                  }
                ).__timelines.openmaic;
                const content = document.querySelector<HTMLElement>('.quiz-list-content')!;
                const viewport = document.querySelector<HTMLElement>('.quiz-list-viewport')!;
                const cards = document.querySelectorAll<HTMLElement>('.quiz-list-question');
                const last = cards[cards.length - 1]!;
                const lastOffsetAt = (timeMs: number) => {
                  timeline.time(timeMs / 1000, false);
                  return (
                    last.getBoundingClientRect().bottom - viewport.getBoundingClientRect().bottom
                  );
                };
                const joinedArabic = 'العربية';
                const zwnjArabic = 'الع\u200Cربية';
                const arabicPrompt = arabic
                  ? Array.from(document.querySelectorAll<HTMLElement>('.quiz-list-prompt')).find(
                      (node) => node.textContent?.includes(zwnjArabic),
                    )
                  : undefined;
                const arabicTextNode = arabicPrompt
                  ? Array.from(arabicPrompt.childNodes).find(
                      (node) =>
                        node.nodeType === Node.TEXT_NODE && node.textContent?.includes(zwnjArabic),
                    )
                  : undefined;
                const rangeWidth = (value: string): number | null => {
                  if (!arabicTextNode?.textContent) return null;
                  const start = arabicTextNode.textContent.indexOf(value);
                  if (start < 0) return null;
                  const range = document.createRange();
                  range.setStart(arabicTextNode, start);
                  range.setEnd(arabicTextNode, start + value.length);
                  return range.getBoundingClientRect().width;
                };
                const joinedArabicWidth = arabic ? rangeWidth(joinedArabic) : null;
                const zwnjArabicWidth = arabic ? rangeWidth(zwnjArabic) : null;
                return {
                  selectedFaceCount: loaded.length,
                  checked: document.fonts.check(`40px "${family}"`, text),
                  covered:
                    signature(text, `"${family}", monospace`) !== signature(text, 'monospace'),
                  shellDirection: document.querySelector('.quiz-list-shell')?.getAttribute('dir'),
                  promptDirections: Array.from(document.querySelectorAll('.quiz-list-prompt')).map(
                    (node) => node.getAttribute('dir'),
                  ),
                  scrollEndOffsetPx: lastOffsetAt(scrollEndMs),
                  bottomHoldOffsetPx: lastOffsetAt(bottomHoldEndMs),
                  transform: getComputedStyle(content).transform,
                  arabicPromptDirection: arabicPrompt
                    ? getComputedStyle(arabicPrompt).direction
                    : null,
                  joinedArabicWidth,
                  zwnjArabicWidth,
                };
              },
              {
                family: script.family,
                text: script.text,
                arabic: script.name === 'Arabic',
                scrollEndMs: emitted.scrollEndMs,
                bottomHoldEndMs: emitted.bottomHoldEndMs,
              },
            );

            expect(browserProof.selectedFaceCount).toBeGreaterThan(0);
            expect(browserProof.checked).toBe(true);
            expect(browserProof.covered).toBe(true);
            expect(browserProof.shellDirection).toBe(script.locale === 'ar-SA' ? 'rtl' : 'ltr');
            expect(browserProof.promptDirections).toEqual(
              expect.arrayContaining([expect.stringMatching(/^auto$/)]),
            );
            expect(Math.abs(browserProof.scrollEndOffsetPx)).toBeLessThanOrEqual(1);
            expect(Math.abs(browserProof.bottomHoldOffsetPx)).toBeLessThanOrEqual(1);
            expect(browserProof.transform).not.toBe('none');
            if (script.name === 'Arabic') {
              expect(browserProof.arabicPromptDirection).toBe('rtl');
              expect(browserProof.joinedArabicWidth).toBeGreaterThan(0);
              expect(browserProof.zwnjArabicWidth).toBeGreaterThan(0);
              const shapingPrompt = page
                .locator('.quiz-list-question')
                .last()
                .locator('.quiz-list-prompt');
              const originalPrompt = await shapingPrompt.textContent();
              let joinedArabic: Buffer;
              let zwnjArabic: Buffer;
              try {
                await shapingPrompt.evaluate((node) => {
                  node.textContent = 'العربية';
                });
                joinedArabic = await shapingPrompt.screenshot();
                await shapingPrompt.evaluate((node) => {
                  node.textContent = 'الع\u200Cربية';
                });
                zwnjArabic = await shapingPrompt.screenshot();
              } finally {
                await shapingPrompt.evaluate((node, text) => {
                  node.textContent = text;
                }, originalPrompt);
              }
              expect(joinedArabic.equals(zwnjArabic)).toBe(false);
            }
          } finally {
            page.off('request', recordFontRequest);
          }

          expect(
            new Set(
              emissionFontRequests
                .map((url) => new URL(url).pathname)
                .filter((path) => /noto-sans-(?:cyrillic|arabic)/.test(path)),
            ),
          ).toEqual(new Set(script.expectedFontFiles.map((file) => `/assets/fonts/${file}`)));
          expect(
            [...measurementFontRequests, ...emissionFontRequests].every(
              (url) => new URL(url).origin === 'http://cover-layout.test',
            ),
          ).toBe(true);
        },
      );
    }
  }

  for (const blockedStep of ['fonts', 'animation-frame'] as const) {
    check(`bounds Quiz measurement when ${blockedStep} never settles`, async (page) => {
      const frame = QUIZ_LIST_FRAMES['720p'];
      const fixture = quizScrollScene();
      const surface = createQuizQuestionListMeasurementSurface({
        content: {
          title: fixture.title,
          questions: prepareQuizQuestionList(fixture),
        },
        width: frame.width,
        height: frame.height,
        locale: 'en-US',
        labels: getVideoExportCoverLabels('en-US'),
      });
      await page.setViewportSize(frame);
      await page.goto(HARNESS_URL, { waitUntil: 'load' });

      const result = await page.evaluate(
        async ({ source, input, blocked }) => {
          const measure = (0, eval)(`(${source})`) as (
            value: typeof input,
            timeoutMs?: number,
          ) => Promise<unknown>;
          const originalRaf = window.requestAnimationFrame;
          if (blocked === 'fonts') {
            Object.defineProperty(document, 'fonts', {
              configurable: true,
              value: { ready: new Promise<void>(() => {}) },
            });
          } else {
            window.requestAnimationFrame = () => 0;
          }

          const outcome = await Promise.race([
            measure(input, 40).then((value) => ({ settled: true, value })),
            new Promise<{ settled: false; value: null }>((resolve) =>
              setTimeout(() => resolve({ settled: false, value: null }), 250),
            ),
          ]);
          const remainingHosts = document.querySelectorAll('#quiz-layout-measurement').length;

          window.requestAnimationFrame = originalRaf;
          if (blocked === 'fonts') {
            delete (document as unknown as { fonts?: FontFaceSet }).fonts;
          }
          document.querySelector('#quiz-layout-measurement')?.remove();
          return { ...outcome, remainingHosts };
        },
        { source: measureQuizQuestionList.toString(), input: surface, blocked: blockedStep },
      );

      expect(result).toEqual({ settled: true, value: null, remainingHosts: 0 });
      const degraded = compileVideoTimeline(
        { stage: { id: 'stage', name: 'deadline fallback' }, scenes: [fixture] },
        {
          timing: NO_PROBE,
          assets: NO_ASSETS,
          quizLayout: { measureQuestionList: () => result.value as null },
        },
      );
      expect(degraded.scenes[0].visuals).not.toContainEqual(
        expect.objectContaining({ kind: 'quiz-question-list' }),
      );
      expect(degraded.diagnostics).toContainEqual(
        expect.objectContaining({ code: 'quiz-layout-unavailable', sceneId: fixture.id }),
      );
    });
  }

  for (const fontLoadResult of ['reject', 'empty', 'pending'] as const) {
    check(`falls back when a selected Quiz font load is ${fontLoadResult}`, async (page) => {
      const frame = QUIZ_LIST_FRAMES['720p'];
      const fixture = quizScrollScene();
      const questions = prepareQuizQuestionList(fixture).map((question, index) =>
        index === 0 ? { ...question, question: `Проверка: ${question.question}` } : question,
      );
      const surface = createQuizQuestionListMeasurementSurface({
        content: { title: fixture.title, questions },
        width: frame.width,
        height: frame.height,
        locale: 'ru-RU',
        labels: getVideoExportCoverLabels('ru-RU'),
      });
      expect(surface.requiredFontLoads).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ family: 'OpenMAIC Noto Sans Cyrillic' }),
        ]),
      );
      await page.setViewportSize(frame);
      await page.goto(HARNESS_URL, { waitUntil: 'load' });

      const result = await page.evaluate(
        async ({ source, input, outcome }) => {
          const measure = (0, eval)(`(${source})`) as (
            value: typeof input,
            timeoutMs?: number,
          ) => Promise<unknown>;
          const fonts = document.fonts;
          const ownLoad = Object.getOwnPropertyDescriptor(fonts, 'load');
          Object.defineProperty(fonts, 'load', {
            configurable: true,
            value: () => {
              if (outcome === 'reject') return Promise.reject(new Error('font load failed'));
              if (outcome === 'empty') return Promise.resolve([]);
              return new Promise<FontFace[]>(() => {});
            },
          });

          const measured = await Promise.race([
            measure(input, 40).then((value) => ({ settled: true, value })),
            new Promise<{ settled: false; value: null }>((resolve) =>
              setTimeout(() => resolve({ settled: false, value: null }), 250),
            ),
          ]);
          const remainingHosts = document.querySelectorAll('#quiz-layout-measurement').length;
          if (ownLoad) Object.defineProperty(fonts, 'load', ownLoad);
          else delete (fonts as unknown as { load?: unknown }).load;
          document.querySelector('#quiz-layout-measurement')?.remove();
          return { ...measured, remainingHosts };
        },
        {
          source: measureQuizQuestionList.toString(),
          input: surface,
          outcome: fontLoadResult,
        },
      );

      expect(result).toEqual({ settled: true, value: null, remainingHosts: 0 });
    });
  }

  check('fails closed when visible script text is missing from the vendored cmap', async (page) => {
    const frame = QUIZ_LIST_FRAMES['720p'];
    await page.setViewportSize(frame);
    await page.goto(HARNESS_URL, { waitUntil: 'load' });
    for (const { character, family } of [
      { character: '\u1d2b', family: 'OpenMAIC Noto Sans Cyrillic' },
      { character: '\u1c89', family: 'OpenMAIC Noto Sans Cyrillic' },
      { character: '\u0897', family: 'OpenMAIC Noto Sans Arabic' },
    ]) {
      const surface = createQuizQuestionListMeasurementSurface({
        content: {
          title: 'Unsupported script coverage',
          questions: [
            {
              id: 'unsupported-script',
              type: 'single',
              question: `Missing glyph: ${character}`,
              options: [],
            },
          ],
        },
        width: frame.width,
        height: frame.height,
        locale: 'en-US',
        labels: getVideoExportCoverLabels('en-US'),
      });
      expect(surface.requiredFontLoads.at(-1)).toEqual({ family, text: character });

      const result = await page.evaluate(
        async ({ source, input }) => {
          const measure = (0, eval)(`(${source})`) as (value: typeof input) => Promise<unknown>;
          const value = await measure(input);
          return {
            value,
            remainingHosts: document.querySelectorAll('#quiz-layout-measurement').length,
          };
        },
        { source: measureQuizQuestionList.toString(), input: surface },
      );

      expect(result).toEqual({ value: null, remainingHosts: 0 });
    }
  });

  check('runs the production Quiz measurer and emitted timeline end to end', async (page) => {
    const frame = QUIZ_LIST_FRAMES['720p'];
    const initial = quizListHtml(frame, LONG_QUIZ_QUESTIONS, {
      contentHeightPx: frame.height * 2,
      viewportHeightPx: frame.height / 2,
    });
    await page.setViewportSize(frame);
    await loadEmittedHtml(page, initial.html);

    const fixture = quizScrollScene();
    const surface = createQuizQuestionListMeasurementSurface({
      content: {
        title: fixture.title,
        questions: prepareQuizQuestionList(fixture),
      },
      width: frame.width,
      height: frame.height,
      locale: 'en-US',
      labels: getVideoExportCoverLabels('en-US'),
    });
    const measureSource = measureQuizQuestionList.toString();
    const measured = await page.evaluate(
      async ({ source, input }) => {
        try {
          const measure = (0, eval)(`(${source})`) as (value: typeof input) => Promise<{
            contentHeightPx: number;
            viewportHeightPx: number;
            frameHeightPx: number;
          } | null>;
          return {
            value: await measure(input),
            error: null,
            remainingHosts: document.querySelectorAll('#quiz-layout-measurement').length,
          };
        } catch (error) {
          return {
            value: null,
            error: error instanceof Error ? error.message : String(error),
            remainingHosts: document.querySelectorAll('#quiz-layout-measurement').length,
          };
        }
      },
      { source: measureSource, input: surface },
    );

    expect(measured.error).toBeNull();
    expect(measured.remainingHosts).toBe(0);
    expect(measured.value).toEqual(QUIZ_SCROLL_LAYOUT_720P);
    expect(surface.css).not.toMatch(/url\(["']?https?:\/\//);
    expect(
      await page.evaluate(() => document.fonts.check('16px "OpenMAIC Noto Sans SC"', '中文')),
    ).toBe(true);
    const cjkCoverage = await page.evaluate(async () => {
      await Promise.all([
        document.fonts.load('40px "OpenMAIC Noto Sans SC"', '漢字あア'),
        document.fonts.load('40px "OpenMAIC Noto Sans KR"', '한글'),
      ]);
      const signature = (text: string, font: string): number => {
        const canvas = document.createElement('canvas');
        canvas.width = 256;
        canvas.height = 64;
        const context = canvas.getContext('2d')!;
        context.font = `40px ${font}`;
        context.fillText(text, 0, 44);
        let hash = 2_166_136_261;
        for (const value of context.getImageData(0, 0, 256, 64).data) {
          hash ^= value;
          hash = Math.imul(hash, 16_777_619);
        }
        return hash >>> 0;
      };
      const covered = (text: string, family: string): boolean =>
        signature(text, `"${family}", monospace`) !== signature(text, 'monospace');
      return {
        han: covered('漢字', 'OpenMAIC Noto Sans SC'),
        kana: covered('あア', 'OpenMAIC Noto Sans SC'),
        hangul: covered('한글', 'OpenMAIC Noto Sans KR'),
      };
    });
    expect(cjkCoverage).toEqual({ han: true, kana: true, hangul: true });

    const resolved = quizListHtml(frame, LONG_QUIZ_QUESTIONS, measured.value!);
    await loadEmittedHtml(page, resolved.html);
    const checkpoints = await page.evaluate((timing) => {
      const timeline = (
        window as typeof window & {
          __timelines: Record<string, { time(value: number, suppressEvents?: boolean): unknown }>;
        }
      ).__timelines.openmaic;
      const cover = document.querySelector<HTMLElement>('#scene-1-visual-1')!;
      const list = document.querySelector<HTMLElement>('#scene-1-visual-2')!;
      const content = document.querySelector<HTMLElement>('.quiz-list-content')!;
      const viewport = document.querySelector<HTMLElement>('.quiz-list-viewport')!;
      const first = document.querySelector<HTMLElement>('.quiz-list-question')!;
      const cards = document.querySelectorAll<HTMLElement>('.quiz-list-question');
      const last = cards[cards.length - 1]!;
      const read = (timeMs: number) => {
        timeline.time(timeMs / 1000, false);
        const viewportBox = viewport.getBoundingClientRect();
        return {
          coverOpacity: Number(getComputedStyle(cover).opacity),
          listOpacity: Number(getComputedStyle(list).opacity),
          firstOffsetPx: first.getBoundingClientRect().top - viewportBox.top,
          lastOffsetPx: last.getBoundingClientRect().bottom - viewportBox.bottom,
          transform: getComputedStyle(content).transform,
        };
      };
      return {
        transitionMid: read((timing.transitionStartMs + timing.transitionEndMs) / 2),
        topHoldEnd: read(timing.topHoldEndMs),
        scrollQuarter: read(timing.topHoldEndMs + (timing.scrollEndMs - timing.topHoldEndMs) / 4),
        scrollEnd: read(timing.scrollEndMs),
        bottomHoldEnd: read(timing.bottomHoldEndMs),
      };
    }, resolved.timing);

    expect(checkpoints.transitionMid.coverOpacity).toBeCloseTo(0.5, 1);
    expect(checkpoints.transitionMid.listOpacity).toBeCloseTo(0.5, 1);
    expect(checkpoints.topHoldEnd.firstOffsetPx).toBeCloseTo(0, 0);
    expect(checkpoints.scrollQuarter.firstOffsetPx).toBeCloseTo(-resolved.scrollDistancePx / 4, 0);
    expect(Math.abs(checkpoints.scrollEnd.lastOffsetPx)).toBeLessThanOrEqual(1);
    expect(checkpoints.bottomHoldEnd.lastOffsetPx).toBeCloseTo(
      checkpoints.scrollEnd.lastOffsetPx,
      1,
    );
    expect(checkpoints.bottomHoldEnd.transform).toBe(checkpoints.scrollEnd.transform);
  });

  check('keeps a short Quiz list stationary when it fits', async (page) => {
    const frame = QUIZ_LIST_FRAMES['720p'];
    const shortQuestions = [
      {
        id: 'short',
        type: 'short_answer',
        question: 'Explain $x=2$.',
      },
    ];
    const first = quizListHtml(frame, shortQuestions, {
      contentHeightPx: 100,
      viewportHeightPx: 100,
    });
    await page.setViewportSize(frame);
    await loadEmittedHtml(page, first.html);
    const measured = await page.evaluate(() => {
      const content = document.querySelector<HTMLElement>('.quiz-list-content')!;
      const viewport = document.querySelector<HTMLElement>('.quiz-list-viewport')!;
      return {
        contentHeightPx: Math.ceil(content.scrollHeight),
        viewportHeightPx: Math.ceil(viewport.clientHeight),
      };
    });
    const resolved = quizListHtml(frame, shortQuestions, measured);
    expect(resolved.scrollDistancePx).toBe(0);
    expect(resolved.html).not.toMatch(/tl\.to\('#scene-1-visual-2-content'/);
  });
});
