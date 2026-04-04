/**
 * course-builder.ts
 * Assembles all scene fragments into a single SCORM 1.2 SCO (index.html).
 *
 * Layout:
 *   - Fixed 240px left sidebar with scene list and progress indicator
 *   - Scene area fills the remaining right space (position:fixed, left:240px)
 *   - Fixed 52px nav bar at the bottom (also right of sidebar)
 *
 * CSS: all class names prefixed with "om-" to avoid conflicts with LMS stylesheets
 * (Bootstrap, Moodle, etc. commonly define .scene, .option-label, .submit-btn, etc.)
 */
import type { SlideSceneMeta } from './slide-sco';
import type { QuizSceneMeta } from './quiz-sco';
import type { InteractiveSceneMeta } from './interactive-sco';
import { QUIZ_PASS_THRESHOLD } from './quiz-sco';

export type SceneMeta = SlideSceneMeta | QuizSceneMeta | InteractiveSceneMeta;

export interface CourseHtmlOptions {
  courseName: string;
  /** Each section includes the pre-built HTML fragment, its metadata, and the scene title. */
  sections: Array<{ html: string; meta: SceneMeta; title: string }>;
  needsKatex: boolean;
}

const SIDEBAR_W = 240; // px
const NAV_H = 52;      // px

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

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

  const sidebarItems = sections
    .map((s, i) => `    <li id="om-nav-${i}" class="om-nav-item" onclick="sidebarGo(${i})" title="${escHtml(s.title)}">
      <span class="om-nav-dot"></span>
      <span class="om-nav-label">${escHtml(s.title)}</span>
    </li>`)
    .join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escHtml(courseName)}</title>
  <script src="scorm_bridge.js"></script>
  ${katexLink}
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    html, body { width: 100%; height: 100%; overflow: hidden; font-family: 'Segoe UI', Arial, sans-serif; background: #111; }

    /* ── Sidebar ── */
    #om-sidebar {
      position: fixed;
      left: 0; top: 0; bottom: 0;
      width: ${SIDEBAR_W}px;
      background: #0d1b2a;
      border-right: 1px solid rgba(255,255,255,0.08);
      display: flex;
      flex-direction: column;
      z-index: 200;
      overflow: hidden;
    }
    #om-sidebar-header {
      padding: 1.2rem 1rem 1rem;
      flex-shrink: 0;
      border-bottom: 1px solid rgba(255,255,255,0.08);
    }
    #om-course-title {
      font-size: 0.85rem;
      font-weight: 700;
      color: #fff;
      line-height: 1.35;
      margin-bottom: 0.6rem;
    }
    #om-progress-label {
      font-size: 0.68rem;
      color: #8090a8;
      margin-bottom: 0.35rem;
    }
    #om-progress-bar {
      height: 3px;
      background: rgba(255,255,255,0.12);
      border-radius: 2px;
    }
    #om-progress-fill {
      height: 100%;
      background: #0071e3;
      border-radius: 2px;
      width: 0%;
      transition: width 0.4s ease;
    }
    #om-scene-list {
      list-style: none;
      flex: 1;
      overflow-y: auto;
      padding: 0.5rem 0;
    }
    #om-scene-list::-webkit-scrollbar { width: 4px; }
    #om-scene-list::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.15); border-radius: 2px; }
    .om-nav-item {
      display: flex;
      align-items: flex-start;
      gap: 10px;
      padding: 0.55rem 1rem;
      cursor: pointer;
      border-left: 3px solid transparent;
      transition: background 0.12s, border-color 0.12s;
    }
    .om-nav-item:hover { background: rgba(255,255,255,0.06); }
    .om-nav-item.om-active {
      background: rgba(0,113,227,0.18);
      border-left-color: #0071e3;
    }
    .om-nav-dot {
      width: 16px; height: 16px;
      border-radius: 50%;
      border: 1.5px solid #4a5a6a;
      flex-shrink: 0;
      margin-top: 2px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 9px;
      font-weight: bold;
      color: transparent;
      transition: all 0.2s;
    }
    .om-nav-item.om-visited .om-nav-dot {
      background: #34c759;
      border-color: #34c759;
      color: #fff;
    }
    .om-nav-item.om-active .om-nav-dot { border-color: #0071e3; }
    .om-nav-item.om-active.om-visited .om-nav-dot {
      background: #0071e3;
      border-color: #0071e3;
      color: #fff;
    }
    .om-nav-label {
      font-size: 0.76rem;
      color: #9aa8ba;
      line-height: 1.35;
    }
    .om-nav-item.om-active .om-nav-label { color: #e0e8f0; }

    /* ── Scene container ── */
    .om-scene {
      position: fixed;
      left: ${SIDEBAR_W}px;
      right: 0;
      top: 0;
      bottom: ${NAV_H}px;
    }

    /* ── Slide scenes ── */
    .om-slide {
      background: #1a1a1a;
      display: flex;
      align-items: center;
      justify-content: center;
      overflow: hidden;
    }
    /* om-scaler: sized to VISUAL (scaled) dimensions — flex lays out around this */
    .om-scaler {
      position: relative;
      flex-shrink: 0;
    }
    /* om-canvas: full-resolution canvas, scaled from top-left inside .om-scaler */
    .om-canvas {
      position: absolute;
      top: 0; left: 0;
      transform-origin: top left;
      overflow: hidden;
    }

    /* ── Quiz scenes ── */
    .om-quiz {
      background: #f5f5f7;
      overflow-y: auto;
    }
    .om-quiz-scroll {
      max-width: 760px;
      margin: 0 auto;
      padding: 2rem 1.5rem;
    }
    .om-quiz-title {
      font-size: 1.4rem;
      font-weight: 700;
      margin-bottom: 1.5rem;
      color: #1d1d1f;
    }
    .om-qblock {
      background: #fff;
      border-radius: 10px;
      padding: 1.25rem 1.5rem;
      margin-bottom: 1.25rem;
      box-shadow: 0 1px 4px rgba(0,0,0,0.08);
    }
    .om-qtext {
      font-size: 1rem;
      font-weight: 600;
      margin-bottom: 1rem;
      line-height: 1.5;
    }
    .om-qnum { color: #6e6e73; margin-right: 4px; }
    .om-qhint { font-size: 0.8rem; font-weight: 400; color: #6e6e73; }
    .om-opts { display: flex; flex-direction: column; gap: 0.5rem; }
    .om-opt {
      display: flex;
      align-items: flex-start;
      gap: 10px;
      padding: 0.6rem 0.75rem;
      border-radius: 6px;
      cursor: pointer;
      border: 1.5px solid #e0e0e5;
      transition: border-color 0.15s, background 0.15s;
    }
    .om-opt:hover { border-color: #0071e3; background: #f0f6ff; }
    .om-opt input { margin-top: 2px; accent-color: #0071e3; }
    .om-optval { font-weight: 600; min-width: 20px; color: #6e6e73; }
    .om-opttext { flex: 1; }
    .om-opt.om-correct  { border-color: #34c759; background: #f0faf3; }
    .om-opt.om-wrong    { border-color: #ff3b30; background: #fff5f4; }
    .om-opt.om-missed   { border-color: #34c759; background: #f0faf3; border-style: dashed; }
    .om-analysis {
      margin-top: 0.75rem;
      padding: 0.6rem 0.75rem;
      background: #f9f9fb;
      border-left: 3px solid #0071e3;
      font-size: 0.9rem;
      color: #444;
      border-radius: 0 4px 4px 0;
      display: none;
    }
    .om-result {
      margin: 1rem 0;
      padding: 0.75rem 1rem;
      border-radius: 8px;
      font-weight: 600;
      font-size: 1rem;
    }
    .om-pass { background: #f0faf3; color: #1a7f37; border: 1.5px solid #34c759; }
    .om-fail { background: #fff5f4; color: #c0392b; border: 1.5px solid #ff3b30; }
    .om-submit {
      display: block;
      width: 100%;
      padding: 0.8rem;
      background: #0071e3;
      color: #fff;
      border: none;
      border-radius: 8px;
      font-size: 1rem;
      font-weight: 600;
      cursor: pointer;
      margin-top: 1rem;
    }
    .om-submit:hover:not(:disabled) { background: #0077ed; }
    .om-submit:disabled { background: #b0c8e8; cursor: not-allowed; }

    /* ── Interactive scenes ── */
    .om-interactive { background: #fff; }
    .om-iframe { width: 100%; height: 100%; border: none; }

    /* ── Navigation bar (fixed bottom, right of sidebar) ── */
    #nav-bar {
      position: fixed;
      bottom: 0;
      left: ${SIDEBAR_W}px;
      right: 0;
      height: ${NAV_H}px;
      background: #fff;
      border-top: 1px solid #e0e0e5;
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 1rem;
      gap: 0.5rem;
      z-index: 1000;
    }
    .om-nav-btn {
      background: #f5f5f7;
      border: 1.5px solid #d0d0d5;
      padding: 6px 14px;
      border-radius: 6px;
      cursor: pointer;
      font-size: 0.85rem;
      font-weight: 500;
      white-space: nowrap;
      flex-shrink: 0;
    }
    .om-nav-btn:hover:not(:disabled) { background: #e8e8ed; }
    .om-nav-btn:disabled { opacity: 0.4; cursor: not-allowed; }
    #nav-center {
      flex: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 0.75rem;
      min-width: 0;
    }
    #scene-counter {
      font-size: 0.8rem;
      color: #6e6e73;
      white-space: nowrap;
      flex-shrink: 0;
    }
    #narr-ctrl { display: none; align-items: center; gap: 6px; flex-shrink: 0; }
    #narr-play-btn {
      background: #f0f0f5;
      border: 1.5px solid #c0c0c8;
      padding: 5px 10px;
      border-radius: 6px;
      cursor: pointer;
      font-size: 0.8rem;
      white-space: nowrap;
    }
    #narr-play-btn:hover { background: #e4e4ec; }
  </style>
</head>
<body>

<!-- ── Sidebar ── -->
<nav id="om-sidebar">
  <div id="om-sidebar-header">
    <div id="om-course-title">${escHtml(courseName)}</div>
    <div id="om-progress-label">0 / ${totalScenes} completades</div>
    <div id="om-progress-bar"><div id="om-progress-fill"></div></div>
  </div>
  <ul id="om-scene-list">
${sidebarItems}
  </ul>
</nav>

<!-- ── All scene sections ── -->
${sceneSections}

<!-- ── Fixed navigation bar ── -->
<div id="nav-bar">
  <button class="om-nav-btn" id="prev-btn" onclick="prevScene()" disabled>&#8592; Prev</button>

  <div id="nav-center">
    <span id="scene-counter">1 / ${totalScenes}</span>
  </div>

  <!-- Narration controls (visible only for slides with TTS) -->
  <div id="narr-ctrl">
    <button id="narr-play-btn" onclick="toggleNarration()">&#9654; Play</button>
    <button class="om-nav-btn" onclick="restartNarration()" title="Restart narration">&#8635;</button>
  </div>

  <button class="om-nav-btn" id="next-btn" onclick="nextScene()">Next &#8594;</button>
</div>

<script>
// ── Scene definitions ──
var SCENES = ${metasJson};
var TOTAL = ${totalScenes};
var currentIdx = 0;
var quizScores = {};

// ── Visit tracking ──
var visitedArr = [];
for (var _vi = 0; _vi < TOTAL; _vi++) visitedArr.push(false);

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
  if (!scaler || !canvas) return;
  scaler.style.width  = (scene.cw * s) + 'px';
  scaler.style.height = (scene.ch * s) + 'px';
  canvas.style.transform = 'scale(' + s + ')';
}

window.addEventListener('resize', function() {
  var s = SCENES[currentIdx];
  if (s && s.type === 'slide') rescaleSlide(s);
});

// ── Sidebar ──
function updateSidebar(idx) {
  var visitedCount = 0;
  for (var i = 0; i < TOTAL; i++) {
    if (visitedArr[i]) visitedCount++;
    var item = document.getElementById('om-nav-' + i);
    if (!item) continue;
    var cls = 'om-nav-item';
    if (visitedArr[i]) cls += ' om-visited';
    if (i === idx) cls += ' om-active';
    item.className = cls;
    var dot = item.querySelector('.om-nav-dot');
    if (dot) dot.textContent = visitedArr[i] ? '\\u2713' : '';
    // Scroll active item into view
    if (i === idx) {
      item.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }
  document.getElementById('om-progress-label').textContent =
    visitedCount + ' / ' + TOTAL + ' completades';
  document.getElementById('om-progress-fill').style.width =
    Math.round((visitedCount / TOTAL) * 100) + '%';
}

function sidebarGo(idx) {
  showScene(idx);
}

// ── SCORM suspend_data persistence ──
function saveSuspendData() {
  var visitedStr = '';
  for (var i = 0; i < TOTAL; i++) {
    visitedStr += visitedArr[i] ? '1' : '0';
  }
  var suspendData = JSON.stringify({ v: visitedStr, q: quizScores });
  SCORM.setValue('cmi.core.lesson_location', String(currentIdx));
  SCORM.setValue('cmi.suspend_data', suspendData);
}

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

  // Mark visited
  visitedArr[idx] = true;

  // Sidebar + counter
  updateSidebar(idx);
  document.getElementById('scene-counter').textContent = (idx + 1) + ' / ' + TOTAL;

  // Prev / Next buttons
  document.getElementById('prev-btn').disabled = (idx === 0);
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
    setTimeout(function() { rescaleSlide(scene); }, 0);
  }

  // SCORM: report progress as % scenes visited
  var visitedCount = 0;
  for (var j = 0; j < TOTAL; j++) if (visitedArr[j]) visitedCount++;
  var progress = Math.round((visitedCount / TOTAL) * 100);
  SCORM.setValue('cmi.core.score.raw', progress);
  SCORM.setValue('cmi.core.score.min', '0');
  SCORM.setValue('cmi.core.score.max', '100');
  saveSuspendData();
  SCORM.commit();

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
  saveSuspendData();
  SCORM.commit();
  if (sceneIdx < TOTAL - 1) {
    document.getElementById('next-btn').disabled = false;
  } else {
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

  // Restore suspend_data (visited scenes + quiz scores)
  var savedData = SCORM.getValue('cmi.suspend_data');
  if (savedData) {
    try {
      var state = JSON.parse(savedData);
      if (state.v) {
        for (var i = 0; i < state.v.length && i < TOTAL; i++) {
          visitedArr[i] = state.v[i] === '1';
        }
      }
      if (state.q) {
        var keys = Object.keys(state.q);
        for (var ki = 0; ki < keys.length; ki++) {
          quizScores[parseInt(keys[ki], 10)] = state.q[keys[ki]];
        }
      }
    } catch (e) {}
  }

  // Do not overwrite 'completed'/'passed' with 'incomplete'
  var currentStatus = SCORM.getValue('cmi.core.lesson_status');
  if (currentStatus !== 'completed' && currentStatus !== 'passed') {
    SCORM.setValue('cmi.core.lesson_status', 'incomplete');
  }

  // Resume at last saved position
  var startIdx = 0;
  var savedLocation = SCORM.getValue('cmi.core.lesson_location');
  if (savedLocation) {
    var parsed = parseInt(savedLocation, 10);
    if (!isNaN(parsed) && parsed >= 0 && parsed < TOTAL) {
      startIdx = parsed;
    }
  }

  showScene(startIdx);
});

window.addEventListener('beforeunload', function() {
  SCORM.finish();
});
</script>
</body>
</html>`;
}
