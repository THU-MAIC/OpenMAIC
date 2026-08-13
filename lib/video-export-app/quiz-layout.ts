'use client';

/** Browser-side premeasurement for deterministic Quiz question-list export. */
import type { Locale } from '@/lib/i18n';
import {
  prepareQuizQuestionList,
  quizQuestionListCss,
  renderQuizQuestionListSurface,
  type CompilerScene,
  type CoverCardLabels,
  type QuizLayoutMeasurement,
  type QuizLayoutProbe,
  type QuizQuestionListContent,
} from '@/lib/video-export';
import { INTER_FONT_FACE_CSS } from '@/lib/video-export/emit-hyperframes/inter-font';
import { KATEX_MEASUREMENT_CSS } from '@/lib/video-export/emit-hyperframes/katex-assets';
import { NOTO_CJK_MEASUREMENT_CSS } from '@/lib/video-export/emit-hyperframes/noto-cjk-assets';
import { planQuizScriptFonts } from '@/lib/video-export/emit-hyperframes/quiz-script-font-plan';

const RTL_LANGUAGES = new Set(['ar', 'fa', 'he', 'ur', 'ps', 'sd', 'ug', 'yi']);

function direction(locale: string): 'ltr' | 'rtl' {
  return RTL_LANGUAGES.has(locale.split('-')[0].toLowerCase()) ? 'rtl' : 'ltr';
}

export interface MeasureQuizQuestionListInput {
  content: QuizQuestionListContent;
  width: number;
  height: number;
  locale: Locale;
  labels: CoverCardLabels;
}

type QuizQuestionListMeasurer = (
  input: MeasureQuizQuestionListInput,
) => Promise<QuizLayoutMeasurement | null>;

/** Fully prepared static surface consumed by the browser-only layout core. */
export interface QuizQuestionListMeasurementSurface {
  html: string;
  css: string;
  width: number;
  height: number;
  requiredFontLoads: readonly { family: string; text: string }[];
}

/** Prepare the exact emitted question markup, CSS, and embedded font faces. */
export function createQuizQuestionListMeasurementSurface(
  input: MeasureQuizQuestionListInput,
): QuizQuestionListMeasurementSurface {
  const html = renderQuizQuestionListSurface(
    input.content,
    input.labels,
    direction(input.locale),
    'quiz-layout-measurement-content',
  );
  const scriptFonts = planQuizScriptFonts([html]);
  return {
    html,
    css: [
      INTER_FONT_FACE_CSS,
      NOTO_CJK_MEASUREMENT_CSS,
      KATEX_MEASUREMENT_CSS,
      scriptFonts.measurementCss,
      quizQuestionListCss(input.width),
    ]
      .filter(Boolean)
      .join('\n'),
    width: input.width,
    height: input.height,
    requiredFontLoads: scriptFonts.requiredFontLoads,
  };
}

/**
 * Mount one fully prepared surface off-screen and wait for fonts plus two
 * identical layout reads. This function deliberately closes over no module
 * state, so the Chromium guardrail can execute the production DOM lifecycle
 * itself instead of reimplementing it in the test.
 */
export async function measureQuizQuestionList(
  input: QuizQuestionListMeasurementSurface,
  timeoutMs = 5_000,
): Promise<QuizLayoutMeasurement | null> {
  const host = document.createElement('div');
  let active = true;
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  const budgetMs = Number.isFinite(timeoutMs) ? Math.max(0, timeoutMs) : 5_000;
  const deadline = new Promise<boolean>((resolve) => {
    deadlineTimer = setTimeout(() => {
      active = false;
      resolve(false);
    }, budgetMs);
  });
  const waitBeforeDeadline = (work: PromiseLike<unknown>): Promise<boolean> =>
    Promise.race([
      Promise.resolve(work).then(
        () => active,
        () => false,
      ),
      deadline,
    ]);

  try {
    host.setAttribute('aria-hidden', 'true');
    Object.assign(host.style, {
      position: 'fixed',
      left: '-100000px',
      top: '0',
      width: `${input.width}px`,
      height: `${input.height}px`,
      visibility: 'hidden',
      pointerEvents: 'none',
      overflow: 'hidden',
    });
    const style = document.createElement('style');
    style.textContent = [
      input.css,
      `#quiz-layout-measurement, #quiz-layout-measurement * { box-sizing:border-box; }`,
      `#quiz-layout-measurement { position:absolute;inset:0;display:flex;align-items:center;justify-content:center;overflow:hidden; }`,
    ].join('\n');
    host.id = 'quiz-layout-measurement';
    host.className = 'cover-card quiz-question-list';
    host.append(style);
    host.insertAdjacentHTML('beforeend', input.html);
    document.body.append(host);

    if (!(await waitBeforeDeadline(document.fonts?.ready ?? Promise.resolve()))) return null;
    if (input.requiredFontLoads.length > 0 && !document.fonts?.load) return null;
    for (const font of input.requiredFontLoads) {
      const family = font.family.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
      const loaded = Promise.resolve(document.fonts.load(`400 16px "${family}"`, font.text)).then(
        (faces) => {
          if (faces.length === 0) throw new Error('Selected Quiz font did not load');
        },
      );
      if (!(await waitBeforeDeadline(loaded))) return null;
    }
    let previous: QuizLayoutMeasurement | null = null;
    let stableReads = 0;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const frame = new Promise<void>((resolve) => {
        requestAnimationFrame(() => {
          if (active) resolve();
        });
      });
      if (!(await waitBeforeDeadline(frame))) return null;
      const viewport = host.querySelector<HTMLElement>('.quiz-list-viewport');
      const content = host.querySelector<HTMLElement>('.quiz-list-content');
      if (!viewport || !content) return null;
      const current = {
        contentHeightPx: Math.ceil(content.scrollHeight),
        viewportHeightPx: Math.ceil(viewport.clientHeight),
        frameHeightPx: input.height,
      };
      if (current.contentHeightPx <= 0 || current.viewportHeightPx <= 0) return null;
      if (
        previous &&
        previous.contentHeightPx === current.contentHeightPx &&
        previous.viewportHeightPx === current.viewportHeightPx
      ) {
        stableReads += 1;
        if (stableReads >= 2) return current;
      } else {
        stableReads = 0;
      }
      previous = current;
    }
    return null;
  } catch {
    return null;
  } finally {
    active = false;
    if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
    host.remove();
  }
}

async function measureQuizQuestionListContent(
  input: MeasureQuizQuestionListInput,
): Promise<QuizLayoutMeasurement | null> {
  return measureQuizQuestionList(createQuizQuestionListMeasurementSurface(input));
}

export interface CreateQuizLayoutProbeInput {
  scenes: readonly CompilerScene[];
  width: number;
  height: number;
  locale: Locale;
  labels: CoverCardLabels;
}

/** Premeasure all non-empty Quiz scenes and return the compiler's sync probe. */
export async function createQuizLayoutProbe(
  input: CreateQuizLayoutProbeInput,
  measure: QuizQuestionListMeasurer = measureQuizQuestionListContent,
): Promise<QuizLayoutProbe> {
  const bySceneId = new Map<string, QuizLayoutMeasurement>();
  for (const scene of input.scenes) {
    if (scene.type !== 'quiz') continue;
    const questions = prepareQuizQuestionList(scene);
    if (questions.length === 0) continue;
    try {
      const result = await measure({
        content: { title: scene.title, questions },
        width: input.width,
        height: input.height,
        locale: input.locale,
        labels: input.labels,
      });
      if (result) bySceneId.set(scene.id, result);
    } catch {
      // The compiler receives a miss and emits the cover-only fallback warning.
    }
  }

  return {
    measureQuestionList(scene) {
      return bySceneId.get(scene.id) ?? null;
    },
  };
}
