import type { LearningView } from './types';

/** Device-local UI preference, deliberately independent of learning/draft storage. */
export const ONBOARDING_STORAGE_KEY = 'openmaic:pbl-v3:onboarding:v1';

export const onboardingSteps = ['progress', 'discussion', 'code', 'application', 'replay'] as const;
export type OnboardingStep = (typeof onboardingSteps)[number];

export function stepsForWorkbench(view: Pick<LearningView, 'application'>) {
  return onboardingSteps.filter((step) => step !== 'application' || !!view.application);
}

// A denied/quota-limited browser store must not prevent learning or cause a
// second automatic tour when the same workspace is mounted again in this tab.
let seenInTab = false;
export function hasSeenOnboarding(storage: Pick<Storage, 'getItem'> | null) {
  try {
    return seenInTab || storage?.getItem(ONBOARDING_STORAGE_KEY) === 'seen';
  } catch {
    return seenInTab;
  }
}

export function rememberOnboarding(storage: Pick<Storage, 'setItem'> | null) {
  seenInTab = true;
  try {
    storage?.setItem(ONBOARDING_STORAGE_KEY, 'seen');
  } catch {
    // This preference is optional; learning data uses its own persistence.
  }
}
