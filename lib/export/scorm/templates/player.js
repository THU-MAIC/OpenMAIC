/**
 * OpenMAIC offline SCORM player.
 *
 * Self-contained vanilla JS. Loads course.json + stages from content/,
 * renders slide/quiz/interactive scenes, plays pre-rendered audio, and
 * reports progress/grades to the LMS via ScormAPI.
 *
 * Simplifications vs. the live web app:
 * - Slide rendering is HTML-based (extracted text + images), not canvas
 * - Whiteboard animations not replayed — narration text is shown instead
 * - Multi-agent discussions and live AI features are disabled
 * - PBL scenes shown in read-only mode
 */
(function () {
  'use strict';

  var state = {
    course: null,
    stages: {}, // stageId -> { stage, scenes }
    currentModuleIdx: 0,
    currentLessonIdx: 0,
    currentSceneIdx: 0,
    visited: {}, // "modIdx:lessIdx:sceneIdx" -> true
    quizScores: {}, // "modIdx:lessIdx:sceneIdx" -> { raw, max }
    sessionStart: Date.now(),
    totalScore: 0,
    totalMax: 0,
  };

  function $(id) {
    return document.getElementById(id);
  }

  function escapeHtml(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ============ Bootstrapping ============

  async function loadJSON(path) {
    var res = await fetch(path);
    if (!res.ok) throw new Error('Failed to load ' + path);
    return res.json();
  }

  async function init() {
    try {
      state.course = await loadJSON('content/course.json');
      // Preload all stages
      var stageIds = [];
      state.course.modules.forEach(function (mod) {
        mod.stageIds.forEach(function (sid) {
          if (stageIds.indexOf(sid) === -1) stageIds.push(sid);
        });
      });
      await Promise.all(
        stageIds.map(async function (sid) {
          try {
            state.stages[sid] = await loadJSON('content/stages/' + sid + '.json');
          } catch (e) {
            console.error('Could not load stage', sid, e);
          }
        }),
      );

      // Init SCORM
      ScormAPI.init();
      restoreProgress();

      renderSidebar();
      renderCurrentScene();
      bindEvents();

      window.addEventListener('beforeunload', handleUnload);
    } catch (e) {
      $('scene-container').innerHTML =
        '<div class="readonly-notice">Error cargando el curso: ' + escapeHtml(e.message) + '</div>';
    }
  }

  function restoreProgress() {
    var loc = ScormAPI.getLocation();
    if (loc && typeof loc === 'string' && loc.indexOf(':') !== -1) {
      var parts = loc.split(':').map(Number);
      if (parts.length === 3 && !parts.some(isNaN)) {
        state.currentModuleIdx = parts[0];
        state.currentLessonIdx = parts[1];
        state.currentSceneIdx = parts[2];
      }
    }
    var suspend = ScormAPI.getSuspendData();
    if (suspend) {
      try {
        var data = JSON.parse(suspend);
        if (data.visited) state.visited = data.visited;
        if (data.quizScores) state.quizScores = data.quizScores;
      } catch (e) {
        /* ignore */
      }
    }
  }

  function persistProgress() {
    var loc = state.currentModuleIdx + ':' + state.currentLessonIdx + ':' + state.currentSceneIdx;
    ScormAPI.setLocation(loc);
    ScormAPI.setSuspendData({ visited: state.visited, quizScores: state.quizScores });
    ScormAPI.commit();
  }

  function handleUnload() {
    var elapsed = (Date.now() - state.sessionStart) / 1000;
    ScormAPI.setSessionTime(elapsed);
    persistProgress();
    ScormAPI.terminate();
  }

  // ============ Accessors ============

  function currentModule() {
    return state.course.modules[state.currentModuleIdx];
  }

  function currentLesson() {
    var mod = currentModule();
    if (!mod) return null;
    var stageId = mod.stageIds[state.currentLessonIdx];
    return state.stages[stageId];
  }

  function currentScene() {
    var lesson = currentLesson();
    if (!lesson || !lesson.scenes) return null;
    return lesson.scenes[state.currentSceneIdx];
  }

  function totalScenesInLesson() {
    var lesson = currentLesson();
    return lesson && lesson.scenes ? lesson.scenes.length : 0;
  }

  // ============ Rendering ============

  function renderSidebar() {
    var nav = $('module-nav');
    nav.innerHTML = '';
    state.course.modules.forEach(function (mod, mIdx) {
      var btn = document.createElement('button');
      btn.className = 'module-item' + (mIdx === state.currentModuleIdx ? ' active' : '');
      btn.textContent = mod.title || 'Módulo ' + (mIdx + 1);
      btn.onclick = function () {
        state.currentModuleIdx = mIdx;
        state.currentLessonIdx = 0;
        state.currentSceneIdx = 0;
        renderSidebar();
        renderCurrentScene();
      };
      nav.appendChild(btn);

      if (mIdx === state.currentModuleIdx) {
        mod.stageIds.forEach(function (sid, lIdx) {
          var lesson = state.stages[sid];
          if (!lesson) return;
          var lbtn = document.createElement('button');
          lbtn.className =
            'lesson-item' + (lIdx === state.currentLessonIdx ? ' active' : '');
          lbtn.textContent = (lesson.stage && lesson.stage.name) || 'Lección ' + (lIdx + 1);
          lbtn.onclick = function () {
            state.currentLessonIdx = lIdx;
            state.currentSceneIdx = 0;
            renderSidebar();
            renderCurrentScene();
          };
          nav.appendChild(lbtn);
        });
      }
    });

    var summary = $('progress-summary');
    var visitedCount = Object.keys(state.visited).length;
    summary.textContent = 'Escenas visitadas: ' + visitedCount;
  }

  function renderCurrentScene() {
    var scene = currentScene();
    var container = $('scene-container');
    if (!scene) {
      container.innerHTML = '<div class="readonly-notice">No hay escenas disponibles.</div>';
      renderNavBar();
      return;
    }

    var key = state.currentModuleIdx + ':' + state.currentLessonIdx + ':' + state.currentSceneIdx;
    state.visited[key] = true;

    switch (scene.type) {
      case 'slide':
        container.innerHTML = renderSlide(scene);
        attachAudioHandlers(scene);
        break;
      case 'quiz':
        container.innerHTML = renderQuiz(scene);
        attachQuizHandlers(scene);
        break;
      case 'interactive':
        container.innerHTML = renderInteractive(scene);
        break;
      case 'pbl':
        container.innerHTML = renderPBL(scene);
        break;
      default:
        container.innerHTML =
          '<div class="readonly-notice">Tipo de escena no soportado: ' +
          escapeHtml(scene.type) +
          '</div>';
    }

    renderNavBar();
    persistProgress();
  }

  function renderSlide(scene) {
    var html = '<div class="scene"><h2>' + escapeHtml(scene.title || 'Diapositiva') + '</h2>';
    html += '<div class="scene-slide-content">';

    // Try to extract text/image elements from canvas structure
    var slideData = scene.content && scene.content.canvas;
    if (slideData && Array.isArray(slideData.elements)) {
      slideData.elements.forEach(function (el) {
        if (el.type === 'text' && el.content) {
          html += '<div>' + el.content + '</div>';
        } else if (el.type === 'image' && el.src) {
          html += '<img src="' + escapeHtml(el.src) + '" alt="" />';
        }
      });
    }

    html += '</div>';

    // Speech narration
    var speechActions = (scene.actions || []).filter(function (a) {
      return a.type === 'speech';
    });
    speechActions.forEach(function (sa, idx) {
      html += '<div class="narration"><strong>🎙️ Narración:</strong><br>' + escapeHtml(sa.text) + '</div>';
      if (sa.audioUrl) {
        html +=
          '<div class="audio-controls">' +
          '<audio id="audio-' +
          idx +
          '" src="' +
          escapeHtml(sa.audioUrl) +
          '" preload="metadata"></audio>' +
          '<button type="button" data-audio="' +
          idx +
          '">▶ Reproducir</button>' +
          '</div>';
      }
    });

    // Whiteboard actions — summarize as text since we don't replay animation
    var wbActions = (scene.actions || []).filter(function (a) {
      return a.type && a.type.indexOf('wb_') === 0;
    });
    if (wbActions.length > 0) {
      html +=
        '<div class="readonly-notice">Esta escena incluye ' +
        wbActions.length +
        ' acciones de pizarra que se reproducen en la versión online.</div>';
    }

    html += '</div>';
    return html;
  }

  function attachAudioHandlers(_scene) {
    var buttons = document.querySelectorAll('.audio-controls button[data-audio]');
    buttons.forEach(function (btn) {
      btn.onclick = function () {
        var id = btn.getAttribute('data-audio');
        var audio = document.getElementById('audio-' + id);
        if (audio.paused) {
          audio.play();
          btn.textContent = '⏸ Pausar';
        } else {
          audio.pause();
          btn.textContent = '▶ Reproducir';
        }
        audio.onended = function () {
          btn.textContent = '▶ Reproducir';
        };
      };
    });
  }

  function renderQuiz(scene) {
    var key = state.currentModuleIdx + ':' + state.currentLessonIdx + ':' + state.currentSceneIdx;
    var existing = state.quizScores[key];

    var html =
      '<div class="scene quiz"><h2>' + escapeHtml(scene.title || 'Cuestionario') + '</h2>';

    var questions = (scene.content && scene.content.questions) || [];
    questions.forEach(function (q, qIdx) {
      html += '<div class="quiz-question" data-q="' + qIdx + '">';
      html += '<div class="q-text">' + (qIdx + 1) + '. ' + escapeHtml(q.question) + '</div>';

      if (q.type === 'single' || q.type === 'multiple') {
        (q.options || []).forEach(function (opt) {
          var inputType = q.type === 'single' ? 'radio' : 'checkbox';
          html +=
            '<label class="quiz-option">' +
            '<input type="' +
            inputType +
            '" name="q' +
            qIdx +
            '" value="' +
            escapeHtml(opt.value) +
            '" ' +
            (existing ? 'disabled' : '') +
            ' /> ' +
            escapeHtml(opt.value) +
            '. ' +
            escapeHtml(opt.label) +
            '</label>';
        });
      } else if (q.type === 'short_answer') {
        html +=
          '<textarea name="q' + qIdx + '" ' + (existing ? 'disabled' : '') + '></textarea>';
      }

      html += '</div>';
    });

    if (existing) {
      html +=
        '<div class="quiz-result">Nota: ' +
        existing.raw +
        ' / ' +
        existing.max +
        ' (' +
        Math.round((existing.raw / existing.max) * 100) +
        '%)</div>';
    } else {
      html += '<button class="quiz-submit" type="button">Enviar respuestas</button>';
    }
    html += '</div>';
    return html;
  }

  function attachQuizHandlers(scene) {
    var btn = document.querySelector('.quiz-submit');
    if (!btn) return;

    btn.onclick = function () {
      var questions = (scene.content && scene.content.questions) || [];
      var totalRaw = 0;
      var totalMax = 0;

      questions.forEach(function (q, qIdx) {
        var points = q.points || 1;
        totalMax += points;
        var correct = false;

        if (q.type === 'single') {
          var selected = document.querySelector('input[name="q' + qIdx + '"]:checked');
          if (selected && q.answer && q.answer.indexOf(selected.value) !== -1) correct = true;
        } else if (q.type === 'multiple') {
          var chosen = Array.prototype.slice
            .call(document.querySelectorAll('input[name="q' + qIdx + '"]:checked'))
            .map(function (i) {
              return i.value;
            })
            .sort();
          var expected = (q.answer || []).slice().sort();
          correct = chosen.length === expected.length && chosen.every(function (v, i) {
            return v === expected[i];
          });
        } else if (q.type === 'short_answer') {
          // Text questions cannot be auto-graded offline — give full credit for any response
          var ta = document.querySelector('textarea[name="q' + qIdx + '"]');
          correct = !!(ta && ta.value.trim().length > 0);
        }

        if (correct) totalRaw += points;

        // Visual feedback on options
        var qDiv = document.querySelector('.quiz-question[data-q="' + qIdx + '"]');
        if (qDiv && (q.type === 'single' || q.type === 'multiple')) {
          var labels = qDiv.querySelectorAll('.quiz-option');
          labels.forEach(function (lbl) {
            var inp = lbl.querySelector('input');
            if (!inp) return;
            inp.disabled = true;
            if (q.answer && q.answer.indexOf(inp.value) !== -1) {
              lbl.classList.add('correct');
            } else if (inp.checked) {
              lbl.classList.add('incorrect');
            }
          });
          if (q.analysis) {
            var fb = document.createElement('div');
            fb.className = 'question-feedback';
            fb.textContent = q.analysis;
            qDiv.appendChild(fb);
          }
        }
      });

      // Record score
      var key = state.currentModuleIdx + ':' + state.currentLessonIdx + ':' + state.currentSceneIdx;
      state.quizScores[key] = { raw: totalRaw, max: totalMax };

      // Aggregate totals
      recalculateTotals();

      // Report to SCORM
      ScormAPI.setScore(state.totalScore, state.totalMax, 0);
      var passed = state.totalMax > 0 && state.totalScore / state.totalMax >= 0.5;
      ScormAPI.setSuccess(passed ? 'passed' : 'failed');

      persistProgress();
      renderCurrentScene();
    };
  }

  function recalculateTotals() {
    state.totalScore = 0;
    state.totalMax = 0;
    for (var k in state.quizScores) {
      if (Object.prototype.hasOwnProperty.call(state.quizScores, k)) {
        state.totalScore += state.quizScores[k].raw;
        state.totalMax += state.quizScores[k].max;
      }
    }
  }

  function renderInteractive(scene) {
    var html = '<div class="scene"><h2>' + escapeHtml(scene.title || 'Interactivo') + '</h2>';
    var content = scene.content || {};
    if (content.html) {
      html += '<iframe class="interactive-frame" srcdoc="' + escapeHtml(content.html) + '"></iframe>';
    } else if (content.url) {
      html += '<iframe class="interactive-frame" src="' + escapeHtml(content.url) + '"></iframe>';
    } else {
      html += '<div class="readonly-notice">Contenido interactivo no disponible offline.</div>';
    }
    html += '</div>';
    return html;
  }

  function renderPBL(scene) {
    var html = '<div class="scene"><h2>' + escapeHtml(scene.title || 'Proyecto') + '</h2>';
    html +=
      '<div class="readonly-notice">Las actividades PBL requieren la versión online para interactuar con los agentes de IA. Aquí puedes consultar el enunciado.</div>';
    var cfg = scene.content && scene.content.projectConfig;
    if (cfg) {
      if (cfg.description) {
        html += '<div class="narration">' + escapeHtml(cfg.description) + '</div>';
      }
      if (cfg.roles && cfg.roles.length) {
        html += '<h3>Roles</h3><ul>';
        cfg.roles.forEach(function (r) {
          html += '<li>' + escapeHtml(r.name || '') + ' — ' + escapeHtml(r.description || '') + '</li>';
        });
        html += '</ul>';
      }
    }
    html += '</div>';
    return html;
  }

  function renderNavBar() {
    var dots = $('scene-dots');
    dots.innerHTML = '';
    var total = totalScenesInLesson();
    for (var i = 0; i < total; i++) {
      var d = document.createElement('button');
      d.className = 'scene-dot';
      if (i === state.currentSceneIdx) d.className += ' current';
      else {
        var key = state.currentModuleIdx + ':' + state.currentLessonIdx + ':' + i;
        if (state.visited[key]) d.className += ' visited';
      }
      (function (idx) {
        d.onclick = function () {
          state.currentSceneIdx = idx;
          renderCurrentScene();
        };
      })(i);
      dots.appendChild(d);
    }

    $('prev-btn').disabled = state.currentSceneIdx === 0 && state.currentLessonIdx === 0;
    var isLastScene = state.currentSceneIdx >= total - 1;
    var mod = currentModule();
    var isLastLesson = mod && state.currentLessonIdx >= mod.stageIds.length - 1;
    var isLastModule = state.currentModuleIdx >= state.course.modules.length - 1;
    $('next-btn').disabled = isLastScene && isLastLesson && isLastModule;
  }

  function goNext() {
    var total = totalScenesInLesson();
    if (state.currentSceneIdx < total - 1) {
      state.currentSceneIdx++;
    } else {
      var mod = currentModule();
      if (mod && state.currentLessonIdx < mod.stageIds.length - 1) {
        state.currentLessonIdx++;
        state.currentSceneIdx = 0;
      } else if (state.currentModuleIdx < state.course.modules.length - 1) {
        state.currentModuleIdx++;
        state.currentLessonIdx = 0;
        state.currentSceneIdx = 0;
      } else {
        // End of course
        ScormAPI.setCompletion('completed');
        persistProgress();
        return;
      }
    }
    renderSidebar();
    renderCurrentScene();
  }

  function goPrev() {
    if (state.currentSceneIdx > 0) {
      state.currentSceneIdx--;
    } else if (state.currentLessonIdx > 0) {
      state.currentLessonIdx--;
      state.currentSceneIdx = Math.max(0, totalScenesInLesson() - 1);
    } else if (state.currentModuleIdx > 0) {
      state.currentModuleIdx--;
      var mod = currentModule();
      state.currentLessonIdx = mod.stageIds.length - 1;
      state.currentSceneIdx = Math.max(0, totalScenesInLesson() - 1);
    } else {
      return;
    }
    renderSidebar();
    renderCurrentScene();
  }

  function bindEvents() {
    $('next-btn').onclick = goNext;
    $('prev-btn').onclick = goPrev;
    document.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowRight') goNext();
      else if (e.key === 'ArrowLeft') goPrev();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
