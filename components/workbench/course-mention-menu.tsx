'use client';

import { MEDIA_MAX_DURATION_SEC } from '@/lib/types/media-limits';
import { extractionLabelKey } from '@/lib/workbench/material-library-client';

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
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { Check } from 'lucide-react';
import { useI18n } from '@/lib/hooks/use-i18n';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils/cn';
import { COURSE_MENTION_LIMIT, type CourseMentionCandidate } from '@/lib/workbench/course-mention';
import {
  MATERIAL_MENTION_LIMIT,
  materialAttachable,
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
  search,
}: {
  /** The trigger's `aria-controls` target. */
  readonly id?: string;
  /** Toolbar search uses the same candidate queries as the inline @ token. */
  readonly search?: { query: string; onChange: (query: string) => void };
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
  const searchRef = useRef<HTMLInputElement>(null);
  const hasSearch = search !== undefined;
  useEffect(() => {
    searchRef.current?.focus();
  }, [hasSearch]);
  const optionRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const offersMaterials = materials !== undefined && onPickMaterial !== undefined;
  // What the search searches (#1880): read when the menu opens, before a query
  // can narrow the classrooms away, so typing never changes the label.
  const [classroomsAtOpen] = useState(() => candidates.length > 0);
  const lists = !offersMaterials
    ? 'classrooms'
    : classroomsAtOpen || candidates.length > 0
      ? 'both'
      : 'materials';
  const searchLabel = t(
    lists === 'classrooms'
      ? 'workspace.courseMention.searchClassrooms'
      : lists === 'both'
        ? 'workspace.courseMention.search'
        : 'workspace.courseMention.searchMaterials',
  );
  // The menu's name says what it offers, as the search does.
  const menuTitle = t(
    lists === 'classrooms'
      ? 'workspace.courseMention.title'
      : lists === 'both'
        ? 'workspace.courseMention.titleBoth'
        : 'workspace.courseMention.titleMaterials',
  );
  const rows: MenuRow[] = [
    ...candidates.map((candidate) => ({ kind: 'course' as const, candidate })),
    ...(offersMaterials
      ? materials.map((candidate) => ({ kind: 'material' as const, candidate }))
      : []),
  ];
  // Filtering shortens the list under the highlight; the pick and the painted
  // row read the same clamped index rather than resetting state mid-typing —
  // the skill menu resolves its own highlight the same way.
  const available = (row: MenuRow) =>
    row.kind === 'course' || materialAttachable(row.candidate.extractionStatus);
  const enabledIndices = rows.flatMap((row, index) => (available(row) ? [index] : []));
  const activeIndex = enabledIndices.includes(highlightedIndex)
    ? highlightedIndex
    : (enabledIndices[0] ?? -1);
  const pickRow = (row: MenuRow | undefined) => {
    if (!row || !available(row)) return;
    if (row.kind === 'course') onPick(row.candidate);
    else onPickMaterial?.(row.candidate);
  };

  // End the window on a whole row (#1880): the section headings and the
  // "showing the first N" lines are not row-sized, so the CSS cap alone can
  // stop halfway through a row. The cap is lowered to the bottom of the last
  // row, heading or line that fits under it.
  const scrollRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const list = scrollRef.current;
    if (!list) return;
    list.style.maxHeight = '';
    const cap = parseFloat(getComputedStyle(list).maxHeight);
    if (!Number.isFinite(cap) || list.scrollHeight <= cap) return;
    const top = list.getBoundingClientRect().top - list.scrollTop;
    let fits = 0;
    for (const block of list.querySelectorAll<HTMLElement>('.ws-cmenu-row, p')) {
      const bottom = block.getBoundingClientRect().bottom - top;
      if (bottom <= cap + 0.5) fits = Math.max(fits, bottom);
    }
    if (fits > 0) list.style.maxHeight = `${fits}px`;
  }, [candidates, materials]);

  // Keep the highlighted row in view: the list scrolls now, so a keyboard walk
  // past the window's edge would otherwise move an invisible highlight.
  useEffect(() => {
    optionRefs.current[activeIndex]?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

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
      // The toolbar search and inline textarea share the same keyboard contract.
      if (!onTextarea && event.target !== searchRef.current) return;
      if (rows.length === 0) return;

      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        event.stopPropagation();
        const direction = event.key === 'ArrowDown' ? 1 : -1;
        const position = enabledIndices.indexOf(activeIndex);
        setHighlightedIndex(
          enabledIndices[(position + direction + enabledIndices.length) % enabledIndices.length] ??
            -1,
        );
        return;
      }

      if (event.key === 'Enter') {
        event.preventDefault();
        event.stopPropagation();
        pickRow(rows[activeIndex]);
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
      aria-label={menuTitle}
      aria-labelledby={titleId}
      className="pro-skill-slash-popover absolute bottom-full left-0 z-30 mb-1.5 w-full max-w-[340px] overflow-hidden rounded-xl border border-border bg-popover shadow-lg"
    >
      <span id={titleId} className="sr-only">
        {menuTitle}
      </span>
      {search ? (
        <div className="p-2">
          <input
            ref={searchRef}
            type="search"
            data-testid="workbench-reference-search"
            aria-label={searchLabel}
            placeholder={searchLabel}
            value={search.query}
            onChange={(event) => search.onChange(event.target.value)}
            className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm outline-none transition-[border-color,box-shadow] focus-visible:border-[color:var(--ws-accent-thread)] focus-visible:shadow-[0_0_0_3px_var(--ws-accent-wash)]"
          />
        </div>
      ) : null}
      <div
        role="listbox"
        aria-labelledby={titleId}
        ref={scrollRef}
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
            {candidates.length > 0 ? (
              <p className="px-3 pb-1 pt-2 text-[10.5px] font-medium text-muted-foreground">
                {t('workspace.courseMention.classrooms')}
                <span className="block font-normal">
                  {t('workspace.courseMention.courseOrder')}
                </span>
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
                        'ws-cmenu-row flex w-full min-w-0 items-center gap-2 px-3 text-left transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50',
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
              <span className="block font-normal">
                {t('workspace.courseMention.materialOrder')}
              </span>
            </p>
            <ul data-testid="workbench-material-all">
              {materials.map((candidate, materialIndex) => {
                const index = candidates.length + materialIndex;
                // Every state is named, so a material not yet extracted and one
                // ready to read look different (RFC #1716 §4).
                const unavailable = !materialAttachable(candidate.extractionStatus);
                const status = t(
                  extractionLabelKey(candidate.extractionStatus, candidate.reasonCode),
                );
                // The folder only when it is in one; nothing, and no separator, at the top level.
                const where = [candidate.folderName, status].filter(Boolean).join(' · ');
                // Why it cannot be picked, in the page's words, and where it can
                // be handled: the knowledge base page, not this menu (#1880).
                // Not `disabled`: a disabled button takes no hover or focus, so
                // it could show no tooltip.
                const label = unavailable
                  ? candidate.reasonCode
                    ? t('workspace.courseMention.materialUnavailableGuidance', {
                        name: candidate.name,
                        guidance: t(
                          `workspace.knowledgeBase.failure.${candidate.reasonCode}.description`,
                          {
                            minutes: MEDIA_MAX_DURATION_SEC / 60,
                          },
                        ),
                      })
                    : t('workspace.courseMention.materialUnavailable', {
                        name: candidate.name,
                        reason: status,
                      })
                  : t('workspace.courseMention.attachMaterial', { name: candidate.name });
                const option = (
                  <button
                    ref={(node) => {
                      optionRefs.current[index] = node;
                    }}
                    type="button"
                    role="option"
                    aria-selected={index === activeIndex}
                    data-highlighted={index === activeIndex ? 'true' : undefined}
                    data-testid={`workbench-material-option-${candidate.materialId}`}
                    title={unavailable ? undefined : label}
                    aria-label={label}
                    aria-disabled={unavailable}
                    onClick={() => pickRow(rows[index])}
                    onMouseEnter={() => {
                      if (!unavailable) setHighlightedIndex(index);
                    }}
                    className={cn(
                      'ws-cmenu-row flex w-full min-w-0 items-center gap-2 px-3 text-left transition-colors hover:bg-muted aria-disabled:cursor-not-allowed aria-disabled:opacity-50',
                      index === activeIndex && 'bg-muted',
                    )}
                  >
                    <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-foreground">
                      {candidate.name}
                    </span>
                    <span className="shrink-0 truncate text-[10.5px] text-muted-foreground">
                      {where}
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
                );
                return (
                  <li key={candidate.materialId}>
                    {unavailable ? (
                      // Why it cannot be picked, on hover and on focus.
                      <Tooltip>
                        <TooltipTrigger asChild>{option}</TooltipTrigger>
                        <TooltipContent side="right" className="max-w-[260px]">
                          {label}
                        </TooltipContent>
                      </Tooltip>
                    ) : (
                      option
                    )}
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
