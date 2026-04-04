/**
 * course-builder.ts
 * Assembles all scene fragments into a single SCORM 1.2 SCO HTML file (index.html).
 *
 * Architecture: single SCO with internal JS navigation.
 * - All scenes are <section> elements; only the current one is visible.
 * - Navigation (Prev/Next) is handled entirely in JS.
 * - Slide canvases scale responsively via transform:scale() with a wrapper
 *   that tracks the visual (scaled) dimensions so flex centering works correctly.
 * - Narration audio plays automatically on slide load; user can pause/resume/restart.
 * - SCORM completion is set only when the user reaches the last scene.
 * - Quiz sections call window.onQuizSubmitted(sceneIdx, score) on submit.
 */
import type { SlideSceneMeta } from './slide-sco';
import type { QuizSceneMeta } from './quiz-sco';
import type { InteractiveSceneMeta } from './interactive-sco';
import { QUIZ_PASS_THRESHOLD } from './quiz-sco';

export type SceneMeta = SlideSceneMeta | QuizSceneMeta | InteractiveSceneMeta;

export interface CourseHtmlOptions {
  courseName: string;
  sections: Array<{ html: string; meta: SceneMeta }>;
  needsKatex: boolean;
}

const NAV_HEIGHT = 52; // px — fixed bottom nav bar height

/** Serialise scene metadata for the JS runtime (avoids any TS types in output) */
function serializeMeta(metas: SceneMeta[]): string {
  return JSON.stringify(
    metas.map((m) => {
      if (m.type === 'slide') {
        return {
          type: 'slide', id: m.sceneId,
          canvasId: m.canvasId, scalerId: m.scalerId,
          cw: m.cw, ch: m.ch, narrIds: m.narrIds,
        };
      }
      if (m.type === 'quiz') {
        return { type: 'quiz', id: m.sceneId, questionCount: m.questionCount };
      }
      return { type: 'interactive', id: m.sceneId };
    }),
  );
}

export function buildCourseHtml(opts: CourseHtmlOptions): string {
  const { courseName, sections, needsKatex } = opts;
  const metas = sections.map((s) => s.meta);
  const totalScenes = sections.length;
  const hasQuiz = metas.some((m) => m.type === 'quiz');

  const sceneSections = sections.map((s) => s.html).join('\n\n');
  const metasJson = serializeMeta(metas);

  const katexLink = needsKatex
    ? `<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.css" crossorigin="anonymous" onerror="this.remove()">`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${courseName.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</title>
  <script src="scorm_bridge.js"></script>
  ${katexLink}
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    html, body {
      width: 100%; height: 100%;
      overflow: hidden;
      font-family: 'Segoe UI', Arial, sans-serif;
      background: #111;
    }

    /* ── Scene container ── */
    .scene {
      position: fixed;
      inset: 0;
      bottom: ${NAV_HEIGHT}px;
    }

    /* ── Slide scenes ── */
    .scene-slide {
      background: #1a1a1a;
      display: flex;
      align-items: center;
      justify-content: center;
      overflow: hidden;
    }
    /* slide-scaler: sized to VISUAL (scaled) dimensions — flex lays out around this */
    .slide-scaler {
      position: relative;
      flex-shrink: 0;
    }
    /* slide-canvas: full 960×N canvas, scaled from top-left inside .slide-scaler */
    .slide-canvas {
      position: absolute;
      top: 0; left: 0;
      transform-origin: top left;
      overflow: hidden;
    }

    /* ── Quiz scenes ── */
    .scene-quiz {
      background: #f5f5f7;
      overflow-y: auto;
    }
    .quiz-scroll {
      max-width: 760px;
      margin: 0 auto;
      padding: 2rem 1.5rem;
    }
    .quiz-title {
      font-size: 1.4rem;
      font-weight: 700;
      margin-bottom: 1.5rem;
      color: #1d1d1f;
    }
    .question-block {
      background: #fff;
      border-radius: 10px;
      padding: 1.25rem 1.5rem;
      margin-bottom: 1.25rem;
      box-shadow: 0 1px 4px rgba(0,0,0,0.08);
    }
    .question-text {
      font-size: 1rem;
      font-weight: 600;
      margin-bottom: 1rem;
      line-height: 1.5;
    }
    .q-num { color: #6e6e73; margin-right: 4px; }
    .q-multi-hint { font-size: 0.8rem; font-weight: 400; color: #6e6e73; }
    .options-list { display: flex; flex-direction: column; gap: 0.5rem; }
    .option-label {
      display: flex; align-items: flex-start; gap: 10px;
      padding: 0.6rem 0.75rem;
      border-radius: 6px; cursor: pointer;
      border: 1.5px solid #e0e0e5;
      transition: border-color 0.15s, background 0.15s;
    }
    .option-label:hover { border-color: #0071e3; background: #f0f6ff; }
    .option-label input { margin-top: 2px; accent-color: #0071e3; }
    .option-value { font-weight: 600; min-width: 20px; color: #6e6e73; }
    .option-text { flex: 1; }
    .option-label.opt-correct  { border-color: #34c759; background: #f0faf3; }
    .option-label.opt-incorrect { border-color: #ff3b30; background: #fff5f4; }
    .option-label.opt-missed   { border-color: #34c759; background: #f0faf3; border-style: dashed; }
    .analysis {
      margin-top: 0.75rem; padding: 0.6rem 0.75rem;
      background: #f9f9fb; border-left: 3px solid #0071e3;
      font-size: 0.9rem; color: #444; border-radius: 0 4px 4px 0;
      display: none;
    }
    .result-bar {
      margin: 1rem 0; padding: 0.75rem 1rem;
      border-radius: 8px; font-weight: 600; font-size: 1rem;
    }
    .result-pass { background: #f0faf3; color: #1a7f37; border: 1.5px solid #34c759; }
    .result-fail { background: #fff5f4; color: #c0392b; border: 1.5px solid #ff3b30; }
    .submit-btn {
      display: block; width: 100%; padding: 0.8rem;
      background: #0071e3; color: #fff; border: none;
      border-radius: 8px; font-size: 1rem; font-weight: 600; cursor: pointer;
      margin-top: 1rem;
    }
    .submit-btn:hover:not(:disabled) { background: #0077ed; }
    .submit-btn:disabled { background: #b0c8e8; cursor: not-allowed; }

    /* ── Interactive scenes ── */
    .scene-interactive { background: #fff; }
    .interactive-frame { width: 100%; height: 100%; border: none; }

    /* ── Navigation bar (fixed bottom) ── */
    #nav-bar {
      position: fixed;
      bottom: 0; left: 0; right: 0;
      height: ${NAV_HEIGHT}px;
      background: #fff;
      border-top: 1px solid #e0e0e5;
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 1rem;
      gap: 0.5rem;
      z-index: 1000;
    }
    .nav-btn {
      background: #f5f5f7; border: 1.5px solid #d0d0d5;
      padding: 6px 14px; border-radius: 6px;
      cursor: pointer; font-size: 0.85rem; font-weight: 500;
      white-space: nowrap;
      flex-shrink: 0;
    }
    .nav-btn:hover:not(:disabled) { background: #e8e8ed; }
    .nav-btn:disabled { opacity: 0.4; cursor: not-allowed; }
    #nav-center {
      flex: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 0.75rem;
      min-width: 0;
    }
    #scene-title {
      font-size: 0.85rem;
      font-weight: 600;
      color: #1d1d1f;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    #scene-counter {
      font-size: 0.8rem;
      color: #6e6e73;
      white-space: nowrap;
      flex-shrink: 0;
    }

    /* ── Audio control (inline with nav) ── */
    #narr-ctrl { display: none; align-items: center; gap: 6px; flex-shrink: 0; }
    #narr-play-btn {
      background: #f0f0f5; border: 1.5px solid #c0c0c8;
      padding: 5px 10px; border-radius: 6px; cursor: pointer;
      font-size: 0.8rem; white-space: nowrap;
    }
    #narr-play-btn:hover { background: #e4e4ec; }
  </style>
</head>
<body>

<!-- ── All scene sections ── -->
${sceneSections}

<!-- ── Fixed navigation bar ── -->
<div id="nav-bar">
  <button class="nav-btn" id="prev-btn" onclick="prevScene()" disabled>&#8592; Prev</button>

  <div id="nav-center">
    <span id="scene-title"></span>
    <span id="scene-counter"></span>
  </div>

  <!-- Narration audio controls (only visible for slide scenes with TTS) -->
  <div id="narr-ctrl">
    <button id="narr-play-btn" onclick="toggleNarration()">&#9654; Play</button>
    <button class="nav-btn" onclick="restartNarration()" title="Restart narration">&#8635;</button>
  </div>

  <button class="nav-btn" id="next-btn" onclick="nextScene()">Next &#8594;</button>
</div>

<script>
// ── Scene definitions ──
var SCENES = ${metasJson};
var TOTAL = ${totalScenes};
var currentIdx = 0;
var quizScores = {}; // sceneIdx → 0-100

// ── Narration state ──
var narrEls = [];
var narrIdx = 0;
var narrPlaying = false;

function stopNarration() {
  narrEls.forEach(function(a) {
    a.pause();
    a.currentTime = 0;
    a.onended = null;
  });
  narrEls = [];
  narrIdx = 0;
  narrPlaying = false;
  document.getElementById('narr-play-btn').textContent = '\\u25B6 Play';
}

function playNarrFrom(idx) {
  if (idx >= narrEls.length) {
    narrPlaying = false;
    document.getElementById('narr-play-btn').textContent = '\\u25B6 Play';
    return;
  }
  narrIdx = idx;
  narrPlaying = true;
  document.getElementById('narr-play-btn').textContent = '\\u23F8 Pause';
  narrEls[idx].onended = function() { playNarrFrom(idx + 1); };
  narrEls[idx].play().catch(function() {
    narrPlaying = false;
    document.getElementById('narr-play-btn').textContent = '\\u25B6 Play';
  });
}

function startNarration(scene) {
  stopNarration();
  if (!scene.narrIds || !scene.narrIds.length) return;
  narrEls = scene.narrIds.map(function(id) {
    return document.getElementById(id);
  }).filter(Boolean);
  if (narrEls.length) playNarrFrom(0);
}

function toggleNarration() {
  if (!narrEls.length) return;
  var el = narrEls[narrIdx] || narrEls[0];
  if (!el) return;
  if (el.paused) {
    narrPlaying = true;
    el.play().catch(function(){});
    document.getElementById('narr-play-btn').textContent = '\\u23F8 Pause';
  } else {
    el.pause();
    narrPlaying = false;
    document.getElementById('narr-play-btn').textContent = '\\u25B6 Play';
  }
}

function restartNarration() {
  var scene = SCENES[currentIdx];
  if (scene && scene.type === 'slide') startNarration(scene);
}

// ── Slide scaling ──
function rescaleSlide(scene) {
  var sectionEl = document.getElementById(scene.id);
  var availW = sectionEl.offsetWidth;
  var availH = sectionEl.offsetHeight;
  if (!availW || !availH) return;
  var s = Math.min(availW / scene.cw, availH / scene.ch);
  var scaler = document.getElementById(scene.scalerId);
  var canvas = document.getElementById(scene.canvasId);
  scaler.style.width  = (scene.cw * s) + 'px';
  scaler.style.height = (scene.ch * s) + 'px';
  canvas.style.transform = 'scale(' + s + ')';
}

window.addEventListener('resize', function() {
  var s = SCENES[currentIdx];
  if (s && s.type === 'slide') rescaleSlide(s);
});

// ── Scene navigation ──
function showScene(idx) {
  stopNarration();

  // Hide all, show target
  SCENES.forEach(function(s) {
    var el = document.getElementById(s.id);
    if (el) el.style.display = 'none';
  });
  var scene = SCENES[idx];
  var sceneEl = document.getElementById(scene.id);
  if (sceneEl) sceneEl.style.display = '';
  currentIdx = idx;

  // Update nav bar text
  document.getElementById('scene-title').textContent = scene.title || '';
  document.getElementById('scene-counter').textContent = (idx + 1) + ' / ' + TOTAL;

  // Prev button
  document.getElementById('prev-btn').disabled = (idx === 0);

  // Next button: disabled on last scene, or quiz not yet submitted
  var isLast = (idx === TOTAL - 1);
  var isQuizNotDone = scene.type === 'quiz' && quizScores[idx] === undefined;
  document.getElementById('next-btn').disabled = isLast || isQuizNotDone;

  // Narration controls
  var narrCtrl = document.getElementById('narr-ctrl');
  if (scene.type === 'slide' && scene.narrIds && scene.narrIds.length) {
    narrCtrl.style.display = 'flex';
    startNarration(scene);
  } else {
    narrCtrl.style.display = 'none';
  }

  // Rescale slides
  if (scene.type === 'slide') {
    // small timeout to let the browser render first
    setTimeout(function() { rescaleSlide(scene); }, 0);
  }

  // SCORM: report progress
  var progress = Math.round(((idx + 1) / TOTAL) * 100);
  SCORM.setValue('cmi.core.score.raw', progress);
  SCORM.setValue('cmi.core.score.min', '0');
  SCORM.setValue('cmi.core.score.max', '100');
  SCORM.commit();

  // SCORM: complete only on last scene
  if (isLast) {
    SCORM.setCompleted();
  }
}

function prevScene() {
  if (currentIdx > 0) showScene(currentIdx - 1);
}

function nextScene() {
  if (currentIdx < TOTAL - 1) showScene(currentIdx + 1);
}

// Called by quiz sections after submit
window.onQuizSubmitted = function(sceneIdx, score) {
  quizScores[sceneIdx] = score;
  // Enable Next (unless it was the last scene)
  if (sceneIdx < TOTAL - 1) {
    document.getElementById('next-btn').disabled = false;
  } else {
    // Last scene is a quiz — complete now
    SCORM.setScore(score, 0, 100);
    if (score >= ${QUIZ_PASS_THRESHOLD}) {
      SCORM.setPassed();
    } else {
      SCORM.setFailed();
    }
  }
};

// ── Init ──
window.addEventListener('load', function() {
  SCORM.init();
  SCORM.setValue('cmi.core.lesson_status', 'incomplete');

  // Set title on each scene (used in showScene)
  var sceneTitles = ${JSON.stringify(sections.map((s) => s.meta.type === 'slide'
    ? '' // title comes from scene data passed via JS — we embed it differently
    : ''))};
  // Titles are embedded directly in the SCENES array below:
  // (done at build time, no runtime injection needed)

  showScene(0);
});

window.addEventListener('beforeunload', function() {
  SCORM.finish();
});

// Patch scene titles from DOM (each section has a data-title attribute)
(function() {
  SCENES.forEach(function(s, i) {
    var el = document.getElementById(s.id);
    if (el) s.title = el.getAttribute('data-title') || s.id;
  });
})();
</script>
</body>
</html>`;
}
