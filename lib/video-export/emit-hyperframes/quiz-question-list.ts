/** Shared deterministic markup/CSS for Quiz measurement and final emission. */
import type { QuizQuestionListQuestion, QuizQuestionListVisual } from '../ir';
import { renderQuizMathText } from '../../quiz/math-text';
import { escapeHtml } from './format';

export interface QuizQuestionListLabels {
  singleChoice: string;
  multipleChoice: string;
  shortAnswer: string;
  answerPlaceholder: string;
}

export interface QuizQuestionListContent {
  title: string;
  questions: QuizQuestionListQuestion[];
}

function mathText(value: string, allowDisplayMode = false): string {
  return renderQuizMathText(value)
    .map((segment) => {
      if (segment.type === 'text') return escapeHtml(segment.value);
      const className =
        allowDisplayMode && segment.displayMode
          ? 'quiz-list-math quiz-list-math-display'
          : 'quiz-list-math';
      return `<span class="${className}">${segment.html}</span>`;
    })
    .join('');
}

function typeLabel(question: QuizQuestionListQuestion, labels: QuizQuestionListLabels): string {
  if (question.type === 'single') return labels.singleChoice;
  if (question.type === 'multiple') return labels.multipleChoice;
  return labels.shortAnswer;
}

function renderChoiceOptions(question: QuizQuestionListQuestion): string {
  return (question.options ?? [])
    .map(
      (option) =>
        `<div class="quiz-list-option"><span class="quiz-list-option-control" aria-hidden="true"></span><span class="quiz-list-option-key">${escapeHtml(option.value)}</span><span class="quiz-list-option-label" dir="auto">${mathText(option.label)}</span></div>`,
    )
    .join('\n');
}

function renderQuestion(
  question: QuizQuestionListQuestion,
  index: number,
  labels: QuizQuestionListLabels,
): string {
  const body =
    question.type === 'short_answer'
      ? `<div class="quiz-list-answer-box"><span>${escapeHtml(labels.answerPlaceholder)}</span></div>`
      : `<div class="quiz-list-options">${renderChoiceOptions(question)}</div>`;
  return [
    `<article class="quiz-list-question" data-question-type="${question.type}">`,
    `  <div class="quiz-list-question-header">`,
    `    <span class="quiz-list-number">${index + 1}</span>`,
    `    <div class="quiz-list-question-copy">`,
    `      <div class="quiz-list-prompt" dir="auto">${mathText(question.question, true)}</div>`,
    `      <div class="quiz-list-type">${escapeHtml(typeLabel(question, labels))}</div>`,
    `    </div>`,
    `  </div>`,
    `  ${body}`,
    `</article>`,
  ].join('\n');
}

/** Markup used verbatim by the app-side measurement surface and emitted clip. */
export function renderQuizQuestionListSurface(
  content: QuizQuestionListContent | QuizQuestionListVisual,
  labels: QuizQuestionListLabels,
  direction: 'ltr' | 'rtl',
  contentId?: string,
): string {
  return [
    `<div class="quiz-list-shell" dir="${direction}">`,
    `  <header class="quiz-list-header"><span class="quiz-list-header-icon">?</span><h1 dir="auto">${escapeHtml(content.title)}</h1></header>`,
    `  <div class="quiz-list-viewport">`,
    `    <div${contentId ? ` id="${escapeHtml(contentId)}"` : ''} class="quiz-list-content">`,
    content.questions.map((question, index) => renderQuestion(question, index, labels)).join('\n'),
    `    </div>`,
    `  </div>`,
    `</div>`,
  ].join('\n');
}

/** Resolution-scaled final CSS shared with the off-screen measurement surface. */
export function quizQuestionListCss(width: number): string {
  const scale = width / 1280;
  const px = (value: number): string => `${Math.max(1, Math.round(value * scale))}px`;
  return [
    `.quiz-question-list { padding:5.2%;background:linear-gradient(145deg,#071426 0%,#102a43 56%,#133f4b 100%);font-family:Inter,"OpenMAIC Noto Sans SC","OpenMAIC Noto Sans KR",sans-serif; }`,
    `.quiz-question-list * { overflow-wrap:anywhere; }`,
    `.quiz-list-shell { display:flex;width:min(88%,${px(1040)});height:100%;min-height:0;flex-direction:column;padding:${px(28)} ${px(34)};overflow:hidden;border:${px(1)} solid rgba(255,255,255,.13);border-radius:${px(28)};background:rgba(11,18,33,.9);box-shadow:0 ${px(30)} ${px(80)} rgba(0,0,0,.42);color:#f8fafc; }`,
    `.quiz-list-header { display:flex;flex:0 0 auto;align-items:center;gap:${px(12)};margin-bottom:${px(20)}; }`,
    `.quiz-list-header-icon { display:grid;width:${px(34)};height:${px(34)};flex:0 0 auto;place-items:center;border:${px(1)} solid rgba(111,220,255,.26);border-radius:999px;background:rgba(86,197,234,.14);color:#8fdcf5;font-size:${px(17)};font-weight:800; }`,
    `.quiz-list-header h1 { min-width:0;margin:0;overflow:hidden;color:#f8fafc;font-size:${px(28)};line-height:1.15;text-overflow:ellipsis;white-space:nowrap; }`,
    `.quiz-list-viewport { min-height:0;flex:1 1 auto;overflow:hidden; }`,
    `.quiz-list-content { display:flex;flex-direction:column;gap:${px(16)};will-change:transform; }`,
    `.quiz-list-question { position:relative;flex:0 0 auto;padding:${px(18)} ${px(20)};overflow:hidden;border:${px(1)} solid rgba(255,255,255,.12);border-radius:${px(18)};background:rgba(255,255,255,.07);box-shadow:0 ${px(10)} ${px(28)} rgba(0,0,0,.15); }`,
    `.quiz-list-question::before { position:absolute;inset:0 auto 0 0;width:${px(4)};background:#8b5cf6;content:""; }`,
    `.quiz-list-question-header { display:flex;align-items:flex-start;gap:${px(12)}; }`,
    `.quiz-list-number { display:grid;width:${px(28)};height:${px(28)};flex:0 0 auto;place-items:center;border-radius:${px(8)};background:rgba(167,139,250,.2);color:#c4b5fd;font-size:${px(12)};font-weight:800; }`,
    `.quiz-list-question-copy { min-width:0;flex:1 1 auto; }`,
    `.quiz-list-prompt { color:#f8fafc;font-size:${px(17)};font-weight:650;line-height:1.5;overflow-wrap:anywhere; }`,
    `.quiz-list-type { margin-top:${px(4)};color:#94a3b8;font-size:${px(11)};font-weight:650;letter-spacing:.04em;text-transform:uppercase; }`,
    `.quiz-list-options { display:grid;gap:${px(8)};margin-top:${px(14)}; }`,
    `.quiz-list-option { display:flex;align-items:flex-start;gap:${px(9)};padding:${px(10)} ${px(12)};border:${px(1)} solid rgba(255,255,255,.09);border-radius:${px(11)};background:rgba(2,6,23,.3);color:#e2e8f0;font-size:${px(14)};line-height:1.4; }`,
    `.quiz-list-option-control { width:${px(14)};height:${px(14)};flex:0 0 auto;margin-top:${px(2)};border:${px(2)} solid #64748b;border-radius:999px; }`,
    `.quiz-list-question[data-question-type="multiple"] .quiz-list-option-control { border-radius:${px(3)}; }`,
    `.quiz-list-option-key { flex:0 0 auto;color:#a78bfa;font-weight:800; }`,
    `.quiz-list-option-label { min-width:0;overflow-wrap:anywhere; }`,
    `.quiz-list-answer-box { min-height:${px(70)};margin-top:${px(14)};padding:${px(12)};border:${px(1)} dashed #64748b;border-radius:${px(11)};background:rgba(2,6,23,.24);color:#64748b;font-size:${px(13)}; }`,
    `.quiz-list-math { display:inline-block;vertical-align:baseline; }`,
    `.quiz-list-math-display { display:block;margin:${px(4)} 0;overflow:visible; }`,
    `.quiz-list-math .katex-display { margin:0; }`,
  ].join('\n');
}
