import { memo, useMemo, useState } from 'react';
import { CheckCircle2, RotateCcw, XCircle } from 'lucide-react';
import type { QuizQuestion } from '@openmaic/dsl';
import {
  answerIncludesOption,
  gradeChoiceQuestions,
  isShortAnswer,
  resolveAnswerKeyToValue,
  toArray,
} from '@/lib/quiz/grading';
import { renderQuizMathText } from '@/lib/quiz/math-text';
import type { StandalonePlayerStrings } from '@/lib/export/standalone-html/contract';

type Answers = Record<string, string | string[]>;

const MathText = memo(function MathText({ text }: { text: string }) {
  const segments = useMemo(() => renderQuizMathText(text), [text]);
  return (
    <>
      {segments.map((segment, index) =>
        segment.type === 'text' ? (
          <span key={index}>{segment.value}</span>
        ) : (
          <span
            key={index}
            className={segment.displayMode ? 'my-1 block overflow-x-auto' : 'inline-block'}
            // KaTeX output of the exported question text, rendered exactly as
            // the classroom's quiz view does.
            dangerouslySetInnerHTML={{ __html: segment.html }}
          />
        ),
      )}
    </>
  );
});

function ChoiceQuestion({
  question,
  value,
  submitted,
  onChange,
  strings,
}: {
  question: QuizQuestion;
  value: string[];
  submitted: boolean;
  onChange: (next: string[]) => void;
  strings: StandalonePlayerStrings;
}) {
  const multiple = question.type === 'multiple';
  return (
    <div className="space-y-2">
      {multiple && !submitted && (
        <p className="text-xs text-slate-500">{strings.quizMultipleHint}</p>
      )}
      {(question.options ?? []).map((option) => {
        const selected = value.includes(option.value);
        const correct = submitted && answerIncludesOption(question, option.value);
        const wrong = submitted && selected && !correct;
        return (
          <label
            key={option.value}
            className={`flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-2.5 text-sm transition-colors ${
              correct
                ? 'border-emerald-400 bg-emerald-50'
                : wrong
                  ? 'border-rose-400 bg-rose-50'
                  : selected
                    ? 'border-violet-400 bg-violet-50'
                    : 'border-slate-200 bg-white hover:border-slate-300'
            } ${submitted ? 'cursor-default' : ''}`}
          >
            <input
              type={multiple ? 'checkbox' : 'radio'}
              name={question.id}
              value={option.value}
              checked={selected}
              disabled={submitted}
              onChange={() =>
                onChange(
                  multiple
                    ? selected
                      ? value.filter((v) => v !== option.value)
                      : [...value, option.value]
                    : [option.value],
                )
              }
              className="mt-0.5 accent-violet-600"
            />
            <span className="w-5 shrink-0 font-semibold text-slate-500">{option.value}.</span>
            <span className="min-w-0 flex-1">
              <MathText text={option.label} />
            </span>
          </label>
        );
      })}
    </div>
  );
}

export function QuizScene({
  questions,
  strings,
}: {
  questions: QuizQuestion[];
  strings: StandalonePlayerStrings;
}) {
  const [answers, setAnswers] = useState<Answers>({});
  const [submitted, setSubmitted] = useState(false);

  const results = useMemo(
    () => (submitted ? gradeChoiceQuestions(questions, answers) : []),
    [submitted, questions, answers],
  );
  const resultById = new Map(results.map((result) => [result.questionId, result]));
  const earned = results.reduce((sum, result) => sum + result.earned, 0);
  const possible = questions
    .filter((question) => !isShortAnswer(question))
    .reduce((sum, question) => sum + (question.points ?? 1), 0);

  return (
    <div className="absolute inset-0 overflow-y-auto">
      <div className="mx-auto max-w-3xl space-y-4 px-4 py-6" data-testid="quiz">
        {questions.map((question, index) => {
          const result = resultById.get(question.id);
          const shortAnswer = isShortAnswer(question);
          // Open-ended questions are not graded offline. Their reference is
          // the stored answer key, or else the explanation, which then is not
          // repeated below it.
          const answerKey = toArray(question.answer).join('; ');
          const reference = shortAnswer ? answerKey || question.analysis : undefined;
          const explanation = reference === question.analysis ? undefined : question.analysis;
          return (
            <section
              key={question.id || index}
              className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm"
              data-testid="quiz-question"
            >
              <div className="mb-3 flex items-start gap-3">
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-violet-100 text-xs font-semibold text-violet-700">
                  {index + 1}
                </span>
                <div className="min-w-0 flex-1 text-[15px] font-medium leading-relaxed">
                  <MathText text={question.question} />
                </div>
                {result && (
                  <span
                    className={`inline-flex shrink-0 items-center gap-1 text-xs font-semibold ${
                      result.correct ? 'text-emerald-600' : 'text-rose-600'
                    }`}
                    data-testid="quiz-verdict"
                  >
                    {result.correct ? (
                      <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
                    ) : (
                      <XCircle className="h-4 w-4" aria-hidden="true" />
                    )}
                    {result.correct ? strings.quizCorrect : strings.quizIncorrect}
                  </span>
                )}
              </div>

              {shortAnswer ? (
                <textarea
                  value={typeof answers[question.id] === 'string' ? answers[question.id] : ''}
                  onChange={(event) =>
                    setAnswers((prev) => ({ ...prev, [question.id]: event.target.value }))
                  }
                  readOnly={submitted}
                  rows={4}
                  placeholder={strings.quizAnswerPlaceholder}
                  className="w-full resize-y rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-violet-400 focus:ring-2 focus:ring-violet-100"
                />
              ) : (
                <ChoiceQuestion
                  question={question}
                  value={toArray(answers[question.id])}
                  submitted={submitted}
                  onChange={(next) => setAnswers((prev) => ({ ...prev, [question.id]: next }))}
                  strings={strings}
                />
              )}

              {submitted && (
                <div className="mt-4 space-y-2 rounded-lg bg-slate-50 p-3 text-sm leading-relaxed">
                  {shortAnswer && (
                    <p data-testid="quiz-reference">
                      <span className="font-semibold">{strings.quizReferenceAnswer}: </span>
                      {reference ? (
                        <MathText text={reference} />
                      ) : (
                        <span className="text-slate-500">{strings.quizNoReferenceAnswer}</span>
                      )}
                    </p>
                  )}
                  {!shortAnswer && result && !result.correct && answerKey && (
                    <p>
                      <span className="font-semibold">{strings.quizCorrectAnswer}: </span>
                      {toArray(question.answer)
                        .map((key) => resolveAnswerKeyToValue(question, key))
                        .join(', ')}
                    </p>
                  )}
                  {explanation && (
                    <p>
                      <span className="font-semibold">{strings.quizExplanation}: </span>
                      <MathText text={explanation} />
                    </p>
                  )}
                </div>
              )}
            </section>
          );
        })}

        <div className="flex items-center justify-between gap-4 pb-4">
          {submitted && possible > 0 ? (
            <span className="text-sm font-semibold text-slate-700" data-testid="quiz-score">
              {strings.quizScore}: {earned} / {possible}
            </span>
          ) : (
            <span />
          )}
          {submitted ? (
            <button
              type="button"
              onClick={() => {
                setAnswers({});
                setSubmitted(false);
              }}
              className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              <RotateCcw className="h-4 w-4" aria-hidden="true" />
              {strings.quizRetry}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setSubmitted(true)}
              className="rounded-md bg-violet-600 px-5 py-2 text-sm font-medium text-white hover:bg-violet-700"
              data-testid="quiz-submit"
            >
              {strings.quizSubmit}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
