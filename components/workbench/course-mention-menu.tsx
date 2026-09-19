'use client';

/**
 * The classroom picker — how a turn gets a target.
 *
 * The two content columns of the workspace are independent, so the agent is
 * never told which classroom a sentence is about by the layout. This is where it
 * IS told: open the picker (type `@`, or choose the "reference a course" entry
 * from `+`), pick a course, and the pick rides along with the message as an
 * explicit target.
 *
 * IT IS A PICKER AND NOTHING ELSE. A pick becomes a `courseRef` carrying a
 * stageId, which the server resolves against the owner's own library at
 * injection time. The composer's other trigger, `/` for skills, was deliberately
 * made the opposite — plain text written into the draft — because a skill handle
 * is a hint the MODEL reads and nothing parses it. Two triggers, two shapes, on
 * purpose: do not "unify" them.
 *
 * ── ONE LIST, ONE VERB ────────────────────────────────────────────────────
 *
 * Every row does the same thing: name this classroom for this turn. That is the
 * whole menu.
 *
 * It used to have two sections. The top one, "mentioned in this conversation",
 * showed a DERIVED set of classrooms the conversation was "involved with", in
 * accent text, and activating one opened the classroom pane instead of naming
 * it — plus a hover `✕` to take a classroom out of that set, which needed a
 * stored ignore list and a column on the session row. All of it is gone,
 * because the premise was wrong: a classroom has no "relation logic" here — a
 * mention is just a selection. Nothing is a membership, so there is nothing to
 * pin, nothing to correct, and no second verb to explain.
 *
 * That also removes the whole class of bug the old rows kept producing: no row
 * carries a trailing control, so nothing can be painted over a long title and
 * there is no `pr-*` to keep in sync with an absolutely-positioned button. The
 * name is the only thing on the line (`min-w-0 truncate`), beside a check mark
 * for a classroom already named this turn — information, not a control.
 *
 * There is no leading icon. A book glyph on every row said nothing the name did
 * not, and crowded the name it sat against.
 *
 * ── Scrolling ─────────────────────────────────────────────────────────────
 *
 * The list scrolls. Its height is a whole number of rows (see `--wb-cmenu-*`),
 * so the resting state never shows half a row the way a fixed `max-h` did — that
 * clipped a row with no way to reach it at all. ↑/↓ scroll the highlighted row
 * into view, which is what makes the keyboard usable once the list is longer than
 * the window.
 *
 * Modelled on `SkillSlashMenu` down to the keyboard contract (↑/↓ move, Enter
 * activates, Esc closes, and the menu owns those keys only while it is open),
 * because the two menus sit in the same box and must not behave differently. The
 * ordering rules are pure and live in `lib/workbench/course-mention`.
 */
import { useEffect, useId, useRef, useState } from 'react';
import { Check } from 'lucide-react';
import { useI18n } from '@/lib/hooks/use-i18n';
import { cn } from '@/lib/utils/cn';
import { COURSE_MENTION_LIMIT, type CourseMentionCandidate } from '@/lib/workbench/course-mention';

export function CourseMentionMenu({
  id,
  candidates,
  onPick,
  onClose,
}: {
  /** The trigger's `aria-controls` target. */
  readonly id?: string;
  readonly candidates: readonly CourseMentionCandidate[];
  /** Name a course for this turn — what EVERY row does. */
  readonly onPick: (candidate: CourseMentionCandidate) => void;
  /**
   * Put the menu away: Escape, a click outside it, or the trigger being pressed
   * again. The composer owns the open state — there is exactly one, shared by the
   * keystroke and the `+` menu item — so every dismissal comes back through here.
   */
  readonly onClose: () => void;
}) {
  const { t } = useI18n();
  const titleId = useId();
  const menuRef = useRef<HTMLDivElement>(null);
  const optionRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  // Filtering shortens the list under the highlight; the pick and the painted
  // row read the same clamped index rather than resetting state mid-typing —
  // the skill menu resolves its own highlight the same way.
  const activeIndex = highlightedIndex < candidates.length ? highlightedIndex : 0;

  // Keep the highlighted row in view: the list scrolls now, so a keyboard walk
  // past the window's edge would otherwise move an invisible highlight.
  useEffect(() => {
    optionRefs.current[highlightedIndex]?.scrollIntoView({ block: 'nearest' });
  }, [highlightedIndex]);

  /**
   * A press outside the menu puts it away — the transcript, the classroom pane,
   * a pane header, anywhere.
   *
   * Two exceptions, both marked in the DOM with `data-mention-keep-open` rather
   * than guessed at from here: the TRIGGER (it toggles, and closing on its
   * pointerdown would fight its own click) and the TEXTAREA (moving the caret
   * while typing a query is not "somewhere else"). `pointerdown` in the capture
   * phase, so a click that unmounts its own target still closes the menu.
   */
  useEffect(() => {
    const onPointerDown = (event: Event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (menuRef.current?.contains(target)) return;
      if (target.closest('[data-mention-keep-open]')) return;
      onClose();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [onClose]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const textarea = menuRef.current?.parentElement?.querySelector('textarea');
      const onTextarea = event.target === textarea;
      if (event.isComposing) return;

      if (event.key === 'Escape') {
        // Escape closes from inside the menu too: a click on a row moves focus
        // off the textarea, and the keyboard must still work afterwards. The
        // draft is NOT touched — closing the picker never eats what the user has
        // typed.
        const inMenu =
          event.target instanceof Node && menuRef.current?.contains(event.target) === true;
        if (!onTextarea && !inMenu) return;
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      }
      // Everything below is the textarea's keyboard contract, unchanged.
      if (!onTextarea) return;
      if (candidates.length === 0) return;

      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        event.stopPropagation();
        const direction = event.key === 'ArrowDown' ? 1 : -1;
        setHighlightedIndex((current) => {
          const from = current < candidates.length ? current : 0;
          return (from + direction + candidates.length) % candidates.length;
        });
        return;
      }

      if (event.key === 'Enter') {
        event.preventDefault();
        event.stopPropagation();
        onPick(candidates[activeIndex] ?? candidates[0]!);
      }
    };

    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [activeIndex, candidates, onClose, onPick]);

  return (
    <div
      ref={menuRef}
      id={id}
      data-testid="workbench-course-menu"
      data-esc-owner=""
      role="listbox"
      aria-label={t('workspace.courseMention.title')}
      aria-labelledby={titleId}
      className="pro-skill-slash-popover absolute bottom-full left-0 z-30 mb-1.5 w-full max-w-[340px] overflow-hidden rounded-xl border border-border bg-popover shadow-lg"
    >
      <span id={titleId} className="sr-only">
        {t('workspace.courseMention.title')}
      </span>
      <div
        data-testid="workbench-course-scroll"
        // Its height is a whole number of rows (`workbench-chat.css`), so the
        // resting state cannot show half a row.
        className="ws-cmenu-scroll overflow-y-auto overscroll-contain"
      >
        {candidates.length === 0 ? (
          <p className="px-3 py-3 text-[11px] text-muted-foreground">
            {t('workspace.courseMention.empty')}
          </p>
        ) : (
          <>
            <ul data-testid="workbench-course-all">
              {candidates.map((candidate, index) => {
                const label = t('workspace.courseMention.reference', { name: candidate.title });
                return (
                  <li key={candidate.stageId}>
                    <button
                      ref={(node) => {
                        optionRefs.current[index] = node;
                      }}
                      type="button"
                      role="option"
                      aria-selected={index === activeIndex}
                      data-highlighted={index === activeIndex ? 'true' : undefined}
                      data-reason={candidate.reason}
                      data-testid={`workbench-course-option-${candidate.stageId}`}
                      title={label}
                      aria-label={label}
                      onClick={() => onPick(candidate)}
                      onMouseEnter={() => setHighlightedIndex(index)}
                      className={cn(
                        'ws-cmenu-row flex w-full min-w-0 items-center gap-2 px-3 text-left transition-colors hover:bg-muted',
                        index === activeIndex && 'bg-muted',
                      )}
                    >
                      {/* The only flexible thing on the line. */}
                      <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-foreground">
                        {candidate.title}
                      </span>
                      {/* Already named for this turn. Information, not a control. */}
                      {candidate.alreadyReferenced ? (
                        <Check
                          size={12}
                          className="shrink-0 text-muted-foreground"
                          aria-label={t('workspace.courseMention.alreadyNamed')}
                        />
                      ) : null}
                    </button>
                  </li>
                );
              })}
            </ul>
            {/* At the cap there are more matches than rows. Say so rather than
                silently ending the list — the previous version's whole problem was
                a list that looked complete and was not. */}
            {candidates.length >= COURSE_MENTION_LIMIT ? (
              <p
                data-testid="workbench-course-capped"
                className="px-3 pb-2 pt-1 text-[10.5px] text-muted-foreground"
              >
                {t('workspace.courseMention.capped', { count: COURSE_MENTION_LIMIT })}
              </p>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
