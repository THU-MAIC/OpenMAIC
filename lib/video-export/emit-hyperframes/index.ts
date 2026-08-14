/**
 * Hyperframes emitter — `VideoTimeline` IR → a self-contained composition project.
 *
 * The IR is the contract (issue #864); this pure emitter is a downstream
 * consumer (#865) that renders it to the files `npx hyperframes render` needs:
 * a single `index.html` whose stage is one Hyperframes composition, driven by one
 * `paused` GSAP timeline registered on `window.__timelines`. Because every IR
 * time is already absolute on the global playback clock (the compiler runs one
 * cursor across all scenes), the whole classroom is a single flat composition —
 * scene base frames and video clips are `class="clip"` elements laid out with
 * `data-start`/`data-duration`, and effects are overlay DOM the timeline reveals.
 *
 * This module emits **text only** (HTML/JS/JSON/SRT/VTT strings); the binary
 * assets it references by relative path (`frames/…`, `audio/…`, `media/…`, and
 * the vendored GSAP) are collected and written by the app-side packaging layer,
 * so the emitter stays pure and string-snapshot testable.
 *
 * Determinism red-lines (enforced downstream by `hyperframes lint`): GSAP is
 * vendored locally (no CDN), no `Date.now`/`Math.random`/network at render time,
 * explicit root `data-duration`, no infinite repeats.
 *
 * Pure: depends only on the IR, the subtitle serializer, and the effect emitter.
 */
import type {
  PblCoverVisual,
  QuizCoverVisual,
  QuizQuestionListVisual,
  VideoTimeline,
  VideoTimelineScene,
  VisualSegment,
} from '../ir';
import { INTERACTIVE_STATIC_MESSAGE_FLAG } from '../interactive-static';
import { emitManifestJson } from '../passes/emit';
import { RUNTIME_DIAGNOSTIC_CODES } from '../runtime-diagnostics';
import { toSrt, toVtt } from '../subtitles';
import { EASE_DEFS, emitEffect } from './effects';
import { escapeHtml, sec } from './format';
import { INTER_FONT_FACE_CSS, INTER_OFL_LICENSE } from './inter-font';
import { KATEX_EXPORT_CSS, KATEX_FONT_ASSETS, KATEX_MIT_LICENSE } from './katex-assets';
import {
  NOTO_CJK_EXPORT_CSS,
  NOTO_CJK_FONT_ASSETS,
  NOTO_SANS_KR_OFL_LICENSE,
  NOTO_SANS_SC_OFL_LICENSE,
} from './noto-cjk-assets';
import {
  quizQuestionListCss,
  renderQuizQuestionListSurface,
  type QuizQuestionListLabels,
} from './quiz-question-list';

/** A file in the emitted project: a relative path and its text content. */
export interface EmittedFile {
  path: string;
  content: string;
}

/** Binary file copied from the app's vendored public assets into the export ZIP. */
export interface EmittedVendorAsset {
  /** Project-relative path referenced by emitted HTML/CSS. */
  path: string;
  /** App-local URL used by the packaging boundary to load the committed bytes. */
  sourceUrl: string;
}

/** Optional informational destination displayed on exported Quiz/PBL covers. */
export interface VideoExportCta {
  /** Normalized display destination without a URL scheme or trailing slash. */
  destination: string;
}

export interface InteractiveFallbackLabels {
  /** Localized fallback copy shown when a static interactive page cannot load. */
  fallback: string;
  /** Localized readiness-timeout copy shown in the static fallback. */
  readyTimeout: string;
  /** Localized load-failure copy shown in the static fallback. */
  loadFailure: string;
  /** Localized readiness-failure copy shown in the static fallback. */
  readyFailure: string;
  /** Localized runtime-failure copy shown in the static fallback. */
  runtimeFailure: string;
}

/**
 * Learner-facing chrome on exported video cards and fallback scenes — everything
 * that is *not* authored scene data. The defaults are the `en-US` values of the
 * very i18n keys the live QuizView/PBL Hero use; the app passes the classroom's
 * active locale so an exported video reads like the lesson it came from. Kept as
 * injected strings (not an i18n import) so the emitter stays pure.
 */
export interface VideoExportLabels extends QuizQuestionListLabels {
  /** `quiz.title` — the Quiz card's eyebrow. */
  quiz: string;
  /** `quiz.questionsCount` — unit after the question count. */
  questions: string;
  /** `quiz.pointsSuffix` — unit after the total points. */
  points: string;
  /** `quiz.singleChoice` — static question type label. */
  singleChoice: string;
  /** `quiz.multipleChoice` — static question type label. */
  multipleChoice: string;
  /** `quiz.shortAnswer` — static question type label. */
  shortAnswer: string;
  /** `quiz.inputPlaceholder` — text shown inside the visual-only answer box. */
  answerPlaceholder: string;
  /** `pbl.v2.hero.title` — the PBL card's eyebrow. */
  pbl: string;
  /** `pbl.v2.hero.stage` — unit after the stage count. */
  stages: string;
  /** `pbl.v2.hero.task` — unit after the task count. */
  tasks: string;
  /** `pbl.v2.hero.youWillLearn` — heading above the gains list. */
  gains: string;
  /** `pbl.v2.hero.tutor` — instructor row label and name fallback. */
  instructor: string;
  /** `pbl.v2.hero.instructorTagline` — instructor description fallback. */
  instructorTagline: string;
  /** `pbl.v2.hero.scenarioCharacter` — scenario-character row label. */
  scenarioCharacter: string;
  /** `pbl.v2.hero.scenarioCharacterTagline` — scenario-character description. */
  scenarioCharacterTagline: string;
  /** Prompt above the configured destination on a Quiz cover. */
  quizCtaPrompt: string;
  /** Prompt above the configured destination on a PBL cover. */
  pblCtaPrompt: string;
  /** Verb preceding the configured destination. */
  ctaVisit: string;
  /** Localized fallback and failure copy for static interactive scenes. */
  interactive: InteractiveFallbackLabels;
}

/** Backward-compatible name for app-side cover and Quiz measurement labels. */
export type CoverCardLabels = VideoExportLabels;

type VideoExportLabelOverrides = Partial<Omit<VideoExportLabels, 'interactive'>> & {
  interactive?: Partial<InteractiveFallbackLabels>;
};

export interface EmitHyperframesOptions {
  /** Render width in px. Default 1920. Height is derived from the IR's 16:9 aspect. */
  width?: number;
  /** Render height in px. Default derived from `width` at 16:9. */
  height?: number;
  /** Composition id used for the root `data-composition-id` and the timeline key. Default `openmaic`. */
  compositionId?: string;
  /** Relative path the emitted HTML loads GSAP from. Default `assets/vendor/gsap.min.js`. */
  gsapVendorPath?: string;
  /** Manifest filename. Default `openmaic-video-manifest.json`. */
  manifestPath?: string;
  /** Cover-card chrome; each omitted key falls back to its `en-US` default. */
  labels?: VideoExportLabelOverrides;
  /** Informational destination for Quiz/PBL covers. Omitted or null disables it. */
  cta?: VideoExportCta | null;
  /**
   * BCP-47 tag the emitted document is written in — the same locale the
   * {@link EmitHyperframesOptions.labels} were resolved from. Sets `<html lang>`;
   * right-to-left direction is scoped to text-bearing cover panels because
   * Hyperframes cannot safely render a document-level RTL direction. The locale
   * is recorded in the project README so a re-render can reproduce this exact
   * output. Default `en-US`, matching {@link DEFAULT_VIDEO_EXPORT_LABELS}.
   */
  locale?: string;
  /**
   * Burn the subtitle overlay into the composition (baked into the video by the
   * frame capture). Default `false`: the video renders clean and the narration
   * subtitles ship only as the sidecar `subtitles.srt` / `.vtt`, which a user
   * can add in an editor (#867 item 2 — burn-in off by default). When `true`,
   * the bottom caption band is emitted and driven by the paused timeline.
   */
  burnInSubtitles?: boolean;
}

export interface EmittedProject {
  files: EmittedFile[];
  /** Font/runtime bytes required by this project; empty for exports without a Quiz list. */
  vendorAssets: EmittedVendorAsset[];
  width: number;
  height: number;
  compositionId: string;
  totalDurationMs: number;
  /** Where the emitted HTML expects the vendored GSAP — the packaging layer fills it. */
  gsapVendorPath: string;
}

const DEFAULT_WIDTH = 1920;
const DEFAULT_GSAP_PATH = 'assets/vendor/gsap.min.js';
const DEFAULT_MANIFEST = 'openmaic-video-manifest.json';
const DEFAULT_LOCALE = 'en-US';

/** Language subtags written right-to-left; everything else renders LTR. */
const RTL_LANGUAGES = new Set(['ar', 'fa', 'he', 'ur', 'ps', 'sd', 'ug', 'yi']);

function isRtl(locale: string): boolean {
  return RTL_LANGUAGES.has(locale.split('-')[0].toLowerCase());
}

const DEFAULT_VIDEO_EXPORT_LABELS: VideoExportLabels = {
  quiz: 'Quiz',
  questions: 'questions',
  points: 'pts',
  singleChoice: 'Single',
  multipleChoice: 'Multiple',
  shortAnswer: 'Short answer',
  answerPlaceholder: 'Type your answer here...',
  pbl: 'Project-Based Learning',
  stages: 'Stages',
  tasks: 'Tasks',
  gains: "What you'll gain",
  instructor: 'Tutor',
  instructorTagline: 'Guides you through the whole project',
  scenarioCharacter: 'Role-play character',
  scenarioCharacterTagline: "The character you'll interact with in the scenario",
  quizCtaPrompt: 'Want to try an interactive quiz?',
  pblCtaPrompt: 'Want to explore project-based learning?',
  ctaVisit: 'Visit',
  interactive: {
    fallback: 'interactive-static-fallback',
    readyTimeout: 'interactive-ready-timeout',
    loadFailure: 'interactive-load-failure',
    readyFailure: 'interactive-ready-failure',
    runtimeFailure: 'interactive-runtime-failure',
  },
};

/**
 * Directory the collected binary assets live under in the export zip. The
 * compiler's asset plan uses bare paths (`frames/…`, `audio/…`, `media/…`); the
 * project places them all under `assets/` (matching the artifact layout and the
 * vendored GSAP at `assets/vendor/`). The packaging layer writes each plan blob
 * at this same `assets/<planPath>`, so HTML references and zip entries agree.
 */
export const ASSETS_DIR = 'assets';

/** Map a compiler asset-plan path to its zip-relative URL under `assets/`. */
export function assetUrl(planPath: string): string {
  return `${ASSETS_DIR}/${planPath}`;
}

function placeholderContent(scene: VideoTimelineScene, reason: string, reasonAttrs = ''): string {
  const reasonAttributeText = reasonAttrs ? ` ${reasonAttrs}` : '';
  return [
    `<div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;background:#0f172a;color:#e2e8f0;font-family:system-ui,sans-serif;text-align:center;padding:8%">`,
    `  <div dir="auto" style="font-size:2.2vw;font-weight:700">${escapeHtml(scene.title)}</div>`,
    reason
      ? `  <div${reasonAttributeText} dir="auto" style="font-size:1.2vw;color:#94a3b8;max-width:70%">${escapeHtml(reason)}</div>`
      : '',
    `</div>`,
  ]
    .filter(Boolean)
    .join('\n');
}

/** The base layer for one scene: snapshot, packaged frozen HTML, or placeholder. */
function renderBase(scene: VideoTimelineScene, labels: VideoExportLabels): string {
  const start = sec(scene.startMs);
  const duration = sec(scene.durationMs);
  const id = `scene-${scene.index + 1}-base`;
  const clip = `id="${id}" class="clip" data-start="${start}" data-duration="${duration}" data-track-index="0"`;
  if (scene.base.kind === 'slide-snapshot' && scene.base.assetRef) {
    return `<img ${clip} src="${escapeHtml(assetUrl(scene.base.assetRef))}" alt="" style="position:absolute;left:0;top:0;width:100%;height:100%;object-fit:contain" />`;
  }
  if (scene.base.kind === 'visual-segments') return '';
  if (scene.base.kind === 'interactive-html' && scene.base.assetRef) {
    const fallback = placeholderContent(
      scene,
      labels.interactive.fallback,
      'data-interactive-fallback-reason',
    );
    return [
      `<div ${clip} data-interactive-static-host data-scene-id="${escapeHtml(scene.id)}" data-ready-timeout-ms="${scene.base.readyTimeoutMs}" data-content-hash="${escapeHtml(scene.base.contentHash)}" style="position:absolute;inset:0;background:#0f172a">`,
      `  <div data-interactive-fallback>${fallback}</div>`,
      `  <iframe data-interactive-static-frame data-src="${escapeHtml(assetUrl(scene.base.assetRef))}" title="${escapeHtml(scene.title)}" sandbox="allow-scripts" style="position:absolute;inset:0;width:100%;height:100%;border:0;visibility:hidden;pointer-events:none;background:#fff"></iframe>`,
      `</div>`,
    ].join('\n');
  }
  const reason =
    scene.type === 'interactive'
      ? labels.interactive.fallback
      : scene.base.kind === 'placeholder'
        ? (scene.base.reason ?? '')
        : '';
  return `<div ${clip}>${placeholderContent(scene, reason)}</div>`;
}

/** Parent-side readiness/fallback bridge for every packaged interactive iframe. */
function interactiveStaticBridgeScript(labels: InteractiveFallbackLabels): string {
  const flag = JSON.stringify(INTERACTIVE_STATIC_MESSAGE_FLAG);
  const localized = JSON.stringify(labels);
  const diagnosticCodes = JSON.stringify(RUNTIME_DIAGNOSTIC_CODES);
  return `
function initializeOpenMaicInteractiveStaticFrames() {
  var hosts = Array.from(document.querySelectorAll('[data-interactive-static-host]'));
  window.__openmaicVideoDiagnostics = window.__openmaicVideoDiagnostics || [];
  window.__openmaicVideoManifest = window.__openmaicVideoManifest || { runtimeDiagnostics: [] };
  var labels = ${localized};
  var diagnosticCodes = new Set(${diagnosticCodes});
  var runtimeReport = document.querySelector('[data-openmaic-runtime-diagnostics]');
  function record(sceneId, code, message) {
    var normalizedCode = diagnosticCodes.has(code) ? code : 'interactive-ready-failure';
    var diagnostic = { sceneId: sceneId, code: normalizedCode, message: String(message || '').slice(0, 1200) };
    window.__openmaicVideoDiagnostics.push(diagnostic);
    window.__openmaicVideoManifest.runtimeDiagnostics = window.__openmaicVideoDiagnostics.slice();
    if (runtimeReport) runtimeReport.textContent = JSON.stringify(window.__openmaicVideoDiagnostics);
    console.error('interactive-static-diagnostic', diagnostic);
  }
  function messageFor(code, detail) {
    var prefix = code === 'interactive-load-failure' ? labels.loadFailure
      : code === 'interactive-ready-timeout' || code === 'interactive-load-timeout' ? labels.readyTimeout
      : code === 'interactive-runtime-failure' ? labels.runtimeFailure
      : labels.readyFailure;
    return detail && detail !== 'ready' ? prefix + ': ' + detail : prefix;
  }
  return Promise.all(hosts.map(function (host) {
    return new Promise(function (resolve) {
      var sceneId = host.getAttribute('data-scene-id') || 'interactive';
      var timeoutMs = Number(host.getAttribute('data-ready-timeout-ms')) || 8000;
      var iframe = host.querySelector('[data-interactive-static-frame]');
      var fallback = host.querySelector('[data-interactive-fallback]');
      var reason = host.querySelector('[data-interactive-fallback-reason]');
      var loaded = false;
      var settled = false;
      var runtimeErrors = [];

      function finish(ok, code, message) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        window.removeEventListener('message', onMessage);
        if (ok) {
          iframe.style.visibility = 'visible';
          fallback.style.display = 'none';
          host.setAttribute('data-interactive-static-state', 'frozen');
        } else {
          iframe.style.visibility = 'hidden';
          fallback.style.display = 'block';
          if (reason) reason.textContent = message;
          host.setAttribute('data-interactive-static-state', 'fallback');
          host.setAttribute('data-interactive-diagnostic', code);
          record(sceneId, code, message);
          iframe.remove();
        }
        resolve({ sceneId: sceneId, ok: ok, code: code });
      }

      function onMessage(event) {
        if (event.source !== iframe.contentWindow) return;
        var data = event.data || {};
        if (data.__maicInteractive === true && data.kind === 'runtime-error') {
          runtimeErrors.push('[' + (data.errorKind || 'error') + '] ' + String(data.message || 'runtime error'));
          return;
        }
        if (data[${flag}] !== true) return;
        if (data.kind === 'failure') {
          var failureCode = data.code || 'interactive-ready-failure';
          finish(false, failureCode, messageFor(failureCode, data.message));
        } else if (data.kind === 'frozen') {
          if (runtimeErrors.length > 0) {
          finish(false, 'interactive-runtime-failure', messageFor('interactive-runtime-failure', runtimeErrors[0]));
          } else {
            finish(true, 'interactive-static-ready', 'ready');
          }
        }
      }

      window.addEventListener('message', onMessage);
      iframe.addEventListener('load', function () {
        loaded = true;
        try { iframe.contentWindow.postMessage({ __maicErrorReplayRequest: true }, '*'); } catch (_) {}
      }, { once: true });
      iframe.addEventListener('error', function () {
        finish(false, 'interactive-load-failure', messageFor('interactive-load-failure'));
      }, { once: true });
      var timer = setTimeout(function () {
        finish(
          false,
          loaded ? 'interactive-ready-timeout' : 'interactive-load-timeout',
          messageFor(loaded ? 'interactive-ready-timeout' : 'interactive-load-timeout')
        );
      }, timeoutMs);
      iframe.setAttribute('src', iframe.getAttribute('data-src'));
    });
  }));
}
`;
}

/**
 * One `<count> <unit>` stat tile. The unit is a localized label, so it is used
 * verbatim rather than pluralized in English (`道题` / `questions` / `pts`).
 */
function statTile(count: number, unit: string): string {
  return `<div class="cover-stat"><strong>${count}</strong><span>${escapeHtml(unit)}</span></div>`;
}

function renderCoverCta(prompt: string, visit: string, cta: VideoExportCta | null): string {
  if (!cta) return '';
  return [
    `<div class="cover-cta">`,
    `  <div class="cover-cta-line">${escapeHtml(prompt)}</div>`,
    `  <div class="cover-cta-line">${escapeHtml(visit)} <bdi dir="ltr">${escapeHtml(cta.destination)}</bdi></div>`,
    `</div>`,
  ].join('\n');
}

function visualClip(
  scene: VideoTimelineScene,
  visual: VisualSegment,
  index: number,
  className: string,
  trackIndex = 0,
): string {
  return [
    `id="scene-${scene.index + 1}-visual-${index + 1}"`,
    `class="clip cover-card ${className}"`,
    `data-visual-kind="${visual.kind}"`,
    `data-start="${sec(visual.startMs)}"`,
    `data-duration="${sec(visual.durationMs)}"`,
    `data-track-index="${trackIndex}"`,
  ].join(' ');
}

function renderQuizCover(
  scene: VideoTimelineScene,
  visual: QuizCoverVisual,
  index: number,
  labels: VideoExportLabels,
  cta: VideoExportCta | null,
  direction: 'ltr' | 'rtl',
): string {
  const clip = visualClip(scene, visual, index, 'cover-quiz');
  return [
    `<div ${clip}>`,
    `  <div class="cover-orb cover-orb-a"></div><div class="cover-orb cover-orb-b"></div>`,
    `  <div class="cover-panel cover-quiz-panel" dir="${direction}">`,
    `    <div class="cover-eyebrow"><span class="cover-eyebrow-icon">?</span> ${escapeHtml(labels.quiz)}</div>`,
    `    <h1 class="cover-title" dir="auto">${escapeHtml(visual.title)}</h1>`,
    `    <div class="cover-stats cover-quiz-stats">`,
    `      ${statTile(visual.questionCount, labels.questions)}`,
    `      ${statTile(visual.totalPoints, labels.points)}`,
    `    </div>`,
    renderCoverCta(labels.quizCtaPrompt, labels.ctaVisit, cta),
    `  </div>`,
    `</div>`,
  ]
    .filter(Boolean)
    .join('\n');
}

function renderQuizQuestionList(
  scene: VideoTimelineScene,
  visual: QuizQuestionListVisual,
  index: number,
  labels: CoverCardLabels,
  direction: 'ltr' | 'rtl',
): string {
  // A crossfade is intentionally an overlap. Hyperframes rejects overlapping
  // clips on one track, so the list owns track 3 (0=base/cover, 1=video,
  // 2=audio) while GSAP performs the resolved 600ms transition.
  const clip = visualClip(scene, visual, index, 'quiz-question-list', 3);
  const contentId = `scene-${scene.index + 1}-visual-${index + 1}-content`;
  return [
    `<div ${clip}>`,
    renderQuizQuestionListSurface(visual, labels, direction, contentId),
    `</div>`,
  ].join('\n');
}

function quizQuestionListStatements(
  scene: VideoTimelineScene,
  visual: QuizQuestionListVisual,
  index: number,
): string[] {
  const id = `scene-${scene.index + 1}-visual-${index + 1}`;
  const coverIndex = scene.visuals.findIndex((candidate) => candidate.kind === 'quiz-cover');
  const coverId = `scene-${scene.index + 1}-visual-${coverIndex + 1}`;
  const start = sec(visual.startMs);
  const transition = sec(visual.transitionDurationMs);
  const statements = [
    `tl.fromTo('#${id}',{autoAlpha:0},{autoAlpha:1,duration:${transition},ease:'none'},${start});`,
  ];
  if (coverIndex >= 0) {
    statements.push(
      `tl.to('#${coverId}',{autoAlpha:0,duration:${transition},ease:'none'},${start});`,
    );
  }
  if (visual.scrollDistancePx > 0 && visual.scrollDurationMs > 0) {
    const scrollStart = sec(
      visual.startMs + visual.transitionDurationMs + visual.topHoldDurationMs,
    );
    statements.push(
      `tl.to('#${id}-content',{y:-${visual.scrollDistancePx},duration:${sec(visual.scrollDurationMs)},ease:'none'},${scrollStart});`,
    );
  }
  return statements;
}

function renderPerson(
  label: string,
  name: string,
  description: string,
  tone: 'instructor' | 'character',
): string {
  const initial = Array.from(name)[0] ?? '?';
  return [
    `<div class="cover-person cover-person-${tone}">`,
    `  <div class="cover-avatar">${escapeHtml(initial)}</div>`,
    `  <div class="cover-person-copy"><span>${escapeHtml(label)}</span><strong dir="auto">${escapeHtml(name)}</strong><small dir="auto">${escapeHtml(description)}</small></div>`,
    `</div>`,
  ].join('\n');
}

function renderPblCover(
  scene: VideoTimelineScene,
  visual: PblCoverVisual,
  index: number,
  labels: VideoExportLabels,
  plan: PblCoverPlan,
  cta: VideoExportCta | null,
  direction: 'ltr' | 'rtl',
): string {
  const clip = visualClip(scene, visual, index, 'cover-pbl');
  const gains = plan.gains
    .map(
      (gain) =>
        `<li><span class="cover-check">✓</span><span class="cover-gain-text" dir="auto">${escapeHtml(gain)}</span></li>`,
    )
    .join('\n');
  // Each row is rendered only for a person the course actually authored: a card
  // with no instructor says nothing rather than introducing a generic "Tutor".
  const people = !plan.people
    ? ''
    : [
        visual.instructorName
          ? renderPerson(
              labels.instructor,
              visual.instructorName,
              visual.instructorDescription ?? labels.instructorTagline,
              'instructor',
            )
          : '',
        visual.scenarioCharacterName
          ? renderPerson(
              labels.scenarioCharacter,
              visual.scenarioCharacterName,
              labels.scenarioCharacterTagline,
              'character',
            )
          : '',
      ]
        .filter(Boolean)
        .join('\n');

  return [
    `<div ${clip}>`,
    `  <div class="cover-grid"></div><div class="cover-orb cover-orb-a"></div><div class="cover-orb cover-orb-b"></div>`,
    `  <div class="cover-panel cover-pbl-panel" dir="${direction}">`,
    `    <div class="cover-eyebrow"><span class="cover-eyebrow-icon">✦</span> ${escapeHtml(labels.pbl)}</div>`,
    `    <h1 class="cover-title" dir="auto">${escapeHtml(visual.title)}</h1>`,
    plan.description
      ? `    <p class="cover-description" dir="auto" style="-webkit-line-clamp:${plan.descriptionLines}">${escapeHtml(plan.description)}</p>`
      : '',
    gains
      ? `    <section class="cover-gains"><div class="cover-section-label">${escapeHtml(labels.gains)}</div><ul>${gains}</ul></section>`
      : '',
    `    <div class="cover-pbl-meta">`,
    `      <div class="cover-stats">${statTile(visual.stageCount, labels.stages)}${statTile(visual.taskCount, labels.tasks)}</div>`,
    people ? `      <div class="cover-people">${people}</div>` : '',
    `    </div>`,
    renderCoverCta(labels.pblCtaPrompt, labels.ctaVisit, cta),
    `  </div>`,
    `</div>`,
  ]
    .filter(Boolean)
    .join('\n');
}

/** Render first-class track-0 visuals independently from the scene base. */
function renderVisuals(
  scene: VideoTimelineScene,
  labels: VideoExportLabels,
  frame: { width: number; height: number; burnInSubtitles: boolean },
  cta: VideoExportCta | null,
  direction: 'ltr' | 'rtl',
): { html: string[]; statements: string[] } {
  const html: string[] = [];
  const statements: string[] = [];
  scene.visuals.forEach((visual, index) => {
    if (visual.kind === 'quiz-cover') {
      html.push(renderQuizCover(scene, visual, index, labels, cta, direction));
      return;
    }
    if (visual.kind === 'quiz-question-list') {
      html.push(renderQuizQuestionList(scene, visual, index, labels, direction));
      statements.push(...quizQuestionListStatements(scene, visual, index));
      return;
    }
    html.push(
      renderPblCover(
        scene,
        visual,
        index,
        labels,
        planPblCover(visual, labels, { ...frame, cta }),
        cta,
        direction,
      ),
    );
  });
  return { html, statements };
}

/** A `play_video` clip, positioned at the target element's geometry (0–100 space). */
function renderVideo(scene: VideoTimelineScene): string[] {
  return scene.videos
    .filter((v) => v.present && v.assetRef)
    .map((v, i) => {
      const start = sec(v.startMs);
      const duration = sec(v.durationMs);
      const id = `scene-${scene.index + 1}-video-${i + 1}`;
      const clip = `id="${id}" class="clip" data-start="${start}" data-duration="${duration}" data-track-index="1"`;
      const g = v.geometry;
      const style = g
        ? `position:absolute;left:${g.x}%;top:${g.y}%;width:${g.w}%;height:${g.h}%;transform:rotate(${v.rotate}deg);object-fit:contain`
        : `position:absolute;left:0;top:0;width:100%;height:100%;object-fit:contain`;
      // data-has-audio: the clip contributes its own soundtrack, mixed at encode.
      return `<video ${clip} src="${escapeHtml(assetUrl(v.assetRef!))}" data-has-audio="true" style="${style}" playsinline></video>`;
    });
}

/** Narration `<audio>` clips (present ones); the engine mixes them at encode time. */
function renderNarration(scene: VideoTimelineScene): string[] {
  return scene.narration
    .filter((seg) => seg.audio.present && seg.audio.assetRef)
    .map((seg, i) => {
      const start = sec(seg.startMs);
      const duration = sec(seg.durationMs);
      const id = `scene-${scene.index + 1}-audio-${i + 1}`;
      return `<audio id="${id}" class="clip" data-start="${start}" data-duration="${duration}" data-track-index="2" src="${escapeHtml(assetUrl(seg.audio.assetRef!))}" data-volume="1"></audio>`;
    });
}

/**
 * Burned-in subtitle band layout. All sizes derive from the render height so the
 * captions read the same at any resolution; the fractions/ratios are the tuning
 * knobs.
 */
const SUBTITLE = {
  /** Font size as a fraction of render height, floored at {@link SUBTITLE.minFontPx}. */
  fontHeightRatio: 0.033,
  /** Never smaller than this many px, so captions stay legible at low resolutions. */
  minFontPx: 16,
  /** Vertical padding as a fraction of the font size. */
  padVRatio: 0.35,
  /** Horizontal padding as a fraction of the font size. */
  padHRatio: 0.7,
  /** Distance of the band from the bottom edge, as a fraction of render height. */
  bottomRatio: 0.01,
  /** Hard ceiling on caption lines (`-webkit-line-clamp`) so an outlier can't grow tall. */
  maxLines: 2,
  /** Caption line-height (unitless); also sizes the max-height clamp. */
  lineHeight: 1.3,
  /** Caption band max width, in % of the frame. */
  maxWidthPct: 80,
  /** Caption background opacity. */
  bgOpacity: 0.66,
} as const;

/**
 * Render px the burned-in caption band occupies at the bottom of the frame,
 * from the frame edge to the top of a two-line cue. Cover cards subtract it so
 * their panel never sits underneath a caption.
 */
function subtitleBandHeight(height: number): number {
  const fontPx = Math.max(SUBTITLE.minFontPx, Math.round(height * SUBTITLE.fontHeightRatio));
  const padV = Math.round(fontPx * SUBTITLE.padVRatio);
  const bottom = Math.round(height * SUBTITLE.bottomRatio);
  return bottom + 2 * padV + Math.ceil(fontPx * SUBTITLE.lineHeight * SUBTITLE.maxLines);
}

/**
 * Subtitle overlay: one absolutely-positioned caption band at the bottom of the
 * stage, plus one `<div>` per cue stacked in the *same* absolute slot within it.
 * The captions are *burned in* — the paused GSAP timeline reveals each cue at
 * its `startMs` and hides it at its `endMs`, so Chromium's frame capture bakes
 * them into the video (the producer has no subtitle track of its own). Cue
 * timings are the IR's, which now derive from real audio durations, so they
 * stay aligned with the narration.
 *
 * Every cue is stacked in one grid cell of the band and toggled with
 * `display:none`/`inline-block`. Two things matter here, both regressions from
 * the first cut:
 *  - Inactive cues must be **removed from layout** (`display:none`), not merely
 *    hidden (`visibility:hidden`): a hidden-but-laid-out cue still occupies a
 *    row, so with many cues the band grows several rows tall and the active cue
 *    drifts upward into the slide/title area.
 *  - All cues share **one grid cell** (`grid-area:1/1`), so the active cue
 *    always sits in the same spot regardless of which cue it is.
 *
 * Returns the overlay HTML and the `tl.set` statements that toggle display.
 */
function renderSubtitles(
  ir: VideoTimeline,
  height: number,
): { html: string; statements: string[] } {
  const cues = ir.subtitles.filter((c) => c.text.trim());
  if (cues.length === 0) return { html: '', statements: [] };

  // Scale caption type to the render height so it reads at any resolution.
  const fontPx = Math.max(SUBTITLE.minFontPx, Math.round(height * SUBTITLE.fontHeightRatio));
  const padV = Math.round(fontPx * SUBTITLE.padVRatio);
  const padH = Math.round(fontPx * SUBTITLE.padHRatio);
  // Kept very low so subtitles sit right near the bottom, clear of the slide/title area.
  const bottom = Math.round(height * SUBTITLE.bottomRatio);

  // Each cue occupies the same grid cell and is hidden (display:none) until its
  // window, so inactive cues take no layout space and never shift the active one.
  // The `-webkit-line-clamp` ceiling only engages once a cue is revealed as
  // `display:-webkit-box` (see the reveal `tl.set` below); declaring only the
  // clamp props here — not `display:-webkit-box` — keeps the initial state truly
  // hidden (a second `display` would override the `none` and show every cue at
  // t=0). Cues are already short (split by the compiler), but clamp to 2 lines as
  // a hard ceiling so an outlier can never grow into a tall block that covers the
  // slide — the failure this whole change fixes.
  const maxTextHeight = Math.ceil(fontPx * SUBTITLE.lineHeight * SUBTITLE.maxLines);
  const cueDivs = cues
    .map(
      (c, i) =>
        `  <div id="subtitle-cue-${i}" dir="auto" style="grid-area:1/1;display:none;justify-self:center;max-width:${SUBTITLE.maxWidthPct}%;max-height:${maxTextHeight}px;overflow:hidden;-webkit-box-orient:vertical;-webkit-line-clamp:${SUBTITLE.maxLines};padding:${padV}px ${padH}px;background:rgba(0,0,0,${SUBTITLE.bgOpacity});color:#fff;font-size:${fontPx}px;line-height:${SUBTITLE.lineHeight};border-radius:${padV}px;white-space:pre-wrap;text-shadow:0 1px 2px rgba(0,0,0,0.9)">${escapeHtml(c.text)}</div>`,
    )
    .join('\n');

  const html = [
    `<div id="subtitles" style="position:absolute;left:0;right:0;bottom:${bottom}px;z-index:50;display:grid;justify-items:center;text-align:center;pointer-events:none;font-family:system-ui,sans-serif">`,
    cueDivs,
    `</div>`,
  ].join('\n');

  // Toggle each cue with `display` so hidden cues leave the flow entirely
  // (visibility:hidden would keep their box and push the active cue out of slot).
  // Shown as `-webkit-box` (not inline-block) so the `-webkit-line-clamp:2`
  // ceiling stays in force while visible.
  const statements: string[] = [];
  for (let i = 0; i < cues.length; i++) {
    const c = cues[i];
    statements.push(`tl.set('#subtitle-cue-${i}',{display:'-webkit-box'},${sec(c.startMs)});`);
    statements.push(`tl.set('#subtitle-cue-${i}',{display:'none'},${sec(c.endMs)});`);
  }
  return { html, statements };
}

/** Stage width the cover-card design is authored against (720p). */
const COVER_DESIGN_WIDTH = 1280;

/**
 * Design-space geometry of the PBL panel. These mirror the percentages and px
 * in {@link coverCardCss} so {@link planPblCover} can reason about the panel's
 * box without a browser: `.cover-card` pads by 5.2% of its width and the panel
 * takes 88% of what is left, capped at 1040px.
 *
 * The panel's own `4.5% 5.5%` padding resolves against its *containing block's*
 * inline size — the card's content box — not against the panel's width, per
 * CSS 2.1 §8.4. Measured in Chrome at 1280×720: 51.61px vertical, 63.07px
 * horizontal.
 */
const CARD_PADDING = 0.052 * COVER_DESIGN_WIDTH;
const CARD_CONTENT_WIDTH = COVER_DESIGN_WIDTH - 2 * CARD_PADDING;
const PANEL_WIDTH = Math.min(0.88 * CARD_CONTENT_WIDTH, 1040);
const PANEL_BORDER = 1;
const PANEL_PADDING_Y = 0.045 * CARD_CONTENT_WIDTH;
const PANEL_CONTENT_WIDTH = PANEL_WIDTH - 2 * PANEL_BORDER - 2 * 0.055 * CARD_CONTENT_WIDTH;

/**
 * The panel box {@link planPblCover} budgets against, in design px. Exported so
 * `cover-card-layout.browser.test.ts` can hold it against the box Chromium
 * actually lays out: a drift here silently changes how much content the planner
 * thinks fits.
 */
export const PBL_PANEL_DESIGN_BOX = {
  width: PANEL_WIDTH,
  paddingY: PANEL_PADDING_Y,
  contentWidth: PANEL_CONTENT_WIDTH,
} as const;

/**
 * Design-space heights of the PBL panel's blocks, read off the same CSS: a line
 * of type is `font-size × line-height`, a block adds its padding, border and
 * margin. They only need to be good enough to rank layouts, not to lay one out.
 */
const EYEBROW_ICON = 26;
const EYEBROW_LINE = 13 * 1.2;
const EYEBROW_MARGIN = 18;
const TITLE_LINE = 52 * 1.08;
const DESCRIPTION_LINE = 19 * 1.45;
const DESCRIPTION_MARGIN = 16;
const GAINS_MARGIN = 22;
const GAINS_LABEL_LINE = 11 * 1.2;
const GAINS_LABEL_MARGIN = 10;
const GAIN_ROW_GAP = 9;
const GAIN_LINE = 13 * 1.35;
const META_MARGIN = 20;
const STATS_HEIGHT = 13 * 2 + 28 + 2;
const PERSON_LABEL_LINE = 9 * 1.1;
const PERSON_NAME_LINE = 14 * 1.1;
const PERSON_DESCRIPTION_LINE = 10 * 1.25;
const PERSON_TEXT_HEIGHT = PERSON_LABEL_LINE + PERSON_NAME_LINE + 2 * PERSON_DESCRIPTION_LINE;
const PERSON_PADDING_Y = 10;
const PERSON_AVATAR_HEIGHT = 38;
const PERSON_BORDER = 1;
const PEOPLE_HEIGHT =
  2 * PERSON_PADDING_Y + Math.max(PERSON_AVATAR_HEIGHT, PERSON_TEXT_HEIGHT) + 2 * PERSON_BORDER;
const CTA_MARGIN = 18;
const CTA_LINE = 12 * 1.35;
const CTA_LINE_GAP = 4;

/**
 * Smallest size, in real render px, at which a droppable detail row still earns
 * its space. The role-play/instructor row's caption type is 9 design px, so it
 * blurs into noise below roughly 854×480 — the card is better off dropping the
 * row than clipping the panel around an unreadable one.
 */
const MIN_LEGIBLE_PX = 7;

/**
 * Conservative advance widths in em for the embedded Inter subset and host
 * fallbacks. The ASCII classes intentionally distinguish their widest members:
 * treating repeated `mmmm` / `wwww` as ordinary lowercase underestimates a
 * line even though an average prose sample appears to fit.
 */
const FULL_WIDTH =
  /[\u1100-\u115f\u2e80-\u303e\u3041-\u33ff\u3400-\u4dbf\u4e00-\u9fff\ua000-\ua4cf\ua960-\ua97f\uac00-\ud7ff\uf900-\ufaff\ufe10-\ufe6f\uff00-\uff60\uffe0-\uffe6]/u;
const PICTOGRAPHIC = /\p{Extended_Pictographic}/u;

function charWidthEm(char: string): number {
  if (FULL_WIDTH.test(char) || PICTOGRAPHIC.test(char)) return 1;
  if (char === ' ') return 0.3;
  if (char === 'W') return 1.02;
  if (/[A-Z]/.test(char)) return 0.96;
  if (char === 'm') return 0.9;
  if (char === 'w') return 0.84;
  if (/[0-9]/.test(char)) return 0.64;
  return 0.62;
}

function textWidthEm(value: string): number {
  let em = 0;
  for (const char of value) em += charWidthEm(char);
  return em;
}

/**
 * Lines `value` needs at `fontPx` in a `widthPx` column, capped at `maxLines`
 * (every cover field carries a `-webkit-line-clamp` of the same height). The
 * column is discounted because a line break lands on the last word that fits,
 * leaving a ragged edge rather than filling the measure exactly.
 */
const LINE_PACKING = 0.94;

function lineCount(value: string, fontPx: number, widthPx: number, maxLines: number): number {
  return Math.min(maxLines, requiredLineCount(value, fontPx, widthPx));
}

function requiredLineCount(value: string, fontPx: number, widthPx: number): number {
  return Math.max(1, Math.ceil((textWidthEm(value) * fontPx) / (widthPx * LINE_PACKING)));
}

/**
 * CTA rows may wrap, but never truncate, accepted build-time destinations. Use
 * the same conservative advance model as the rest of the planner so the PBL
 * degradation ladder reserves the rows before Chromium lays them out.
 */
function coverCtaHeight(
  prompt: string,
  visit: string,
  destination: string,
  widthPx: number,
): number {
  const promptLines = requiredLineCount(prompt, 12, widthPx);
  const destinationLines = requiredLineCount(`${visit} ${destination}`, 12, widthPx);
  // A wrapped bidi isolate can leave a ragged first fragment after the
  // localized visit label, while the fixed panel estimator is intentionally
  // approximate. Reserve two conservative lines whenever the width model
  // predicts wrapping so optional content gives way before the CTA does.
  const wrapSafety = destinationLines > 1 ? 2 * CTA_LINE : 0;
  return CTA_MARGIN + (promptLines + destinationLines) * CTA_LINE + CTA_LINE_GAP + wrapSafety;
}

/** Which optional PBL sections survive, and how tightly, at a given frame size. */
interface PblCoverPlan {
  description: string;
  descriptionLines: 2 | 3;
  gains: string[];
  people: boolean;
  ctaHeight: number;
}

/**
 * Estimated height of the panel's content box. Localized chrome is measured
 * alongside the authored text: an eyebrow or section heading that wraps in one
 * language and not another moves the whole card down with it.
 */
function pblPlanHeight(title: string, plan: PblCoverPlan, labels: VideoExportLabels): number {
  const gainColumn = (PANEL_CONTENT_WIDTH - GAIN_ROW_GAP) / 2 - 44;
  const gainRows = Math.ceil(plan.gains.length / 2);
  const tallestGainRow = Math.max(1, ...plan.gains.map((g) => lineCount(g, 13, gainColumn, 2)));
  const eyebrowLines = lineCount(labels.pbl, 13, PANEL_CONTENT_WIDTH - EYEBROW_ICON - 8, 3);
  const gainsLabelLines = lineCount(labels.gains, 11, PANEL_CONTENT_WIDTH, 2);
  return (
    Math.max(EYEBROW_ICON, eyebrowLines * EYEBROW_LINE) +
    EYEBROW_MARGIN +
    lineCount(title, 52, PANEL_CONTENT_WIDTH, 2) * TITLE_LINE +
    (plan.description
      ? DESCRIPTION_MARGIN +
        lineCount(plan.description, 19, PANEL_CONTENT_WIDTH * 0.92, plan.descriptionLines) *
          DESCRIPTION_LINE
      : 0) +
    (gainRows > 0
      ? GAINS_MARGIN +
        gainsLabelLines * GAINS_LABEL_LINE +
        GAINS_LABEL_MARGIN +
        gainRows * (22 + 2 + tallestGainRow * GAIN_LINE) +
        (gainRows - 1) * GAIN_ROW_GAP
      : 0) +
    META_MARGIN +
    (plan.people ? PEOPLE_HEIGHT : STATS_HEIGHT) +
    plan.ctaHeight
  );
}

/**
 * Decide what a PBL cover shows at this frame size.
 *
 * The panel is a fixed box, so a dense card (long CJK title, five gains, an
 * instructor and a role-play character) used to overflow it and get silently
 * clipped — losing the bottom section rather than trimming a field. Sections are
 * therefore dropped in reverse priority (people → gains → description) until the
 * estimate fits, so what survives a constrained frame is decided here, not by
 * `overflow:hidden`. Scene type, title and the stage/task counts are never
 * dropped. Per-field `-webkit-line-clamp` still guards what remains.
 *
 * The estimate is text metrics, not layout, so it is a good upper bound rather
 * than a proof; `tests/video-export/cover-card-layout.browser.test.ts` measures
 * the real DOM across scripts and frame sizes to keep it one.
 */
function planPblCover(
  visual: PblCoverVisual,
  labels: VideoExportLabels,
  frame: {
    width: number;
    height: number;
    burnInSubtitles: boolean;
    cta: VideoExportCta | null;
  },
): PblCoverPlan {
  const scale = frame.width / COVER_DESIGN_WIDTH;
  // Burned-in captions are an overlay, not part of the flow, so the panel has
  // to stay clear of the band on its own.
  const subtitleBand = frame.burnInSubtitles ? subtitleBandHeight(frame.height) / scale : 0;
  const budget =
    frame.height / scale -
    2 * CARD_PADDING -
    2 * PANEL_PADDING_Y -
    2 * PANEL_BORDER -
    Math.max(0, subtitleBand);
  const legible = (designPx: number): boolean => designPx * scale >= MIN_LEGIBLE_PX;
  const plan: PblCoverPlan = {
    description: legible(19) ? visual.description : '',
    descriptionLines: 3,
    gains: legible(11) ? visual.gains.slice(0, 5) : [],
    people: legible(9) && Boolean(visual.instructorName ?? visual.scenarioCharacterName),
    ctaHeight: frame.cta
      ? coverCtaHeight(
          labels.pblCtaPrompt,
          labels.ctaVisit,
          frame.cta.destination,
          PANEL_CONTENT_WIDTH,
        )
      : 0,
  };

  const degrade = (): boolean => {
    if (plan.people) {
      plan.people = false;
      return true;
    }
    if (plan.gains.length === 5) {
      plan.gains = plan.gains.slice(0, 4);
      return true;
    }
    if (plan.gains.length === 3 || plan.gains.length === 4) {
      plan.gains = plan.gains.slice(0, 2);
      return true;
    }
    if (plan.gains.length === 1 || plan.gains.length === 2) {
      plan.gains = [];
      return true;
    }
    if (plan.description && plan.descriptionLines === 3) {
      plan.descriptionLines = 2;
      return true;
    }
    if (plan.description) {
      plan.description = '';
      return true;
    }
    return false;
  };

  while (pblPlanHeight(visual.title, plan, labels) > budget && degrade()) {
    // Counts and a configured CTA are core; only optional details degrade.
  }
  return plan;
}

/**
 * Cover-card styles, scaled to the render width.
 *
 * The stage is a fixed-pixel box (`width:${width}px`), so a card written in raw
 * px would keep its 720p type size inside a 4K frame — a small panel floating in
 * a big picture, with 10px captions nobody can read. Every px below is therefore
 * expressed against {@link COVER_DESIGN_WIDTH} and scaled, exactly like the
 * subtitle band in {@link renderSubtitles}. Percent/em values need no scaling.
 *
 * This is also why no length here uses `vw`: viewport units track the browser
 * window, not the composition, so a card sized in `vw` changes size between
 * `hyperframes preview` and `hyperframes render`.
 */
function coverCardCss(width: number): string {
  const scale = width / COVER_DESIGN_WIDTH;
  // Hairlines must survive the round-trip at 720p, hence the 1px floor.
  const px = (value: number): string => `${Math.max(1, Math.round(value * scale))}px`;
  return [
    `  .cover-card { position:absolute;inset:0;display:flex;align-items:center;justify-content:center;overflow:hidden;padding:5.2%;background:#07111f;color:#f8fafc;font-family:Inter,system-ui,sans-serif; }`,
    `  .cover-card * { overflow-wrap:anywhere; }`,
    `  .cover-quiz { background:linear-gradient(145deg,#071426 0%,#102a43 56%,#133f4b 100%); }`,
    `  .cover-pbl { background:linear-gradient(145deg,#0b1020 0%,#161b35 54%,#232042 100%); }`,
    `  .cover-grid { position:absolute;inset:0;opacity:.14;background-image:linear-gradient(rgba(255,255,255,.16) ${px(1)},transparent ${px(1)}),linear-gradient(90deg,rgba(255,255,255,.16) ${px(1)},transparent ${px(1)});background-size:${px(46)} ${px(46)};mask-image:radial-gradient(ellipse at center,#000 35%,transparent 85%); }`,
    `  .cover-orb { position:absolute;border-radius:50%;filter:blur(${px(60)});opacity:.44; }`,
    `  .cover-orb-a { width:48%;height:66%;left:-12%;top:-22%;background:#287ca8; }`,
    `  .cover-orb-b { width:50%;height:68%;right:-15%;bottom:-28%;background:#6d4bc3; }`,
    `  .cover-panel { position:relative;z-index:1;width:min(88%,${px(1040)});max-height:100%;overflow:hidden;border:${px(1)} solid rgba(255,255,255,.13);border-radius:${px(28)};background:rgba(11,18,33,.82);box-shadow:0 ${px(30)} ${px(80)} rgba(0,0,0,.42);backdrop-filter:blur(${px(16)}); }`,
    `  .cover-quiz-panel { width:min(76%,${px(820)});padding:6.5% 8%;text-align:center; }`,
    `  .cover-pbl-panel { padding:4.5% 5.5%; }`,
    `  .cover-eyebrow { display:inline-flex;align-items:center;gap:${px(8)};margin-bottom:${px(18)};color:#8fdcf5;font-size:${px(13)};font-weight:750;letter-spacing:.12em;text-transform:uppercase; }`,
    `  .cover-eyebrow-icon { display:inline-grid;place-items:center;width:${px(26)};height:${px(26)};border-radius:999px;background:rgba(86,197,234,.14);border:${px(1)} solid rgba(111,220,255,.26); }`,
    `  .cover-title { display:-webkit-box;max-width:100%;margin:0;overflow:hidden;-webkit-box-orient:vertical;-webkit-line-clamp:2;font-size:${px(52)};line-height:1.08;letter-spacing:-.035em; }`,
    `  .cover-description { display:-webkit-box;max-width:92%;margin:${px(16)} 0 0;overflow:hidden;-webkit-box-orient:vertical;-webkit-line-clamp:3;color:#c4cedd;font-size:${px(19)};line-height:1.45; }`,
    `  .cover-stats { display:flex;gap:${px(12)}; }`,
    `  .cover-quiz-stats { justify-content:center;margin-top:${px(34)}; }`,
    `  .cover-stat { display:flex;min-width:${px(132)};align-items:baseline;justify-content:center;gap:${px(8)};padding:${px(13)} ${px(18)};border:${px(1)} solid rgba(255,255,255,.11);border-radius:${px(16)};background:rgba(255,255,255,.055); }`,
    `  .cover-stat strong { color:#fff;font-size:${px(28)};line-height:1; }`,
    `  .cover-stat span { color:#aebbd0;font-size:${px(13)};text-transform:uppercase;letter-spacing:.07em; }`,
    `  .cover-gains { margin-top:${px(22)}; }`,
    `  .cover-section-label { margin-bottom:${px(10)};color:#98a8be;font-size:${px(11)};font-weight:750;letter-spacing:.11em;text-transform:uppercase; }`,
    `  .cover-gains ul { display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:${px(9)};margin:0;padding:0;list-style:none; }`,
    `  .cover-gains li { display:flex;min-width:0;align-items:flex-start;gap:${px(9)};padding:${px(10)} ${px(12)};border:${px(1)} solid rgba(255,255,255,.08);border-radius:${px(13)};background:rgba(255,255,255,.035); }`,
    `  .cover-check { flex:0 0 auto;color:#6ee7b7;font-weight:800; }`,
    `  .cover-gain-text { display:-webkit-box;overflow:hidden;-webkit-box-orient:vertical;-webkit-line-clamp:2;color:#e3e9f2;font-size:${px(13)};line-height:1.35; }`,
    `  .cover-pbl-meta { display:grid;grid-template-columns:auto minmax(0,1fr);align-items:stretch;gap:${px(12)};margin-top:${px(20)}; }`,
    `  .cover-people { display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:${px(10)}; }`,
    `  .cover-person { display:flex;min-width:0;align-items:center;gap:${px(10)};padding:${px(PERSON_PADDING_Y)} ${px(12)};border:${px(PERSON_BORDER)} solid rgba(255,255,255,.09);border-radius:${px(14)};background:rgba(255,255,255,.04); }`,
    `  .cover-avatar { display:grid;flex:0 0 auto;place-items:center;width:${px(PERSON_AVATAR_HEIGHT)};height:${px(PERSON_AVATAR_HEIGHT)};border-radius:${px(12)};background:rgba(91,195,233,.17);color:#bdefff;font-size:${px(18)};font-weight:800; }`,
    `  .cover-person-character .cover-avatar { background:rgba(174,123,255,.18);color:#e0ccff; }`,
    `  .cover-person-copy { display:flex;min-width:0;flex-direction:column; }`,
    `  .cover-person-copy span { color:#91a2ba;font-size:${px(9)};font-weight:700;line-height:1.1;letter-spacing:.09em;text-transform:uppercase; }`,
    `  .cover-person-copy strong { overflow:hidden;color:#f5f7fb;font-size:${px(14)};line-height:1.1;text-overflow:ellipsis;white-space:nowrap; }`,
    `  .cover-person-copy small { display:-webkit-box;overflow:hidden;-webkit-box-orient:vertical;-webkit-line-clamp:2;color:#aebbd0;font-size:${px(10)};line-height:1.25; }`,
    `  .cover-cta { display:grid;gap:${px(4)};margin-top:${px(18)};text-align:center; }`,
    `  .cover-cta-line { min-width:0;color:#aebbd0;font-size:${px(12)};line-height:1.35;overflow-wrap:anywhere;white-space:normal; }`,
    `  .cover-cta-line bdi { overflow-wrap:anywhere;word-break:break-word; }`,
    `  .cover-cta-line:last-child { color:#f8fafc;font-weight:700; }`,
  ].join('\n');
}

function renderReadme(project: {
  compositionId: string;
  width: number;
  height: number;
  totalDurationMs: number;
  gsapVendorPath: string;
  manifestPath: string;
  stageName: string;
  locale: string;
  burnInSubtitles: boolean;
  labels: VideoExportLabels;
  cta: VideoExportCta | null;
  hasQuizQuestionList: boolean;
}): string {
  const seconds = (project.totalDurationMs / 1000).toFixed(1);
  const effectiveLabels = JSON.stringify(project.labels, null, 2);
  const effectiveStringOptions = JSON.stringify({
    compositionId: project.compositionId,
    gsapVendorPath: project.gsapVendorPath,
    manifestPath: project.manifestPath,
    locale: project.locale,
    ctaDestination: project.cta?.destination ?? null,
  });
  const optionValue = (value: string): string => {
    const json = JSON.stringify(value)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('|', '&#124;');
    return `<code>${json}</code>`;
  };
  const longestBacktickRun = Math.max(
    0,
    ...(`${effectiveLabels}\n${effectiveStringOptions}`.match(/`+/g) ?? []).map(
      (run) => run.length,
    ),
  );
  const labelsFence = '`'.repeat(Math.max(3, longestBacktickRun + 1));
  return `# ${project.stageName} — OpenMAIC video export

Self-contained [Hyperframes](https://github.com/heygen-com/hyperframes) composition
for the classroom **${project.stageName}**. Everything needed to render is in this
folder — no network access, no CDN.

- \`index.html\` — the composition (one data-composition-id=${optionValue(project.compositionId)} stage, one paused GSAP timeline on \`window.__timelines\`).
- ${optionValue(project.manifestPath)} — the \`VideoTimeline\` manifest / export report (scenes, timing, assets, diagnostics).
- Runtime interactive diagnostics are exposed live through \`window.__openmaicVideoManifest.runtimeDiagnostics\` and the machine-readable DOM report in \`index.html\`.
- \`subtitles.srt\` / \`subtitles.vtt\` — narration subtitles.
- \`assets/frames\`, \`assets/audio\`, \`assets/media\`, \`assets/interactive\` — slide snapshots, narration audio, embedded video clips, frozen interactive pages.
- ${optionValue(project.gsapVendorPath)} — vendored GSAP (determinism: no CDN at render time).
- \`LICENSES/Inter-OFL-1.1.txt\` — license for the font embedded in \`index.html\`.
${
  project.hasQuizQuestionList
    ? '- `assets/fonts` — 20 KaTeX faces plus deterministic Han/Kana and Hangul WOFF2 assets.\n- `LICENSES/KaTeX-MIT.txt` — license for the KaTeX renderer and math-font faces.\n- `LICENSES/Noto-Sans-SC-OFL-1.1.txt` — license for the bundled deterministic Han/Kana face.\n- `LICENSES/Noto-Sans-KR-OFL-1.1.txt` — license for the bundled deterministic Hangul face.'
    : ''
}

## Render

\`\`\`bash
npx hyperframes preview                       # scrub locally in the browser
npx hyperframes render --output video.mp4 --resolution ${project.width}x${project.height}
\`\`\`

Duration: ~${seconds}s at ${project.width}×${project.height}.

## Emitted with

The same manifest, emitter implementation, and complete effective options produce byte-identical HTML.
${
  project.hasQuizQuestionList
    ? 'Quiz CJK (Han/Kana/Hangul), Latin, and math rendering is host-independent because the project bundles those exact faces.'
    : 'Local renders on different hosts do not guarantee identical non-Latin pixels because system fonts may differ.'
}

| Option | Value |
| --- | --- |
| Resolution | \`${project.width}×${project.height}\` |
| Locale | ${optionValue(project.locale)} (card chrome, \`<html lang>\`) |
| Burned-in subtitles | \`${project.burnInSubtitles}\` |
| Composition ID | ${optionValue(project.compositionId)} |
| Manifest path | ${optionValue(project.manifestPath)} |
| GSAP path | ${optionValue(project.gsapVendorPath)} |
| CTA destination | ${project.cta ? optionValue(project.cta.destination) : '<code>disabled</code>'} |

### Effective cover labels

${labelsFence}json
${effectiveLabels}
${labelsFence}

## Verify

\`\`\`bash
npx hyperframes lint                          # no CDN, no non-deterministic APIs, explicit durations
\`\`\`
`;
}

/**
 * Emit the Hyperframes project for a compiled {@link VideoTimeline}. Returns the
 * text files (HTML/manifest/subtitles/README) plus the metadata the packaging
 * layer needs to place the binary assets and the vendored GSAP.
 */
export function emitHyperframes(
  ir: VideoTimeline,
  options: EmitHyperframesOptions = {},
): EmittedProject {
  const width = options.width ?? DEFAULT_WIDTH;
  const height =
    options.height ?? Math.round(width * (ir.canvas.pixelBase.height / ir.canvas.pixelBase.width));
  const compositionId = options.compositionId ?? 'openmaic';
  const gsapVendorPath = options.gsapVendorPath ?? DEFAULT_GSAP_PATH;
  const manifestPath = options.manifestPath ?? DEFAULT_MANIFEST;
  const labels: VideoExportLabels = {
    ...DEFAULT_VIDEO_EXPORT_LABELS,
    ...options.labels,
    interactive: {
      ...DEFAULT_VIDEO_EXPORT_LABELS.interactive,
      ...options.labels?.interactive,
    },
  };
  const cta = options.cta ?? null;
  const locale = options.locale ?? DEFAULT_LOCALE;
  const totalSec = sec(ir.totalDurationMs);
  const hasInteractiveHtml = ir.scenes.some((scene) => scene.base.kind === 'interactive-html');
  const hasQuizQuestionList = ir.scenes.some((scene) =>
    scene.visuals.some((visual) => visual.kind === 'quiz-question-list'),
  );

  const sceneHtml: string[] = [];
  const effectHtml: string[] = [];
  const statements: string[] = [];

  for (const scene of ir.scenes) {
    sceneHtml.push(`<!-- scene ${scene.index + 1}: ${escapeHtml(scene.title)} -->`);
    sceneHtml.push(renderBase(scene, labels));
    const visuals = renderVisuals(
      scene,
      labels,
      {
        width,
        height,
        burnInSubtitles: options.burnInSubtitles === true && ir.subtitles.length > 0,
      },
      cta,
      isRtl(locale) ? 'rtl' : 'ltr',
    );
    sceneHtml.push(...visuals.html);
    statements.push(...visuals.statements);
    sceneHtml.push(...renderVideo(scene));
    sceneHtml.push(...renderNarration(scene));

    for (const effect of scene.effects) {
      const id = `fx-${scene.index}-${effect.actionIndex}`;
      const emitted = emitEffect(effect, id, { width, height });
      if (emitted.html) effectHtml.push(emitted.html);
      statements.push(...emitted.statements);
    }
  }

  // Burned-in subtitle overlay, driven by the same paused timeline. Off by
  // default — a clean video plus sidecar SRT/VTT (#867 item 2). The SRT/VTT
  // files are written regardless (below), so downloading subtitles never
  // depends on this flag.
  const subtitles = options.burnInSubtitles
    ? renderSubtitles(ir, height)
    : { html: '', statements: [] };
  statements.push(...subtitles.statements);

  // Extend the timeline to the full composition length even if the last tween
  // ends earlier, so clips (esp. video/audio) are not cut short.
  statements.push(`tl.set({}, {}, ${totalSec});`);

  const html = `<!doctype html>
<html lang="${escapeHtml(locale)}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(ir.stage.name)} — OpenMAIC video</title>
<style>
  ${INTER_FONT_FACE_CSS}${
    hasQuizQuestionList ? `\n  ${NOTO_CJK_EXPORT_CSS}\n  ${KATEX_EXPORT_CSS}` : ''
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: #000; }
  #${compositionId} { font-family:Inter,system-ui,sans-serif; }
${coverCardCss(width)}${hasQuizQuestionList ? `\n${quizQuestionListCss(width)}` : ''}
</style>
</head>
<body>
<div id="${compositionId}" data-composition-id="${compositionId}" data-start="0" data-duration="${totalSec}" data-width="${width}" data-height="${height}" style="position:relative;width:${width}px;height:${height}px;overflow:hidden;background:#000">
${sceneHtml.filter(Boolean).join('\n')}
${effectHtml.join('\n')}
${subtitles.html}
<script type="application/json" data-openmaic-runtime-diagnostics>[]</script>
</div>
<script src="${escapeHtml(gsapVendorPath)}"></script>
<script>
${EASE_DEFS}
var tl = gsap.timeline({ paused: true });
${statements.join('\n')}
window.__openmaicVideoManifest = { runtimeDiagnostics: [], manifestPath: ${JSON.stringify(manifestPath)} };
window.__timelines = window.__timelines || {};
${
  hasInteractiveHtml
    ? `${interactiveStaticBridgeScript(labels.interactive)}
window.__openmaicInteractiveReady = initializeOpenMaicInteractiveStaticFrames();
window.__openmaicInteractiveReady.then(function () {
  window.__timelines[${JSON.stringify(compositionId)}] = tl;
});`
    : `window.__timelines[${JSON.stringify(compositionId)}] = tl;`
}
</script>
</body>
</html>
`;

  const files: EmittedFile[] = [
    { path: 'index.html', content: html },
    { path: 'LICENSES/Inter-OFL-1.1.txt', content: INTER_OFL_LICENSE },
    ...(hasQuizQuestionList
      ? [
          { path: 'LICENSES/KaTeX-MIT.txt', content: KATEX_MIT_LICENSE },
          {
            path: 'LICENSES/Noto-Sans-SC-OFL-1.1.txt',
            content: NOTO_SANS_SC_OFL_LICENSE,
          },
          {
            path: 'LICENSES/Noto-Sans-KR-OFL-1.1.txt',
            content: NOTO_SANS_KR_OFL_LICENSE,
          },
        ]
      : []),
    { path: manifestPath, content: emitManifestJson(ir) },
    { path: 'subtitles.srt', content: toSrt(ir.subtitles) },
    { path: 'subtitles.vtt', content: toVtt(ir.subtitles) },
    {
      path: 'README.md',
      content: renderReadme({
        compositionId,
        width,
        height,
        totalDurationMs: ir.totalDurationMs,
        gsapVendorPath,
        manifestPath,
        stageName: ir.stage.name,
        locale,
        burnInSubtitles: options.burnInSubtitles === true,
        labels,
        cta,
        hasQuizQuestionList,
      }),
    },
  ];

  return {
    files,
    vendorAssets: hasQuizQuestionList ? [...NOTO_CJK_FONT_ASSETS, ...KATEX_FONT_ASSETS] : [],
    width,
    height,
    compositionId,
    totalDurationMs: ir.totalDurationMs,
    gsapVendorPath,
  };
}
