/**
 * Grading Utility for Slate Courses
 * Calculates a letter grade based on course completion, quiz performance, and engagement.
 */

export type LetterGrade = 'A+' | 'A' | 'B' | 'C' | 'D' | 'F';

export interface GradingParams {
  slidesViewed: number;
  totalSlides: number;
  quizScoreAverage: number; // 0-100
  engagementCount: number; // number of chat interactions
}

export interface GradingResult {
  grade: LetterGrade;
  score: number; // Overall weighted score (0-100)
  breakdown: {
    completion: number;
    quiz: number;
    engagement: number;
  };
}

/**
 * Calculates a grade based on three weighted parameters
 */
export function calculateGrade(params: GradingParams): GradingResult {
  const { slidesViewed, totalSlides, quizScoreAverage, engagementCount } = params;

  // 1. Completion Score (0-100)
  const completionScore = totalSlides > 0 ? (slidesViewed / totalSlides) * 100 : 0;

  // 2. Quiz Score (0-100) - use quizScoreAverage directly
  const quizScore = quizScoreAverage;

  // 3. Engagement Score (0-100) - cap at 5 interactions for 100%
  const engagementScore = Math.min(100, engagementCount * 20);

  // Weighted Average Calculation
  // Completion: 40% | Quizzes: 40% | Engagement: 20%
  const weightedScore = completionScore * 0.4 + quizScore * 0.4 + engagementScore * 0.2;

  let grade: LetterGrade = 'F';
  if (weightedScore >= 95) grade = 'A+';
  else if (weightedScore >= 85) grade = 'A';
  else if (weightedScore >= 75) grade = 'B';
  else if (weightedScore >= 65) grade = 'C';
  else if (weightedScore >= 50) grade = 'D';

  return {
    grade,
    score: Math.min(Math.round(weightedScore), 100),
    breakdown: {
      completion: Math.round(completionScore),
      quiz: Math.round(quizScore),
      engagement: Math.round(engagementScore),
    },
  };
}
