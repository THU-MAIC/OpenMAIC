import type { LearningView } from './types';

/** Legacy browser preference. Kept only for compatibility tests; never used to skip the guide. */
export const ONBOARDING_STORAGE_KEY = 'openmaic:pbl-v3:onboarding:v1';

export const onboardingSteps = ['progress', 'discussion', 'code', 'application', 'replay'] as const;
export type OnboardingStep = (typeof onboardingSteps)[number];

export function stepsForWorkbench(view: Pick<LearningView, 'application'>) {
  return onboardingSteps.filter((step) => step !== 'application' || !!view.application);
}
