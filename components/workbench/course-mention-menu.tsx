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
import {
  MATERIAL_MENTION_LIMIT,
  type MaterialMentionCandidate,
} from '@/lib/workbench/material-mention';

/**
 * One row of the menu. Classrooms come first, then -- when the knowledge base
 * is offered -- its materials (RFC #1716 §4). Each section keeps one verb: a
 * classroom row names that classroom for this turn, a material row stages that
 * material for this message. The keyboard walks both as one list.
 */
type MenuRow =
  | { kind: 'course'; candidate: CourseMentionCandidate }
  | { kind: 'material'; candidate: MaterialMentionCandidate };

export function CourseMentionMenu({
  id,
  candidates,
  onPick,
  onClose,
  materials,
  onPickMaterial,
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
  /**
   * The knowledge base's sources matching the query, when the composer offers
   * them (materials enabled). Absent: the menu is the classroom picker alone.
   */
  readonly materials?: readonly MaterialMentionCandidate[];
  /** Stage a material for this message. */
  readonly onPickMaterial?: (candidate: MaterialMentionCandidate) => void;
}) {
  const { t } = useI18n();
  const titleId = useId();
  const menuRef = useRef<HTMLDivElement>(null);
  const optionRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const offersMaterials = materials !== undefined && onPickMaterial !== undefined;
  const rows: MenuRow[] = [
    ...candidates.map((candidate) => ({ kind: 'course' as const, candidate })),
    ...(offersMaterials
      ? materials.map((candidate) => ({ kind: 'material' as const, candidate }))
      : []),
  ];
  // Filtering shortens the list under the highlight; the pick and the painted
  // row read the same clamped index rather than resetting state mid-typing —
  // the skill menu resolves its own highlight the same way.
  const activeIndex = highlightedIndex < rows.length ? highlightedIndex : 0;
  const pickRow = (row: MenuRow) =>
    row.kind === 'course' ? onPick(row.candidate) : onPickMaterial?.(row.candidate);

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
      if (rows.length === 0) return;

      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        event.stopPropagation();
        const direction = event.key === 'ArrowDown' ? 1 : -1;
        setHighlightedIndex((current) => {
          const from = current < rows.length ? current : 0;
          return (from + direction + rows.length) % rows.length;
        });
        return;
      }

      if (event.key === 'Enter') {
        event.preventDefault();
        event.stopPropagation();
        pickRow(rows[activeIndex] ?? rows[0]!);
      }
    };

    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  });

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
        {rows.length === 0 ? (
          <p className="px-3 py-3 text-[11px] text-muted-foreground">
            {t(
              offersMaterials
                ? 'workspace.courseMention.emptyWithMaterials'
                : 'workspace.courseMention.empty',
            )}
          </p>
        ) : candidates.length === 0 ? null : (
          <>
            {offersMaterials && materials.length > 0 ? (
              <p className="px-3 pb-1 pt-2 text-[10.5px] font-medium text-muted-foreground">
                {t('workspace.courseMention.classrooms')}
              </p>
            ) : null}
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
        {offersMaterials && materials.length > 0 ? (
          <>
            <p
              data-testid="workbench-material-section"
              className="px-3 pb-1 pt-2 text-[10.5px] font-medium text-muted-foreground"
            >
              {t('workspace.courseMention.knowledgeBase')}
            </p>
            <ul data-testid="workbench-material-all">
              {materials.map((candidate, materialIndex) => {
                const index = candidates.length + materialIndex;
                // Every state is named, so a material not yet extracted and one
                // ready to read look different (RFC #1716 §4).
                const status = t(
                  candidate.extractionStatus === 'failed'
                    ? 'workspace.courseMention.materialFailed'
                    : candidate.extractionStatus === 'pending' ||
                        candidate.extractionStatus === 'running'
                      ? 'workspace.courseMention.materialExtracting'
                      : candidate.extractionStatus === 'done'
                        ? 'workspace.courseMention.materialExtracted'
                        : 'workspace.courseMention.materialNotExtracted',
                );
                const where = candidate.folderName ?? t('workspace.courseMention.unfiled');
                const label = t('workspace.courseMention.attachMaterial', { name: candidate.name });
                return (
                  <li key={candidate.materialId}>
                    <button
                      ref={(node) => {
                        optionRefs.current[index] = node;
                      }}
                      type="button"
                      role="option"
                      aria-selected={index === activeIndex}
                      data-highlighted={index === activeIndex ? 'true' : undefined}
                      data-testid={`workbench-material-option-${candidate.materialId}`}
                      title={label}
                      aria-label={label}
                      onClick={() => onPickMaterial(candidate)}
                      onMouseEnter={() => setHighlightedIndex(index)}
                      className={cn(
                        'ws-cmenu-row flex w-full min-w-0 items-center gap-2 px-3 text-left transition-colors hover:bg-muted',
                        index === activeIndex && 'bg-muted',
                      )}
                    >
                      <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-foreground">
                        {candidate.name}
                      </span>
                      <span className="shrink-0 truncate text-[10.5px] text-muted-foreground">
                        {`${where} · ${status}`}
                      </span>
                      {/* Already in this conversation, or already on this message. */}
                      {candidate.attached || candidate.staged ? (
                        <Check
                          size={12}
                          className="shrink-0 text-muted-foreground"
                          aria-label={t(
                            candidate.staged
                              ? 'workspace.courseMention.materialStaged'
                              : 'workspace.courseMention.materialAttached',
                          )}
                        />
                      ) : null}
                    </button>
                  </li>
                );
              })}
            </ul>
            {materials.length >= MATERIAL_MENTION_LIMIT ? (
              <p className="px-3 pb-2 pt-1 text-[10.5px] text-muted-foreground">
                {t('workspace.courseMention.materialsCapped', { count: MATERIAL_MENTION_LIMIT })}
              </p>
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  );
}
