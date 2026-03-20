import type { CodingQuizSession, PlacementQuizSession, QuizSession } from './types';

export function parseQuizSession(payload: string): QuizSession {
  const parsed = JSON.parse(payload) as QuizSession;
  if ((parsed as PlacementQuizSession).track === 'placement-aptitude') return parsed as PlacementQuizSession;
  return parsed as CodingQuizSession;
}
