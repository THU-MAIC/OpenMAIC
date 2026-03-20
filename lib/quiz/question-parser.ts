import { parseFirstJsonObject } from '@/lib/server/json-parser';
import type { CodingQuizSession, PlacementQuizSession, QuizSession } from './types';

export function parseQuizSession(payload: string): QuizSession {
  const parsed = parseFirstJsonObject<QuizSession>(payload);
  if ((parsed as PlacementQuizSession).track === 'placement-aptitude') {
    return parsed as PlacementQuizSession;
  }
  return parsed as CodingQuizSession;
}
