// lib/export/scorm/scorm-player-template.ts
//
// Static assets for the self-contained SCORM player shipped inside the
// exported package. Kept as template strings (not separate public/ files) so
// the export path has zero network dependencies and the player version is
// pinned to the app build that produced the package.
//
// Player contract:
// - Loads `data/course.json` (shape: `ScormCourseData`).
// - Renders one scene at a time with prev/next navigation and a progress rail.
// - Slides render their pre-baked PNG snapshot plus optional narration audio
//   and transcript. Quizzes render interactive forms and grade locally.
// - SCORM 1.2 runtime calls: LMSInitialize on boot, cmi.core.lesson_location
//   for resume, cmi.core.score.raw + lesson_status on quiz submission and
//   course completion, LMSFinish on unload.
// - Degrades gracefully to a standalone offline viewer when no SCORM API is
//   found (e.g. the ZIP is unpacked and opened directly in a browser).

/** `js/scorm-api.js` — SCORM 1.2 runtime discovery + thin wrapper. */
export const SCORM_API_JS = String.raw`/* OpenMAIC SCORM 1.2 API wrapper */
(function (global) {
  'use strict';

  var MAX_PARENT_HOPS = 10;

  function scanForApi(win) {
    var hops = 0;
    while (win && hops < MAX_PARENT_HOPS) {
      if (win.API) return win.API;
      if (win.parent && win.parent !== win) {
        win = win.parent;
        hops++;
      } else {
        break;
      }
    }
    return null;
  }

  function findApi() {
    var api = scanForApi(global);
    if (!api && global.opener) api = scanForApi(global.opener);
    return api;
  }

  var api = null;
  var initialized = false;

  var Scorm = {
    /** True when a real LMS API was found and initialized. */
    connected: false,

    init: function () {
      api = findApi();
      if (!api) {
        console.warn('[SCORM] No LMS API found — running in standalone mode.');
        return false;
      }
      var ok = api.LMSInitialize('') === 'true';
      initialized = ok;
      this.connected = ok;
      if (ok) {
        // Default status: if brand new attempt, mark incomplete.
        var status = this.get('cmi.core.lesson_status');
        if (status === 'not attempted' || status === '') {
          this.set('cmi.core.lesson_status', 'incomplete');
          this.commit();
        }
      }
      return ok;
    },

    get: function (key) {
      if (!initialized) return '';
      return api.LMSGetValue(key);
    },

    set: function (key, value) {
      if (!initialized) return false;
      return api.LMSSetValue(key, String(value)) === 'true';
    },

    commit: function () {
      if (!initialized) return false;
      return api.LMSCommit('') === 'true';
    },

    finish: function () {
      if (!initialized) return;
      api.LMSFinish('');
      initialized = false;
      this.connected = false;
    },
  };

  global.OpenMaicScorm = Scorm;
})(window);
`;

/** `js/player.js` — navigation, rendering, grading, SCORM reporting. */
export const PLAYER_JS = String.raw`/* OpenMAIC SCORM player */
(function () {
  'use strict';

  var scorm = window.OpenMaicScorm;
  var course = null;
  var current = 0;
  var visited = {};
  var quizState = {}; // sceneIndex -> { submitted, score, max }

  // ── Boot ──
  document.addEventListener('DOMContentLoaded', function () {
    scorm.init();
    fetch('data/course.json')
      .then(function (r) { return r.json(); })
      .then(function (data) {
        course = data;
        document.getElementById('course-title').textContent = data.course.title;
        document.title = data.course.title;
        buildRail();
        restoreLocation();
        render();
      })
      .catch(function (err) {
        document.getElementById('scene-root').innerHTML =
          '<p class="error">No se pudo cargar el curso: ' + err + '</p>';
      });
  });

  window.addEventListener('beforeunload', function () {
    persistLocation();
    scorm.finish();
  });

  // ── Resume ──
  function restoreLocation() {
    var loc = scorm.get('cmi.core.lesson_location');
    var idx = parseInt(loc, 10);
    if (!isNaN(idx) && idx >= 0 && course && idx < course.scenes.length) {
      current = idx;
    }
    var suspend = scorm.get('cmi.suspend_data');
    if (suspend) {
      try {
        var st = JSON.parse(suspend);
        if (st && st.visited) visited = st.visited;
        if (st && st.quizState) quizState = st.quizState;
      } catch (e) { /* corrupt suspend data — start fresh */ }
    }
  }

  function persistLocation() {
    scorm.set('cmi.core.lesson_location', String(current));
    scorm.set('cmi.suspend_data', JSON.stringify({ visited: visited, quizState: quizState }));
    scorm.commit();
  }

  // ── Progress rail ──
  function buildRail() {
    var rail = document.getElementById('rail');
    rail.innerHTML = '';
    course.scenes.forEach(function (scene, i) {
      var dot = document.createElement('button');
      dot.className = 'rail-dot';
      dot.title = (i + 1) + '. ' + scene.title;
      dot.addEventListener('click', function () { goTo(i); });
      rail.appendChild(dot);
    });
  }

  function updateRail() {
    var dots = document.querySelectorAll('.rail-dot');
    dots.forEach(function (dot, i) {
      dot.classList.toggle('active', i === current);
      dot.classList.toggle('visited', !!visited[i]);
    });
    document.getElementById('counter').textContent =
      (current + 1) + ' / ' + course.scenes.length;
    document.getElementById('btn-prev').disabled = current === 0;
    document.getElementById('btn-next').disabled = current === course.scenes.length - 1;
  }

  // ── Navigation ──
  function goTo(index) {
    if (index < 0 || index >= course.scenes.length) return;
    current = index;
    render();
    persistLocation();
  }

  document.addEventListener('click', function (e) {
    if (e.target.id === 'btn-prev' || e.target.closest('#btn-prev')) goTo(current - 1);
    if (e.target.id === 'btn-next' || e.target.closest('#btn-next')) goTo(current + 1);
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'ArrowLeft') goTo(current - 1);
    if (e.key === 'ArrowRight') goTo(current + 1);
  });

  // ── Rendering ──
  function render() {
    var scene = course.scenes[current];
    visited[current] = true;
    var root = document.getElementById('scene-root');
    root.innerHTML = '';
    document.getElementById('scene-title').textContent = scene.title;

    if (scene.kind === 'slide') renderSlide(root, scene);
    else if (scene.kind === 'quiz') renderQuiz(root, scene, current);
    else if (scene.kind === 'interactive') renderInteractive(root, scene);
    else if (scene.kind === 'pbl') renderPbl(root, scene);

    updateRail();
    maybeComplete();
  }

  function renderTranscript(root, scene) {
    if (!scene.transcript) return;
    var details = document.createElement('details');
    details.className = 'transcript';
    var summary = document.createElement('summary');
    summary.textContent = 'Transcripción';
    details.appendChild(summary);
    var p = document.createElement('p');
    p.textContent = scene.transcript;
    details.appendChild(p);
    root.appendChild(details);
  }

  function renderAudio(root, scene) {
    if (!scene.audioPaths || !scene.audioPaths.length) return;
    var wrap = document.createElement('div');
    wrap.className = 'audio-wrap';
    scene.audioPaths.forEach(function (path) {
      var audio = document.createElement('audio');
      audio.controls = true;
      audio.preload = 'none';
      audio.src = path;
      wrap.appendChild(audio);
    });
    root.appendChild(wrap);
  }

  function renderSlide(root, scene) {
    var frame = document.createElement('div');
    frame.className = 'slide-frame';
    var img = document.createElement('img');
    img.src = scene.imagePath;
    img.alt = scene.title;
    frame.appendChild(img);
    root.appendChild(frame);
    renderAudio(root, scene);
    renderTranscript(root, scene);
  }

  function renderInteractive(root, scene) {
    if (scene.htmlPath) {
      var iframe = document.createElement('iframe');
      iframe.className = 'interactive-frame';
      iframe.src = scene.htmlPath;
      iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms');
      root.appendChild(iframe);
    } else if (scene.url) {
      var p = document.createElement('p');
      p.className = 'external-note';
      p.textContent = 'Este contenido interactivo se encuentra en una página externa: ';
      var a = document.createElement('a');
      a.href = scene.url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = scene.url;
      p.appendChild(a);
      root.appendChild(p);
    } else {
      root.innerHTML = '<p class="external-note">Contenido interactivo no disponible sin conexión.</p>';
    }
    renderAudio(root, scene);
    renderTranscript(root, scene);
  }

  function renderPbl(root, scene) {
    var card = document.createElement('div');
    card.className = 'pbl-card';
    var h = document.createElement('h3');
    h.textContent = 'Proyecto (Aprendizaje Basado en Proyectos)';
    card.appendChild(h);
    var p = document.createElement('p');
    p.textContent = scene.summary || 'Actividad de proyecto guiada. Consulta con tu instructor los entregables.';
    card.appendChild(p);
    root.appendChild(card);
    renderTranscript(root, scene);
  }

  // ── Quiz ──
  function renderQuiz(root, scene, sceneIndex) {
    var form = document.createElement('form');
    form.className = 'quiz-form';
    var state = quizState[sceneIndex];

    scene.questions.forEach(function (q, qi) {
      var fieldset = document.createElement('fieldset');
      fieldset.className = 'quiz-question';
      var legend = document.createElement('legend');
      legend.textContent = (qi + 1) + '. ' + q.question;
      fieldset.appendChild(legend);

      if (q.type === 'short_answer') {
        var ta = document.createElement('textarea');
        ta.name = 'q_' + q.id;
        ta.rows = 3;
        if (state && state.answers && state.answers[q.id]) ta.value = state.answers[q.id].join('');
        if (state && state.submitted) ta.disabled = true;
        fieldset.appendChild(ta);
      } else {
        (q.options || []).forEach(function (opt) {
          var label = document.createElement('label');
          label.className = 'quiz-option';
          var input = document.createElement('input');
          input.type = q.type === 'multiple' ? 'checkbox' : 'radio';
          input.name = 'q_' + q.id;
          input.value = opt.value;
          if (state && state.answers && state.answers[q.id] &&
              state.answers[q.id].indexOf(opt.value) !== -1) {
            input.checked = true;
          }
          if (state && state.submitted) input.disabled = true;
          label.appendChild(input);
          label.appendChild(document.createTextNode(' ' + opt.value + '. ' + opt.label));
          fieldset.appendChild(label);
        });
      }

      if (state && state.submitted && q.analysis) {
        var analysis = document.createElement('p');
        analysis.className = 'quiz-analysis';
        analysis.textContent = q.analysis;
        fieldset.appendChild(analysis);
      }

      form.appendChild(fieldset);
    });

    if (!state || !state.submitted) {
      var submit = document.createElement('button');
      submit.type = 'submit';
      submit.className = 'btn-submit';
      submit.textContent = 'Enviar respuestas';
      form.appendChild(submit);
    } else {
      var result = document.createElement('p');
      result.className = 'quiz-result';
      result.textContent = 'Puntaje: ' + state.score + ' / ' + state.max +
        ' (' + Math.round((state.max ? state.score / state.max : 0) * 100) + '%)';
      form.appendChild(result);
    }

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      gradeQuiz(scene, sceneIndex, form);
    });

    root.appendChild(form);
  }

  function collectAnswers(scene, form) {
    var answers = {};
    scene.questions.forEach(function (q) {
      if (q.type === 'short_answer') {
        var ta = form.querySelector('[name="q_' + q.id + '"]');
        answers[q.id] = ta && ta.value ? [ta.value] : [];
      } else {
        var checked = form.querySelectorAll('[name="q_' + q.id + '"]:checked');
        answers[q.id] = Array.prototype.map.call(checked, function (i) { return i.value; });
      }
    });
    return answers;
  }

  function gradeQuiz(scene, sceneIndex, form) {
    var answers = collectAnswers(scene, form);
    var score = 0;
    var max = 0;

    scene.questions.forEach(function (q) {
      var points = q.points || 1;
      // Open questions without an answer key are participation-only.
      if (!q.answer || !q.answer.length) return;
      max += points;
      var given = (answers[q.id] || []).slice().sort().join('|');
      var expected = q.answer.slice().sort().join('|');
      if (given === expected) score += points;
    });

    quizState[sceneIndex] = { submitted: true, score: score, max: max, answers: answers };
    reportScore();
    persistLocation();
    render();
  }

  // ── SCORM reporting ──
  function totalQuizScore() {
    var score = 0;
    var max = 0;
    course.scenes.forEach(function (scene, i) {
      if (scene.kind !== 'quiz') return;
      var gradable = scene.questions.some(function (q) { return q.answer && q.answer.length; });
      if (!gradable) return;
      max += 1;
      var st = quizState[i];
      if (st && st.submitted && st.max > 0) score += st.score / st.max;
    });
    return max === 0 ? null : Math.round((score / max) * 100);
  }

  function allQuizzesSubmitted() {
    return course.scenes.every(function (scene, i) {
      if (scene.kind !== 'quiz') return true;
      var gradable = scene.questions.some(function (q) { return q.answer && q.answer.length; });
      if (!gradable) return true;
      return quizState[i] && quizState[i].submitted;
    });
  }

  function allScenesVisited() {
    return course.scenes.every(function (_s, i) { return !!visited[i]; });
  }

  function reportScore() {
    var pct = totalQuizScore();
    if (pct === null) return;
    scorm.set('cmi.core.score.raw', pct);
    scorm.set('cmi.core.score.min', 0);
    scorm.set('cmi.core.score.max', 100);
    scorm.commit();
  }

  function maybeComplete() {
    if (!allScenesVisited() || !allQuizzesSubmitted()) return;
    var pct = totalQuizScore();
    if (pct === null) {
      // No gradable quizzes: visiting everything completes the course.
      scorm.set('cmi.core.lesson_status', 'completed');
    } else {
      scorm.set(
        'cmi.core.lesson_status',
        pct >= course.masteryScore ? 'passed' : 'failed'
      );
    }
    scorm.commit();
  }
})();
`;

/** `css/player.css` — minimal, dependency-free styling. */
export const PLAYER_CSS = String.raw`:root {
  --bg: #0f1115;
  --panel: #181b22;
  --border: #2a2f3a;
  --text: #e6e8ee;
  --muted: #9aa3b2;
  --accent: #7c6cf0;
  --accent-soft: rgba(124, 108, 240, 0.18);
}

* { box-sizing: border-box; }

html, body {
  margin: 0;
  height: 100%;
  background: var(--bg);
  color: var(--text);
  font-family: 'Segoe UI', system-ui, -apple-system, sans-serif;
}

.app {
  display: flex;
  flex-direction: column;
  height: 100%;
}

header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 12px 20px;
  background: var(--panel);
  border-bottom: 1px solid var(--border);
}

header h1 {
  font-size: 15px;
  font-weight: 600;
  margin: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

#counter { color: var(--muted); font-size: 13px; white-space: nowrap; }

main {
  flex: 1;
  overflow: auto;
  padding: 20px;
  display: flex;
  flex-direction: column;
  align-items: center;
}

#scene-title {
  font-size: 18px;
  font-weight: 600;
  margin: 0 0 16px;
  align-self: flex-start;
  max-width: 960px;
  width: 100%;
  margin-left: auto;
  margin-right: auto;
}

#scene-root { width: 100%; max-width: 960px; margin: 0 auto; }

.slide-frame {
  background: #000;
  border: 1px solid var(--border);
  border-radius: 10px;
  overflow: hidden;
}

.slide-frame img { display: block; width: 100%; height: auto; }

.interactive-frame {
  width: 100%;
  height: 70vh;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: #fff;
}

.audio-wrap { margin-top: 12px; display: flex; flex-direction: column; gap: 8px; }
.audio-wrap audio { width: 100%; }

.transcript {
  margin-top: 12px;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 10px 14px;
  color: var(--muted);
  font-size: 14px;
  line-height: 1.6;
}
.transcript summary { cursor: pointer; color: var(--text); font-weight: 600; }

.pbl-card, .external-note {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 18px;
  line-height: 1.6;
}
.external-note a { color: var(--accent); }

.quiz-form { display: flex; flex-direction: column; gap: 16px; }

.quiz-question {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 14px 16px;
}
.quiz-question legend { font-weight: 600; padding: 0 6px; }

.quiz-option { display: block; padding: 6px 4px; cursor: pointer; }
.quiz-option:hover { background: var(--accent-soft); border-radius: 6px; }

.quiz-question textarea {
  width: 100%;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 8px;
  color: var(--text);
  padding: 8px;
  font: inherit;
}

.quiz-analysis {
  margin: 10px 0 0;
  padding: 8px 10px;
  border-left: 3px solid var(--accent);
  background: var(--accent-soft);
  border-radius: 0 8px 8px 0;
  font-size: 13px;
  color: var(--muted);
}

.btn-submit {
  align-self: flex-start;
  background: var(--accent);
  color: #fff;
  border: none;
  border-radius: 999px;
  padding: 10px 22px;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
}
.btn-submit:hover { filter: brightness(1.1); }

.quiz-result { font-size: 16px; font-weight: 700; }

footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 10px 20px;
  background: var(--panel);
  border-top: 1px solid var(--border);
}

.nav-btn {
  background: transparent;
  border: 1px solid var(--border);
  color: var(--text);
  border-radius: 999px;
  padding: 8px 18px;
  font-size: 14px;
  cursor: pointer;
}
.nav-btn:hover:not(:disabled) { border-color: var(--accent); color: var(--accent); }
.nav-btn:disabled { opacity: 0.35; cursor: not-allowed; }

#rail {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  justify-content: center;
  flex: 1;
}

.rail-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  border: 1px solid var(--border);
  background: transparent;
  cursor: pointer;
  padding: 0;
}
.rail-dot.visited { background: var(--muted); border-color: var(--muted); }
.rail-dot.active { background: var(--accent); border-color: var(--accent); transform: scale(1.3); }

.error { color: #ff6b6b; }
`;

/** `index.html` — SCO entry point loaded by the LMS. */
export const PLAYER_INDEX_HTML = String.raw`<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>OpenMAIC Course</title>
  <link rel="stylesheet" href="css/player.css" />
  <script src="js/scorm-api.js"></script>
  <script src="js/player.js"></script>
</head>
<body>
  <div class="app">
    <header>
      <h1 id="course-title">Cargando…</h1>
      <span id="counter"></span>
    </header>
    <main>
      <h2 id="scene-title"></h2>
      <div id="scene-root"></div>
    </main>
    <footer>
      <button id="btn-prev" class="nav-btn" type="button">← Anterior</button>
      <div id="rail"></div>
      <button id="btn-next" class="nav-btn" type="button">Siguiente →</button>
    </footer>
  </div>
</body>
</html>
`;

/** All static player files keyed by their ZIP-relative path. */
export const SCORM_PLAYER_FILES: Record<string, string> = {
  'index.html': PLAYER_INDEX_HTML,
  'css/player.css': PLAYER_CSS,
  'js/scorm-api.js': SCORM_API_JS,
  'js/player.js': PLAYER_JS,
};
