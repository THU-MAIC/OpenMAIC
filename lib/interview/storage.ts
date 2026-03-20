import { INTERVIEW_HISTORY_STORAGE_KEY } from './constants';
import type { InterviewHistoryItem } from './types';

export function getInterviewHistory(): InterviewHistoryItem[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(INTERVIEW_HISTORY_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveInterviewHistory(item: InterviewHistoryItem) {
  if (typeof window === 'undefined') return;
  const next = [item, ...getInterviewHistory()].slice(0, 20);
  localStorage.setItem(INTERVIEW_HISTORY_STORAGE_KEY, JSON.stringify(next));
}
