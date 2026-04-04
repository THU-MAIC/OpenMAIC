import type { Scene, QuizContent, QuizQuestion } from '@/lib/types/stage';

export interface QuizScoOptions {
  scene: Scene;
  sceneIndex: number;
  totalScenes: number;
  allScoHrefs: string[];
}

const PASS_THRESHOLD = 80;

function escHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderQuestion(q: QuizQuestion, idx: number): string {
  // short_answer questions are excluded from SCORM export
  if (q.type === 'short_answer' || !q.options?.length) return '';

  const inputType = q.type === 'multiple' ? 'checkbox' : 'radio';
  const typeLabel = q.type === 'multiple' ? ' <span class="q-multi-hint">(select all that apply)</span>' : '';

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

  return `
<div class="question-block" id="q_block_${escHtml(q.id)}"
     data-qid="${escHtml(q.id)}"
     data-type="${q.type}"
     data-answer="${escHtml((q.answer ?? []).join(','))}">
  <div class="question-text">
    <span class="q-num">${idx + 1}.</span> ${escHtml(q.question)}${typeLabel}
  </div>
  <div class="options-list">
    ${options}
  </div>
  ${analysis}
</div>`;
}

/**
 * Builds the full HTML string for a quiz SCO page.
 *
 * Only single and multiple choice questions are exported.
 * Short-answer questions are skipped.
 * SCORM scoring: score.raw = (correct / total) * 100, pass threshold = 80.
 */
export function buildQuizSco(opts: QuizScoOptions): string {
  const { scene, sceneIndex, totalScenes, allScoHrefs } = opts;

  if (scene.content.type !== 'quiz') return '';
  const content = scene.content as QuizContent;

  // Only exportable questions: single or multiple with options and answers
  const exportable = content.questions.filter(
    (q) => (q.type === 'single' || q.type === 'multiple') && q.options?.length && q.answer?.length,
  );

  const questionsHtml = exportable.map((q, i) => renderQuestion(q, i)).join('');

  const myHref = allScoHrefs[sceneIndex];
  const hasPrev = sceneIndex > 0;
  const hasNext = sceneIndex < totalScenes - 1;

  // Serialise question data for the JS runtime
  const questionsJson = JSON.stringify(
    exportable.map((q) => ({
      id: q.id,
      type: q.type,
      answer: q.answer ?? [],
    })),
  );

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escHtml(scene.title)}</title>
  <script src="../scorm_bridge.js"></script>
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    body { margin: 0; padding: 0; font-family: 'Segoe UI', Arial, sans-serif; background: #f5f5f7; color: #1d1d1f; min-height: 100vh; }
    .page-wrapper { max-width: 760px; margin: 0 auto; padding: 2rem 1.5rem 5rem; }
    h1 { font-size: 1.5rem; font-weight: 700; margin-bottom: 1.5rem; color: #1d1d1f; }
    .question-block { background: #fff; border-radius: 10px; padding: 1.25rem 1.5rem; margin-bottom: 1.25rem; box-shadow: 0 1px 4px rgba(0,0,0,0.08); }
    .question-text { font-size: 1rem; font-weight: 600; margin-bottom: 1rem; line-height: 1.5; }
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
    .option-label.correct  { border-color: #34c759; background: #f0faf3; }
    .option-label.incorrect { border-color: #ff3b30; background: #fff5f4; }
    .option-label.missed   { border-color: #34c759; background: #f0faf3; border-style: dashed; }
    .analysis { margin-top: 0.75rem; padding: 0.6rem 0.75rem; background: #f9f9fb; border-left: 3px solid #0071e3; font-size: 0.9rem; color: #444; border-radius: 0 4px 4px 0; display: none; }
    #result-bar { margin: 1rem 0; padding: 0.75rem 1rem; border-radius: 8px; font-weight: 600; font-size: 1rem; display: none; }
    #result-bar.pass { background: #f0faf3; color: #1a7f37; border: 1.5px solid #34c759; }
    #result-bar.fail { background: #fff5f4; color: #c0392b; border: 1.5px solid #ff3b30; }
    #submit-btn {
      display: block; width: 100%; padding: 0.8rem; margin: 1rem 0 0;
      background: #0071e3; color: #fff; border: none; border-radius: 8px;
      font-size: 1rem; font-weight: 600; cursor: pointer;
    }
    #submit-btn:hover:not(:disabled) { background: #0077ed; }
    #submit-btn:disabled { background: #b0c8e8; cursor: not-allowed; }
    .nav-bar { position: fixed; bottom: 0; left: 0; right: 0; background: #fff; border-top: 1px solid #e0e0e5; display: flex; align-items: center; justify-content: space-between; padding: 0.75rem 1.5rem; gap: 1rem; }
    .nav-bar button { background: #f5f5f7; border: 1.5px solid #d0d0d5; padding: 0.5rem 1.25rem; border-radius: 6px; cursor: pointer; font-size: 0.9rem; font-weight: 500; }
    .nav-bar button:hover { background: #e8e8ed; }
    .scene-counter { font-size: 0.85rem; color: #6e6e73; }
  </style>
</head>
<body>
<div class="page-wrapper">
  <h1>${escHtml(scene.title)}</h1>
  ${questionsHtml.trim() || '<p style="color:#6e6e73;">No gradable questions in this section.</p>'}
  <div id="result-bar"></div>
  <button id="submit-btn"${exportable.length === 0 ? ' disabled' : ''}>Submit</button>
</div>

<div class="nav-bar">
  ${hasPrev ? `<button onclick="SCORM.navigate(ALL_SCOS,'${myHref}','prev')">&#8592; Prev</button>` : '<span></span>'}
  <span class="scene-counter">${sceneIndex + 1} / ${totalScenes}</span>
  ${hasNext ? `<button id="next-btn" onclick="SCORM.navigate(ALL_SCOS,'${myHref}','next')">Next &#8594;</button>` : '<span></span>'}
</div>

<script>
var ALL_SCOS = ${JSON.stringify(allScoHrefs)};
var QUESTIONS = ${questionsJson};
var PASS_THRESHOLD = ${PASS_THRESHOLD};
var submitted = false;

window.addEventListener('load', function() {
  SCORM.init();
  SCORM.setValue('cmi.core.lesson_status', 'incomplete');
});
window.addEventListener('beforeunload', function() {
  if (!submitted) SCORM.finish();
});

document.getElementById('submit-btn').addEventListener('click', function() {
  if (submitted || QUESTIONS.length === 0) return;
  submitted = true;
  this.disabled = true;

  var correct = 0;

  QUESTIONS.forEach(function(q, interactionIdx) {
    var block = document.getElementById('q_block_' + q.id);
    var studentResponse = '';
    var isCorrect = false;

    if (q.type === 'single') {
      var sel = block.querySelector('input[type=radio]:checked');
      studentResponse = sel ? sel.value : '';
      isCorrect = studentResponse === q.answer[0];
    } else {
      var checked = Array.from(block.querySelectorAll('input[type=checkbox]:checked'))
                        .map(function(c) { return c.value; })
                        .sort();
      studentResponse = checked.join('[,]');
      var correctSorted = q.answer.slice().sort().join('[,]');
      isCorrect = studentResponse === correctSorted;
    }

    if (isCorrect) correct++;

    // Visual feedback on options
    var labels = block.querySelectorAll('.option-label');
    labels.forEach(function(label) {
      var input = label.querySelector('input');
      var val = input.value;
      var inAnswer = q.answer.indexOf(val) !== -1;
      var isSelected = input.checked;
      input.disabled = true;
      if (inAnswer && isSelected) label.classList.add('correct');
      else if (inAnswer && !isSelected) label.classList.add('missed');
      else if (!inAnswer && isSelected) label.classList.add('incorrect');
    });

    // Show analysis
    var analysis = document.getElementById('analysis_' + q.id);
    if (analysis) analysis.style.display = 'block';

    // Log SCORM interaction
    var correctPattern = q.type === 'single' ? q.answer[0] : q.answer.slice().sort().join('[,]');
    SCORM.logInteraction(interactionIdx, q.id, 'choice', studentResponse, correctPattern, isCorrect ? 'correct' : 'wrong');
  });

  // Score
  var pct = QUESTIONS.length > 0 ? Math.round((correct / QUESTIONS.length) * 100) : 0;
  SCORM.setScore(pct, 0, 100);

  var resultBar = document.getElementById('result-bar');
  resultBar.style.display = 'block';
  resultBar.textContent = 'Score: ' + correct + ' / ' + QUESTIONS.length + ' (' + pct + '%)';

  if (pct >= PASS_THRESHOLD) {
    SCORM.setPassed();
    resultBar.className = 'pass';
  } else {
    SCORM.setFailed();
    resultBar.className = 'fail';
    resultBar.textContent += ' — minimum passing score is ' + PASS_THRESHOLD + '%';
  }
});
</script>
</body>
</html>`;
}
