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
import { compileVideoTimeline, emitHyperframes } from '@/lib/video-export';
import type { CompilerScene, VideoExportCta } from '@/lib/video-export';
import { PBL_PANEL_DESIGN_BOX } from '@/lib/video-export/emit-hyperframes';
import {
  getVideoExportCoverLabels,
  resolveVideoExportCta,
} from '@/lib/video-export-app/cover-config';
import type { Locale } from '@/lib/i18n';
import { NO_ASSETS, NO_PROBE, speech } from './helpers';

const REQUIRED = process.env.COVER_LAYOUT_BROWSER === '1';

const FRAMES = {
  '720p': { width: 1280, height: 720 },
  '480p': { width: 854, height: 480 },
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
});
