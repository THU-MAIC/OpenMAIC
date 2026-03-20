import type { CodeReviewResult, CodingProblem, PlacementQuestion } from './types';

export function scorePlacementQuiz(
  questions: PlacementQuestion[],
  answers: Record<string, string>,
) {
  const total = questions.length;
  let score = 0;
  const weakAreas = new Set<string>();
  for (const question of questions) {
    if (answers[question.id] === question.correctAnswer) {
      score += 1;
    } else {
      weakAreas.add(question.topic);
    }
  }
  return {
    score,
    total,
    percentage: total ? Math.round((score / total) * 100) : 0,
    weakAreas: Array.from(weakAreas),
  };
}

export function estimatePercentile(percentage: number) {
  if (percentage >= 90) return '90-95 percentile';
  if (percentage >= 80) return '75-85 percentile';
  if (percentage >= 70) return '60-70 percentile';
  if (percentage >= 60) return '45-55 percentile';
  return 'Below 40 percentile';
}

export function scoreCodingQuiz(
  problems: CodingProblem[],
  reviews: Array<{ id: string; review: CodeReviewResult }>,
) {
  const reviewMap = new Map(reviews.map((item) => [item.id, item.review]));
  const total = problems.length;
  let score = 0;
  let totalReviewScore = 0;
  const weakAreas = new Set<string>();

  for (const problem of problems) {
    const review = reviewMap.get(problem.id);
    const reviewScore = Math.max(0, Math.min(100, review?.score ?? 0));
    totalReviewScore += reviewScore;

    if (reviewScore >= 80) {
      score += 1;
    } else if (reviewScore >= 60) {
      score += 0.5;
      weakAreas.add(problem.topic);
    } else {
      weakAreas.add(problem.topic);
    }
  }

  const roundedScore = Math.round(score * 10) / 10;
  const averageReviewScore = total ? Math.round(totalReviewScore / total) : 0;

  return {
    score: roundedScore,
    total,
    percentage: total ? Math.round((roundedScore / total) * 100) : 0,
    averageReviewScore,
    weakAreas: Array.from(weakAreas),
  };
}
