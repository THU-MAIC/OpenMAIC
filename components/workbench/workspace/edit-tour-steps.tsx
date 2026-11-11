/**
 * The Edit tour's steps, in order: the first time an owner switches a course
 * to Edit, `WorkspaceClassroomPane` plays these with the same engine and look
 * as the first-run tour (`WorkspaceTour`, see `tour-steps.tsx` for the step
 * fields). It reads layout only: no step navigates, opens a menu or changes
 * the course. Copy is `workspace.tour.edit.<id>.title` / `.body`.
 */

import type { TourStep } from './tour-steps';

const PANE = '[data-testid="workspace-classroom-pane"]';

export const EDIT_TOUR_STEPS: readonly TourStep[] = [
  { id: 'edit.canvas', target: [[`${PANE} [data-maic-stage-card]`]] },
  {
    id: 'edit.pages',
    target: [
      [`${PANE} [data-testid="edit-rail-toggle"]`, `${PANE} [data-testid="edit-page-indicator"]`],
    ],
  },
  {
    id: 'edit.bar',
    target: [[`${PANE} [data-testid="edit-bar-pill"]`, `${PANE} [data-testid="element-ref-arm"]`]],
  },
  { id: 'edit.timeline', target: [[`${PANE} [data-testid="edit-dock-timeline"]`]] },
  {
    id: 'edit.dock',
    target: [[`${PANE} [data-testid="dock-resize"]`, `${PANE} [data-testid="dock-fold"]`]],
  },
  { id: 'edit.learn', target: [[`${PANE} [data-testid="workbench-mode-learning"]`]] },
  { id: 'edit.chat', target: [['[data-testid="workspace-chat-pane"]']] },
];
