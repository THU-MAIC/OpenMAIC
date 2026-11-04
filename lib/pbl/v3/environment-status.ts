import type { LearningView } from './types';

/** Same environment reason in the banner and editor; input never replays typed text. */
export function environmentNotice(
  environment: LearningView['environment'],
  preparing: boolean,
  failed = false,
): 'releasing' | 'preparing' | 'unavailable' | 'inactive' {
  if (environment?.releasing || environment?.state === 'destroying') return 'releasing';
  if (preparing) return 'preparing';
  if (failed || environment?.state === 'unknown') return 'unavailable';
  return 'inactive';
}
export const environmentNoticeKeys = {
  releasing: 'pblV3.environmentReleasing',
  preparing: 'pblV3.environmentNotice',
  unavailable: 'pblV3.environmentUnavailable',
  inactive: 'pblV3.environmentSleeping',
} as const;
