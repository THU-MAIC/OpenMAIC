'use client';

/**
 * The in-chat course link — how a course gets onto the screen.
 *
 * The agent talks about a course; this is the thing you click to look at it.
 * It is the primary way the right pane is filled, so it is a CARD with a clear
 * "this opens" meaning: the course's cover (its first page, as the course
 * library shows it), its name, how many pages, and "Open →" at the far edge.
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
 *            (`text-block.tsx` upgrades a `/classroom/<id>` anchor). Just a
 *            link in the sentence, so the paragraph keeps its rhythm; the
 *            block card for it stands right under that paragraph (one per
 *            course per answer, none for a course already carded at the
 *            answer's tail -- `segmentCourseMentions`). Its press does exactly
 *            what the block form's does.
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

import { useEffect, useState } from 'react';
import { ArrowRight, BookOpen, MoreHorizontal } from 'lucide-react';
import { SlideThumbnail } from '@/components/slide-renderer/SlideThumbnail';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useCourseThumbnails } from '@/lib/hooks/use-course-thumbnails';
import { cn } from '@/lib/utils/cn';
import { useWorkbenchCourseNavigation } from '@/lib/workbench/panel-context';
import { useWorkbenchStore } from '@/lib/workbench/session-store';
import { splitRunCourseCards } from '@/lib/workbench/course-link';
import { wbStyles as styles } from './chat-styles';

/** The cover's width in CSS pixels (`styles.courseLink.thumb` is `w-16`). */
const COVER_WIDTH = 64;

/**
 * The course's cover: its first page, from the same cache the course library
 * reads, at the version the workspace knows (`updatedAt`). A course the
 * workspace cannot date yet, or one without a page, shows the book glyph.
 */
function CourseCover({
  courseId,
  version,
}: {
  readonly courseId: string;
  readonly version: number | null;
}) {
  const { thumbnails, requestThumbnail } = useCourseThumbnails();
  useEffect(() => {
    if (version === null) return;
    return requestThumbnail(courseId, version);
  }, [courseId, version, requestThumbnail]);
  const slide = version === null ? null : thumbnails[courseId];
  return (
    <span className={styles.courseLink.thumb} aria-hidden="true">
      {slide ? (
        <SlideThumbnail
          slide={slide}
          size={COVER_WIDTH}
          viewportSize={slide.viewportSize ?? 1000}
          viewportRatio={slide.viewportRatio ?? 0.5625}
        />
      ) : (
        <BookOpen className={styles.courseLink.glyph} />
      )}
    </span>
  );
}

export function CourseLink({
  courseId,
  variant,
  label,
  fallback,
}: {
  readonly courseId: string;
  readonly variant: 'block' | 'inline';
  /**
   * What the agent called it, when the agent wrote the link itself. In the
   * sentence it stays the agent's words; on the card the workspace's own name
   * wins when it has one — the rail, the tab and the card must not disagree
   * about what a course is called.
   */
  readonly label?: React.ReactNode;
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
  const fallbackName = t('workspace.untitledCourse');
  // The sentence keeps the agent's own words; the card says what the course is.
  const name =
    variant === 'inline'
      ? (label ?? summary?.name ?? fallbackName)
      : summary?.name || label || fallbackName;
  const pageCount = summary?.pageCount ?? null;
  // One sentence, whatever the pane is currently showing — the press is the
  // same in every case, so describing it three ways only invited the reader to
  // look for a difference that is not there.
  const richLabel = label != null && typeof label !== 'string';
  // Rich labels carry their own accessible content (including KaTeX MathML).
  // Do not replace it with an inaccurate "untitled" accessible name.
  const hint =
    richLabel && !summary?.name
      ? undefined
      : t('workspace.courseLinkHint', { name: summary?.name || label || fallbackName });

  if (variant === 'inline') {
    return (
      <button
        type="button"
        data-testid={`workbench-course-link-${courseId}`}
        data-variant="inline"
        title={hint}
        className={styles.courseLink.inline}
        onClick={() => navigation.openCourse(courseId)}
      >
        {name}
      </button>
    );
  }

  return (
    <button
      type="button"
      data-testid={`workbench-course-link-${courseId}`}
      data-variant="block"
      title={hint}
      aria-label={hint}
      className={cn(styles.courseLink.base, styles.courseLink.block)}
      onClick={() => navigation.openCourse(courseId)}
    >
      <CourseCover courseId={courseId} version={summary?.updatedAt ?? null} />
      <span className={styles.courseLink.body}>
        <span className={styles.courseLink.name}>{name}</span>
        {/* No page count rather than a fabricated 0: a deck the agent is still
            writing has no honest number yet. */}
        {pageCount === null ? null : (
          <span className={styles.courseLink.pages}>
            {t('workspace.sceneCount', { count: pageCount })}
          </span>
        )}
      </span>
      <span className={styles.courseLink.open} aria-hidden="true">
        {t('workspace.courseLinkOpen')}
        <ArrowRight className="size-3" />
      </span>
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
