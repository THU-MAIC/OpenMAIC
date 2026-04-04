/**
 * quiz-sco.ts
 * Builds the HTML fragment (a <section> element) for a quiz scene.
 * Only single/multiple choice questions are exported (short_answer excluded).
 */
import type { Scene, QuizContent, QuizQuestion } from '@/lib/types/stage';

export const QUIZ_PASS_THRESHOLD = 80;

export interface QuizSceneMeta {
  type: 'quiz';
  sceneId: string;
  questionCount: number; // exportable questions count
}

export interface QuizSectionResult {
  html: string;
  meta: QuizSceneMeta;
}

function escHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderQuestion(q: QuizQuestion, idx: number): string {
  if (q.type === 'short_answer' || !q.options?.length) return '';
  const inputType = q.type === 'multiple' ? 'checkbox' : 'radio';
  const multiHint = q.type === 'multiple' ? ' <span class="q-multi-hint">(select all that apply)</span>' : '';

  const options = q.options
    .map(
      (opt) => `
      <label class="option-label" data-value="${escHtml(opt.value)}">
        <input type="${inputType}" name="q_${escHtml(q.id)}" value="${escHtml(opt.value)}">
        <span class="option-value">${escHtml(opt.value)}.</span>
        <span class="option-text">${escHtml(opt.label)}</span>
      </label>`,
    )
    .join('');

  const analysis = q.analysis
    ? `<div class="analysis" id="analysis_${escHtml(q.id)}">${escHtml(q.analysis)}</div>`
    : '';

  return `<div class="question-block" id="qblock_${escHtml(q.id)}"
     data-qid="${escHtml(q.id)}" data-type="${q.type}"
     data-answer="${escHtml((q.answer ?? []).join(','))}">
  <div class="question-text"><span class="q-num">${idx + 1}.</span> ${escHtml(q.question)}${multiHint}</div>
  <div class="options-list">${options}</div>
  ${analysis}
</div>`;
}

/**
 * Builds the HTML <section> fragment for a quiz scene.
 * Scoring is reported via the global onQuizSubmitted(sceneIdx, score) callback
 * defined in course-builder.ts.
 */
export function buildQuizSection(scene: Scene, sceneIndex: number): QuizSectionResult {
  const content = scene.content as QuizContent;
  const sceneId = `scene-${sceneIndex}`;

  const exportable = content.questions.filter(
    (q) => (q.type === 'single' || q.type === 'multiple') && q.options?.length && q.answer?.length,
  );

  const questionsHtml = exportable.map((q, i) => renderQuestion(q, i)).join('\n');

  // Serialize question data for inline JS
  const questionsJson = JSON.stringify(
    exportable.map((q) => ({ id: q.id, type: q.type, answer: q.answer ?? [] })),
  );

  const noQuestions = exportable.length === 0;

  const html = `<section id="${sceneId}" class="scene scene-quiz" data-title="${escHtml(scene.title)}" style="display:none">
  <div class="quiz-scroll">
    <h2 class="quiz-title">${escHtml(scene.title)}</h2>
    ${noQuestions
      ? '<p style="color:#6e6e73;">No gradable questions in this section.</p>'
      : questionsHtml
    }
    <div id="result_${sceneIndex}" class="result-bar" style="display:none"></div>
    <button id="submit_${sceneIndex}" class="submit-btn"${noQuestions ? ' disabled' : ''}>
      Submit
    </button>
  </div>
  <script>
  (function() {
    var QUESTIONS_${sceneIndex} = ${questionsJson};
    var submitted_${sceneIndex} = false;

    document.getElementById('submit_${sceneIndex}').addEventListener('click', function() {
      if (submitted_${sceneIndex} || QUESTIONS_${sceneIndex}.length === 0) return;
      submitted_${sceneIndex} = true;
      this.disabled = true;

      var correct = 0;
      QUESTIONS_${sceneIndex}.forEach(function(q, iIdx) {
        var block = document.getElementById('qblock_' + q.id);
        var studentResponse = '';
        var isCorrect = false;

        if (q.type === 'single') {
          var sel = block.querySelector('input[type=radio]:checked');
          studentResponse = sel ? sel.value : '';
          isCorrect = studentResponse === q.answer[0];
        } else {
          var checked = Array.from(block.querySelectorAll('input[type=checkbox]:checked'))
                            .map(function(c) { return c.value; }).sort();
          studentResponse = checked.join('[,]');
          isCorrect = studentResponse === q.answer.slice().sort().join('[,]');
        }

        if (isCorrect) correct++;

        // Visual feedback
        block.querySelectorAll('.option-label').forEach(function(label) {
          var input = label.querySelector('input');
          input.disabled = true;
          var inAnswer = q.answer.indexOf(input.value) !== -1;
          if (inAnswer && input.checked) label.classList.add('opt-correct');
          else if (inAnswer && !input.checked) label.classList.add('opt-missed');
          else if (!inAnswer && input.checked) label.classList.add('opt-incorrect');
        });

        var analysisEl = document.getElementById('analysis_' + q.id);
        if (analysisEl) analysisEl.style.display = 'block';

        // SCORM interaction
        var correctPattern = q.type === 'single' ? q.answer[0] : q.answer.slice().sort().join('[,]');
        if (typeof SCORM !== 'undefined') {
          SCORM.logInteraction(iIdx, q.id, 'choice', studentResponse, correctPattern, isCorrect ? 'correct' : 'wrong');
        }
      });

      var pct = QUESTIONS_${sceneIndex}.length > 0
        ? Math.round((correct / QUESTIONS_${sceneIndex}.length) * 100) : 0;

      var bar = document.getElementById('result_${sceneIndex}');
      bar.style.display = 'block';
      bar.textContent = 'Score: ' + correct + ' / ' + QUESTIONS_${sceneIndex}.length + ' (' + pct + '%)';
      bar.className = 'result-bar ' + (pct >= ${QUIZ_PASS_THRESHOLD} ? 'result-pass' : 'result-fail');

      // Notify course controller
      if (typeof window.onQuizSubmitted === 'function') {
        window.onQuizSubmitted(${sceneIndex}, pct);
      }
    });
  })();
  </script>
</section>`;

  return {
    html,
    meta: { type: 'quiz', sceneId, questionCount: exportable.length },
  };
}
