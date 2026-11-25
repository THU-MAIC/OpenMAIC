import type { TourStep } from '@/components/workbench/workspace/tour-steps';

/** The same tour follows the surface the learner is using, without moving their conversation. */
export function projectTourSteps({
  paneOpen,
  waitingToStart,
  showPaneComposer,
}: {
  paneOpen: boolean;
  waitingToStart: boolean;
  showPaneComposer: boolean;
}): readonly TourStep[] {
  const avatar = '[data-testid="pbl-companion-avatar"]';
  return [
    { id: 'welcome', target: null },
    {
      id: 'preview',
      target: [['[data-testid="pbl-application-panel"]'], ['[data-testid="pbl-workbench-split"]']],
    },
    paneOpen
      ? { id: 'conversationPane', target: [['[data-pbl-tour="conversation"] > header']] }
      : {
          id: 'companion',
          target: [[avatar, '[data-testid="pbl-companion-speech"]']],
        },
    paneOpen
      ? { id: 'learningPath', target: [['[data-pbl-tour="learning-path"]']] }
      : { id: 'progress', target: [[avatar]] },
    paneOpen
      ? showPaneComposer
        ? { id: 'reply', target: [['[data-pbl-tour="composer"]']] }
        : { id: 'collapsePane', target: [['[data-testid="pbl-assistant-close"]']] }
      : {
          id: 'controls',
          target: [
            [
              avatar,
              '[data-testid="pbl-companion-mute"]',
              '[data-testid="pbl-companion-speed"]',
              '[data-testid="pbl-companion-input"]',
            ],
          ],
        },
    { id: 'layout', target: [['[data-pbl-tour="layout"]']] },
    waitingToStart
      ? {
          id: 'start',
          target: [
            [
              paneOpen
                ? '[data-pbl-tour="conversation"] [data-pbl-tour="start"]'
                : '.pbl-start-bar [data-pbl-tour="start"]',
            ],
          ],
        }
      : { id: 'replay', target: [['[data-pbl-tour="replay"]']] },
  ];
}
