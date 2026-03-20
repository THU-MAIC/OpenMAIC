import type { PlacementQuestion } from './types';

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
