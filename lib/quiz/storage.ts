import type { QuizHistoryItem, WeakAreaSummary } from './types';
import { QUIZ_HISTORY_STORAGE_KEY } from './constants';

function readHistory(): QuizHistoryItem[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(QUIZ_HISTORY_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function getQuizHistory(): QuizHistoryItem[] {
  return readHistory().sort((a, b) => b.createdAt - a.createdAt);
}

export function saveQuizHistoryItem(item: QuizHistoryItem) {
  if (typeof window === 'undefined') return;
  const next = [item, ...readHistory()].slice(0, 30);
  localStorage.setItem(QUIZ_HISTORY_STORAGE_KEY, JSON.stringify(next));
}

export function getWeakAreaSummary(): WeakAreaSummary[] {
  const map = new Map<string, WeakAreaSummary>();
  for (const item of readHistory()) {
    const seen = new Set<string>();
    for (const area of item.weakAreas) {
      const current = map.get(area) || { area, misses: 0, attempts: 0 };
      current.misses += 1;
      current.attempts += 1;
      map.set(area, current);
      seen.add(area);
    }
    for (const area of seen) {
      const current = map.get(area);
      if (current) map.set(area, current);
    }
  }
  return Array.from(map.values()).sort((a, b) => b.misses - a.misses).slice(0, 8);
}

export function getSuggestedNextQuiz() {
  const weakAreas = getWeakAreaSummary();
  if (weakAreas.length === 0) {
    return {
      title: 'Start with Placement Aptitude',
      description: 'Build consistency with a General medium-difficulty placement set.',
      track: 'placement-aptitude' as const,
    };
  }

  const top = weakAreas[0];
  if (['quant', 'logical', 'verbal', 'data-interpretation'].includes(top.area)) {
    return {
      title: `Revisit ${top.area}`,
      description: 'Take another placement aptitude set focused on your weakest topic.',
      track: 'placement-aptitude' as const,
    };
  }

  return {
    title: `Practice ${top.area}`,
    description: 'Take a coding examination focused on the concept you miss most often.',
    track: 'coding-examination' as const,
  };
}
