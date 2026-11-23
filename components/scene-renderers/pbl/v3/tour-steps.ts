import type { TourStep } from '@/components/workbench/workspace/tour-steps';

/**
 * The project workbench's first-run tour, played by the product's own tour player so it
 * looks and behaves like the one a learner has already met. Copy lives under `pblV3.tour`.
 */
export const PBL_TOUR_STEPS: readonly TourStep[] = [
  { id: 'welcome', target: null },
  {
    id: 'preview',
    target: [['[data-testid="pbl-application-panel"]'], ['[data-testid="pbl-workbench-split"]']],
  },
  {
    id: 'companion',
    target: [
      [
        '[data-testid="pbl-companion-avatar"]',
        '[data-testid="pbl-companion-bubble"]',
        '[data-testid="pbl-companion-speech"]',
      ],
    ],
  },
  { id: 'progress', target: [['[data-testid="pbl-companion-avatar"]']] },
  {
    id: 'controls',
    target: [
      [
        '[data-testid="pbl-companion-avatar"]',
        '[data-testid="pbl-companion-mute"]',
        '[data-testid="pbl-companion-speed"]',
        // Under the bubble once it is the learner's turn; not there before the project starts.
        '[data-testid="pbl-companion-input"]',
      ],
    ],
  },
  { id: 'layout', target: [['[data-pbl-tour="layout"]']] },
  { id: 'start', target: [['.pbl-start-bar'], ['[data-testid="pbl-companion-avatar"]']] },
];
