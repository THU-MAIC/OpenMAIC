export interface QuizQuestion {
  answer: number;
}

export interface QuizJudgement {
  ok: boolean;
  score: number;
  total: number;
  wrong: number[];
  feedback?: string;
}

export function judgeQuiz(
  questions: readonly QuizQuestion[],
  answers: readonly number[],
): QuizJudgement {
  const wrong: number[] = [];
  questions.forEach((question, index) => {
    if (answers[index] !== question.answer) wrong.push(index);
  });
  const total = questions.length;
  const score = total - wrong.length;
  const ok = total > 0 && wrong.length === 0;
  return {
    ok,
    score,
    total,
    wrong,
    ...(ok || total === 0
      ? {}
      : { feedback: `第 ${wrong.map((index) => index + 1).join('、')} 题未答对` }),
  };
}
