'use client';

/**
 * The in-chat course link — how a course gets onto the screen.
 *
 * The agent talks about a course; this is the thing you click to look at it.
 * It is the primary way the right pane is filled, so it is deliberately LIGHT:
 * no thumbnail, no media card, no preview. A glyph, a name, and how many pages.
 *
 * ALWAYS PRESSABLE, AND ALWAYS THE SAME PRESS. The card used to end in a state
 * cue — open-in-side-pane / switch-to-tab / now-showing — driven by the pane's open set and its
 * active id. That cue is gone with the state machine behind it: it reported a
 * fact the reader gets by glancing right, it made a card look conditional when
 * it never was, and it was the loudest thing on a row whose subject is a course
 * name. One press, one meaning: put this course on screen, expanding the right
 * pane when it is shut (`openCourse` in the shell does both). Nothing here is
 * ever disabled, and nothing about the middle column moves.
 *
 * Two forms, one component:
 *
 *   block  — the answer produced or was pointed at this classroom. Its own line,
 *            with the page count at the far edge. One exchange's set of these
 *            sits at the tail of that answer (see `SessionCourseLink` below).
 *   inline — the course is named mid-sentence, by the agent's own prose
 *            (`text-block.tsx` upgrades a `/classroom/<id>` anchor). A pill, so a
 *            paragraph that mentions three courses does not become a wall of
 *            cards. It is INDEPENDENT of the per-exchange rule: prose is prose,
 *            and a sentence naming a classroom is not a receipt for one. Its
 *            press does exactly what the block form's does.
 *
 * Every visual decision lives in ONE place, `wbStyles.courseLink` — degrading
 * the block form to a plain underlined link is a change to that table and
 * nowhere else.
 *
 * NO ORIGIN, NO PAIRING, NO ASSOCIATION. The link says what the course is and
 * where it will appear. It never says which chat made it, and clicking it does
 * not attach, bind or pair anything: it joins the id to this chat's ordered tab
 * set, which is view state and nothing more.
 */

import { useState } from 'react';
import { BookOpen, MoreHorizontal } from 'lucide-react';
import { useI18n } from '@/lib/hooks/use-i18n';
import { cn } from '@/lib/utils/cn';
import { useWorkbenchCourseNavigation } from '@/lib/workbench/panel-context';
import { useWorkbenchStore } from '@/lib/workbench/session-store';
import { splitRunCourseCards } from '@/lib/workbench/course-link';
import { wbStyles as styles } from './chat-styles';

export function CourseLink({
  courseId,
  variant,
  label,
  fallback,
}: {
  readonly courseId: string;
  readonly variant: 'block' | 'inline';
  /**
   * What the agent called it, when the agent wrote the link itself. The
   * workspace's own name for the course wins when it has one — the rail, the
   * tab and this link must not disagree about what a course is called.
   */
  readonly label?: string;
  /**
   * What to render with no workspace around us: the classic workbench hosts
   * this same timeline and has no right pane to open anything into, so an
   * inline link falls back to the anchor it came from rather than offering an
   * action that cannot happen.
   */
  readonly fallback?: React.ReactNode;
}) {
  const { t } = useI18n();
  const navigation = useWorkbenchCourseNavigation();
  if (!navigation) return <>{fallback ?? label ?? courseId}</>;

  const summary = navigation.lookupCourse(courseId);
  const name = summary?.name || label || t('workspace.untitledCourse');
  const pageCount = summary?.pageCount ?? null;
  // One sentence, whatever the pane is currently showing — the press is the
  // same in every case, so describing it three ways only invited the reader to
  // look for a difference that is not there.
  const hint = t('workspace.courseLinkHint', { name });

  return (
    <button
      type="button"
      data-testid={`workbench-course-link-${courseId}`}
      data-variant={variant}
      title={hint}
      aria-label={hint}
      className={cn(styles.courseLink.base, variant === 'block' && styles.courseLink.block)}
      onClick={() => navigation.openCourse(courseId)}
    >
      <BookOpen className={styles.courseLink.glyph} aria-hidden="true" />
      <span className={styles.courseLink.name}>{name}</span>
      {variant === 'block' ? (
        // The page count is a FACT about the course, so it stays where the cue
        // used to end the row — at the far edge, one step quieter.
        // No page count rather than a fabricated 0: a deck the agent is still
        // writing has no honest number yet.
        pageCount === null ? null : (
          <span className={styles.courseLink.pages}>
            {t('workspace.sceneCount', { count: pageCount })}
          </span>
        )
      ) : null}
    </button>
  );
}

/**
 * ONE EXCHANGE'S classroom cards, at the tail of the answer that produced them.
 *
 * The artifact-card pattern: the answer says what it did in prose, and the things
 * it produced or was pointed at are named underneath it, clickable. Which
 * classrooms those are is decided in the fold (`lib/workbench/run-courses` for
 * what counts, `session-store`'s `agent_end` for when it lands — an exchange, not
 * a pi `turn`) — this renders that list and nothing else, so the timeline holds no
 * course state of its own and a replay paints the identical tail.
 *
 * Over three, the rest fold behind a `+N` (`splitRunCourseCards`). The expansion
 * is local, ephemeral UI state on purpose: it is a disclosure, not a preference,
 * and nothing about which cards an answer has may depend on what a previous
 * reader clicked.
 *
 * NO stageIds AT ALL is the legacy unbound row — a v1 transcript's page
 * checkpoint carried no stage id, so the row falls back to the session's own
 * stage, which lives beside the fold rather than in it. Not yet known (a
 * `?session=` deep link attaches before the meta fetch lands) means nothing is
 * rendered rather than a link that cannot work.
 */
export function SessionCourseLink({ stageIds }: { readonly stageIds?: readonly string[] }) {
  const { t } = useI18n();
  const sessionStageId = useWorkbenchStore((s) => s.stageId);
  const [expanded, setExpanded] = useState(false);
  const { shown, hiddenCount } = splitRunCourseCards(stageIds ?? [], expanded);

  if (!stageIds || stageIds.length === 0) {
    if (!sessionStageId) return null;
    return <CourseLink courseId={sessionStageId} variant="block" />;
  }

  const moreLabel = t('workspace.courseLinkMore', { count: hiddenCount });
  return (
    <div className={styles.courseLink.set} data-testid="workbench-course-card-set">
      {shown.map((courseId) => (
        <CourseLink key={courseId} courseId={courseId} variant="block" />
      ))}
      {hiddenCount > 0 ? (
        <button
          type="button"
          data-testid="workbench-course-card-more"
          title={moreLabel}
          aria-label={moreLabel}
          className={cn(styles.courseLink.base, styles.courseLink.block, styles.courseLink.more)}
          onClick={() => setExpanded(true)}
        >
          <MoreHorizontal className={styles.courseLink.glyph} aria-hidden="true" />
          <span className={styles.courseLink.name}>+{hiddenCount}</span>
        </button>
      ) : null}
    </div>
  );
}
