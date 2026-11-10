/**
 * The first-run tour's steps, in order. `WorkspaceTour` plays whatever is here,
 * so adding, removing or reordering a step is an edit to this list, plus its
 * copy in the locale files (`workspace.tour.<id>.title` and `.body`).
 *
 * A step says:
 * - `view`: where the workspace should be while it shows (`home`, `courses`,
 *   or `classroom`: the built-in course open in the pane). Omitted keeps
 *   whatever the previous step left on screen. The workspace only moves when
 *   the user moves the tour (Next, Back, or the lit element's own click), and
 *   the light only moves once the new target has settled on screen.
 * - `target`: what to light up. Each inner list is a set of selectors whose
 *   boxes are united; the first set that matches anything wins, which is how a
 *   step covers both the expanded and the folded rail. `null` centres the card
 *   with no cut-out.
 * - `passThrough`: the lit element takes a real click, and that click is the
 *   step's way forward (the app navigates itself, as it always would).
 * - `nextLabel`: the Next button's own words, when Next does something visible
 *   (opening the course).
 * - `lines`: short icon-led lines under the body.
 * - `action`: the card's main button: open the built-in course for real, or
 *   the example prompts that send at once (the tour's last step).
 * - `needsGuide`: left out when the deployment has no built-in course or the
 *   viewer removed it from My courses.
 */

import { AtSign, Paperclip, Sparkles, type LucideIcon } from 'lucide-react';

export type TourView = 'home' | 'courses' | 'classroom';

/** One selector, or a selector with a cap on how many of its matches count. */
export type TourTarget = string | { readonly selector: string; readonly max: number };

export interface TourStep {
  readonly id: string;
  readonly view?: TourView;
  readonly target: readonly (readonly TourTarget[])[] | null;
  readonly passThrough?: boolean;
  readonly nextLabel?: string;
  readonly lines?: readonly { readonly icon: LucideIcon; readonly key: string }[];
  readonly action?: 'openGuide' | 'examples';
  readonly needsGuide?: boolean;
}

const HOME_COMPOSER = '[data-testid="pro-workspace-home"] .ws-composer';

export const TOUR_STEPS: readonly TourStep[] = [
  { id: 'welcome', view: 'home', target: null },
  {
    id: 'start',
    view: 'home',
    target: [
      ['[data-testid="pro-workspace-new-session"]', '[data-testid="pro-nav-search"]'],
      ['[data-testid="pro-workspace-new-session-mini"]', '[data-testid="pro-nav-search-mini"]'],
    ],
  },
  // The rail item itself: clicking it is the step's way forward, as is Next.
  {
    id: 'coursesNav',
    target: [['[data-testid="pro-nav-my-courses"]']],
    passThrough: true,
    needsGuide: true,
  },
  {
    id: 'courses',
    view: 'courses',
    target: [['[data-testid^="workspace-courses-card-stage-guide-"]']],
    action: 'openGuide',
    nextLabel: 'workspace.tour.openLook',
    needsGuide: true,
  },
  {
    id: 'mode',
    view: 'classroom',
    target: [
      [
        '[data-testid="workspace-readonly-badge"]',
        '[data-testid="workbench-mode-learning"]',
        '[data-testid="workbench-mode-editing"]',
      ],
    ],
    needsGuide: true,
  },
  {
    id: 'dock',
    view: 'classroom',
    target: [['[data-testid="roundtable-region"]']],
    needsGuide: true,
  },
  {
    id: 'chat',
    view: 'classroom',
    target: [['[data-testid="workspace-chat-pane"]']],
    needsGuide: true,
  },
  { id: 'library', target: [['[data-testid="pro-nav-library"]']] },
  {
    id: 'conversations',
    target: [
      [
        '[data-testid="pro-nav-list-heading"]',
        { selector: '[data-testid="pro-nav-list"] [data-testid^="pro-nav-session-"]', max: 4 },
      ],
      ['[data-testid="pro-nav-mini-sessions"]'],
    ],
  },
  {
    id: 'account',
    target: [['[data-testid="pro-rail-utilities"]'], ['[data-testid="pro-rail-utilities-mini"]']],
  },
  {
    id: 'try',
    view: 'home',
    target: [[HOME_COMPOSER]],
    lines: [
      { icon: Paperclip, key: 'workspace.tour.try.attach' },
      { icon: AtSign, key: 'workspace.tour.try.mention' },
      { icon: Sparkles, key: 'workspace.tour.try.skill' },
    ],
    action: 'examples',
  },
];

/**
 * The last step's example prompts (`workspace.tour.examples.<id>.label` and
 * `.prompt`): short topics that generate quickly, learners first, one teacher.
 */
export const TOUR_EXAMPLES = ['sky', 'interest', 'teach'] as const;
