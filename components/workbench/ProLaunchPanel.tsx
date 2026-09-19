'use client';

/**
 * The Pro launch face — the back of the homepage card.
 *
 * The design lineage is the spike's S7→S9 subtraction, and what survives here
 * is deliberately little: ONE composer. No headline
 * (the wordmark above the card is the headline — a second one was the
 * two-stacked-headlines problem), no search toggle (the agent decides when to
 * search; a capability the user cannot predict is not a control). The composer
 * also carries attachment, course-reference, and skill-menu affordances.
 *
 * Submitting creates the session here and opens it in `/workspace`. This is the
 * only launch composer, so an intermediate route would only duplicate its
 * draft, attachment and error handling.
 *
 * The rules, since the next person will want to add something:
 *  1. One visual focus, and one border — the composer IS the card.
 *  2. A control states itself or it is an icon; a question the user cannot
 *     answer yet is not a control at all.
 *  3. Prose is not a feature. The agent's first chat message answers "what
 *     will this do" better, in the place where it matters.
 */
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowUp } from 'lucide-react';
import { toast } from 'sonner';
import { useI18n } from '@/lib/hooks/use-i18n';
import { cn } from '@/lib/utils/cn';
import {
  composerImagesFromClipboard,
  composerImagesFromDrop,
  composerTransferHasImages,
} from '@/lib/workbench/composer-image-transfer';
import { createWorkbenchSession } from '@/lib/workbench/session-store';
import {
  COMPOSER_SEND_ARIA_KEYSHORTCUTS,
  shouldSendComposerKey,
} from '@/lib/workbench/composer-keys';
import {
  AtSignButton,
  AttachButton,
  MaterialChips,
  SkillButton,
  SkillSlashMenu,
  useComposerMaterials,
  type AgentSkillInfo,
} from '@/components/workbench/compose-extras';
import { insertSkillHandle, seedSlashQuery } from '@/lib/workbench/composer-skills';
import { resolveComposerMenu } from '@/lib/workbench/composer-menus';
import { useSkillHandleBackspace } from '@/components/workbench/use-skill-handle-backspace';
import { ComposerTextarea } from '@/components/workbench/composer-input';
import { ComposerPillRow } from '@/components/workbench/composer-pill';
import { CourseMentionMenu } from '@/components/workbench/course-mention-menu';
import { CourseRefPills } from '@/components/workbench/course-ref-pills';
import {
  orderCourseMentionCandidates,
  replaceCourseMention,
  type CourseMentionSource,
} from '@/lib/workbench/course-mention';
import {
  addCourseRef,
  makeCourseRef,
  removeCourseRef,
  type CourseRef,
} from '@/lib/workbench/course-refs';

/** Stable identity, so the `@` memo does not re-run on every parentless render. */
const NO_COURSE_OPTIONS: readonly CourseMentionSource[] = [];

export function ProLaunchPanel({
  autoFocus = false,
  focusSignal = 0,
  variant = 'default',
  courseOptions = NO_COURSE_OPTIONS,
  onSessionCreated,
}: {
  autoFocus?: boolean;
  /** Increment to clear the draft/attachments and focus this existing composer. */
  focusSignal?: number;
  variant?: 'default' | 'workspace';
  /**
   * What the `@` picker may name, newest first — the workspace's own course list,
   * handed down rather than fetched here (the shell already has it).
   *
   * Empty means no picker at all: `@` with nothing to offer is a menu that only
   * ever says "no matches". There is deliberately no `activeCourseId` or session
   * scope on this surface — the home face has no classroom pane beside it and no
   * conversation yet, so the ordering degrades to "recent, newest first" on its
   * own rather than through a special case.
   */
  courseOptions?: readonly CourseMentionSource[];
  /** Opens the new conversation through the workspace's client-owned pane controller. */
  onSessionCreated: (sessionId: string) => void;
}) {
  const { t } = useI18n();
  const [prompt, setPrompt] = useState('');
  const [submitting, setSubmitting] = useState(false);
  /** Invalidates a slow create when this panel is reset or leaves the tree. */
  const requestGeneration = useRef(0);
  /** The draft an Escape closed the `@` menu on — same rule as the chat composer. */
  const [mentionDismissed, setMentionDismissed] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (autoFocus) textareaRef.current?.focus();
  }, [autoFocus]);

  useLayoutEffect(
    () => () => {
      requestGeneration.current += 1;
    },
    [],
  );

  // The textarea grows with its content instead of scrolling at a fixed
  // height: a composer that starts as two lines and becomes six is the whole
  // reason this surface can be a single card.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 260)}px`;
  }, [prompt]);

  // Durable materials (upload first, referenced at session creation) and
  // the `/` skill menu.
  const materials = useComposerMaterials();
  /**
   * Where the caret goes after a skill handle is written into the draft — the
   * same one-shot DOM instruction the conversation composer uses.
   */
  const pendingCaret = useRef<number | null>(null);
  /**
   * Where the caret is in the box — the other half of both triggers (the token
   * around it is what opens a menu). Reported by `ComposerTextarea`; the two
   * programmatic moves set it themselves. Same wiring as `WorkbenchChat`.
   */
  const [caret, setCaret] = useState(0);
  /**
   * Put text in the box, caret at its end. Same one door as `WorkbenchChat`, for
   * the same reason: the draft and the caret the triggers read must never describe
   * two different states.
   */
  const replacePrompt = useCallback((text: string) => {
    setPrompt(text);
    setCaret(text.length);
  }, []);
  /** Mirrors `mentionDismissed`: see `WorkbenchChat` for why a pick needs it. */
  const [slashDismissed, setSlashDismissed] = useState<string | null>(null);
  /**
   * Classrooms named for this first message.
   *
   * Local state, not the owner-fenced refs store: that store exists because the
   * element picker lives on the other side of the workspace and two conversations
   * must never see each other's drafts. This composer is one instance with no
   * conversation behind it yet, so there is nothing to fence it against. The
   * refs are sent with session creation.
   */
  const [courseRefs, setCourseRefs] = useState<readonly CourseRef[]>([]);
  const [mentionOpen, setMentionOpen] = useState(false);
  // One popover at a time, one rule for both composers. The `@` menu's two
  // ways in: the keystroke and the `@` button.
  const {
    menu: openMenu,
    slash,
    mention,
  } = resolveComposerMenu({
    draft: prompt,
    caret,
    slashDismissedOn: slashDismissed,
    mentionDismissedOn: mentionDismissed,
    courseMenuRequested: mentionOpen,
    courseMenuAvailable: courseOptions.length > 0,
  });
  const mentionMenuOpen = openMenu === 'course';
  const mentionMenuId = useId();
  /**
   * Every way out of the picker, in one place — Escape, a press outside it, a
   * pick, a submit. Closing never touches the draft; it only stops the `@` token
   * already in it from reopening what was dismissed.
   */
  const closeMention = useCallback(() => {
    setMentionOpen(false);
    setMentionDismissed(prompt);
    textareaRef.current?.focus();
  }, [prompt]);
  /** The `@` button's way in. Focus first: the picker's keys live on the textarea. */
  const openMention = useCallback(() => {
    textareaRef.current?.focus();
    setMentionDismissed(null);
    setMentionOpen(true);
  }, []);
  const untitledCourse = t('workspace.untitledCourse');
  const mentionCandidates = useMemo(
    () =>
      !mentionMenuOpen
        ? []
        : orderCourseMentionCandidates({
            query: mention?.query ?? '',
            // No classroom pane on this surface, so the ordering falls through
            // to "recent".
            activeCourseId: null,
            courses: courseOptions,
            referencedIds: courseRefs.map((ref) => ref.stageId),
            untitled: untitledCourse,
          }),
    [courseOptions, courseRefs, mention?.query, mentionMenuOpen, untitledCourse],
  );
  const hasComposerExtras =
    courseRefs.length > 0 ||
    materials.materials.length > 0 ||
    materials.uploading.length > 0 ||
    materials.failed.length > 0;

  /**
   * Write `/skill-name ` into the draft and leave NO menu open behind it. Same
   * function, same discipline as `WorkbenchChat.loadSkill` — an input box is an
   * input box.
   */
  const onSkillHandleBackspace = useSkillHandleBackspace(setPrompt, (next) => {
    pendingCaret.current = next;
    setCaret(next);
  });
  const loadSkill = useCallback((picked: AgentSkillInfo) => {
    // The live selection: the element is the freshest answer either way.
    const at = textareaRef.current?.selectionStart ?? null;
    setPrompt((current) => {
      const next = insertSkillHandle(current, picked.name, at ?? current.length);
      pendingCaret.current = next.caret;
      setCaret(next.caret);
      setMentionOpen(false);
      setMentionDismissed(next.draft);
      setSlashDismissed(next.draft);
      return next.draft;
    });
  }, []);
  /**
   * The skill button's way in — same shape as `WorkbenchChat.openSkillMenu`:
   * seed a `/` at the caret and the menu machinery opens the slash menu over
   * the input with the full list.
   */
  const openSkillMenu = useCallback(() => {
    textareaRef.current?.focus();
    // Same rule as `WorkbenchChat.openSkillMenu`: clear the dismissal, then
    // look at the token — a live one reopens, a missing one gets seeded
    // (normalized, so a word-end caret still yields a real query token).
    setSlashDismissed(null);
    if (slash !== null) return;
    const seed = seedSlashQuery(prompt, textareaRef.current?.selectionStart ?? prompt.length);
    if (!seed) return;
    pendingCaret.current = seed.caret;
    setCaret(seed.caret);
    setPrompt(seed.draft);
  }, [prompt, slash]);
  /** The slash menu's one exit — mirrors `closeMention` (see `WorkbenchChat`). */
  const closeSkillMenu = useCallback(() => {
    setSlashDismissed(prompt);
  }, [prompt]);

  useEffect(() => {
    const caret = pendingCaret.current;
    if (caret === null) return;
    pendingCaret.current = null;
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.focus();
    textarea.setSelectionRange(caret, caret);
  }, [prompt]);

  useEffect(() => {
    if (focusSignal === 0) return;
    requestGeneration.current += 1;
    setSubmitting(false);
    replacePrompt('');
    setCourseRefs([]);
    setMentionOpen(false);
    setMentionDismissed(null);
    // Both dismissal memories go with the draft they named.
    setSlashDismissed(null);
    materials.clear();
    textareaRef.current?.focus();
    // `materials.clear` is intentionally event-like; depending on its fresh
    // object identity would rerun this reset after every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusSignal]);

  const canSend = !!prompt.trim() && !submitting && !materials.busy && openMenu === null;

  async function submit() {
    const text = prompt.trim();
    if (!text || submitting || materials.busy) return;
    setMentionOpen(false);
    setSubmitting(true);
    const generation = ++requestGeneration.current;
    try {
      const session = await createWorkbenchSession({
        prompt: text,
        ...(materials.materials.length ? { materials: materials.materials } : {}),
        ...(courseRefs.length ? { courseRefs } : {}),
      });
      if (requestGeneration.current !== generation) return;
      if (session.courseRefsAccepted === false) {
        toast.warning(t('workspace.courseMention.notAccepted'));
      }
      onSessionCreated(session.id);
    } catch (error) {
      if (requestGeneration.current !== generation) return;
      toast.error(error instanceof Error ? error.message : t('workbench.launch.createFailed'));
      setSubmitting(false);
    }
  }

  return (
    <div data-testid="pro-launch-panel" className="flex w-full flex-col gap-3 text-left">
      {/* ── The composer. It is the card: one border on this whole surface. ──
          Chrome mirrors the classic face's card so the two sides read as one
          object; the violet seam is the only Pro tell. */}
      <div
        // The face the Pro swap turns over (see `lib/workbench/pro-swap.ts` and
        // `components/workbench/pro-swap.css`). Named here rather than on
        // `WorkspaceHome`'s wrapper so the entrance animation on that wrapper is
        // never part of the captured snapshot, and only for the workspace
        // variant: `/`'s composer names itself, because there the card belongs
        // to the classic page rather than to this component.
        data-pro-morph={variant === 'workspace' ? 'composer' : undefined}
        className={cn(
          'relative',
          variant === 'workspace'
            ? // `ws-composer` (components/workbench/workspace-shell.css, loaded
              // by WorkspaceShell) carries the whole treatment: the classic
              // face's chrome — rounded-2xl, hairline border, translucent
              // surface over a blur — with a layered shadow and a focused
              // state that draws a violet thread and lifts the card 1px.
              'ws-composer'
            : [
                'rounded-2xl border backdrop-blur-xl transition-colors',
                'bg-white/80 shadow-xl shadow-violet-500/[0.07] dark:bg-slate-900/80',
                'border-violet-300/50 focus-within:border-violet-400/70 dark:border-violet-400/25',
              ],
        )}
        onDragOver={(event) => {
          if (!materials.enabled || !composerTransferHasImages(event.dataTransfer)) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = submitting ? 'none' : 'copy';
        }}
        onDrop={(event) => {
          if (!materials.enabled) return;
          const images = composerImagesFromDrop(event.dataTransfer);
          if (images.length === 0) return;
          event.preventDefault();
          if (submitting) return;
          materials.addFiles(images);
        }}
      >
        {openMenu === 'skill' && slash !== null ? (
          <SkillSlashMenu
            key={slash}
            filter={slash}
            title={t('proMode.skillMenuTitle')}
            onPick={loadSkill}
            onDismiss={closeSkillMenu}
          />
        ) : null}
        {mentionMenuOpen ? (
          // The same picker the conversation composer opens, on the same one
          // entry point (the `@` keystroke).
          <CourseMentionMenu
            id={mentionMenuId}
            candidates={mentionCandidates}
            onClose={closeMention}
            onPick={(candidate) => {
              const ref = makeCourseRef(candidate.stageId, candidate.title);
              if (ref) setCourseRefs((current) => addCourseRef(current, ref));
              // Mid-sentence picks are possible now, so the caret goes back to
              // the gap the token left. Same rule as `WorkbenchChat.pickMention`.
              const removal = mention ? replaceCourseMention(prompt, mention) : null;
              if (removal) {
                pendingCaret.current = removal.caret;
                setCaret(removal.caret);
                setPrompt(removal.draft);
              }
              setMentionDismissed(null);
              setMentionOpen(false);
              setSlashDismissed(removal?.draft ?? prompt);
            }}
          />
        ) : null}
        {hasComposerExtras ? (
          <ComposerPillRow className="px-3 pb-0 pt-2">
            <MaterialChips
              inline
              materials={materials.materials}
              uploading={materials.uploading}
              failed={materials.failed}
              onRemove={materials.remove}
              onRemoveFailed={materials.removeFailed}
            />
            <CourseRefPills
              inline
              refs={courseRefs}
              onRemove={(stageId) => setCourseRefs((current) => removeCourseRef(current, stageId))}
            />
          </ComposerPillRow>
        ) : null}
        {/* The mirror layer under it draws `/handle` runs as inline pills — see
            `composer-input`. Both layers take THIS `className`, so the two
            variants' different paddings can never desynchronise. */}
        <ComposerTextarea
          textareaRef={textareaRef}
          data-testid="pro-launch-prompt"
          mirrorTestId="pro-launch-prompt-mirror"
          // Not "somewhere else" — see `CourseMentionMenu`'s outside press.
          data-mention-keep-open=""
          value={prompt}
          readOnly={submitting}
          onCaretChange={setCaret}
          onChange={(e) => setPrompt(e.target.value)}
          onPaste={(event) => {
            if (submitting || !materials.enabled) return;
            const images = composerImagesFromClipboard(event.clipboardData);
            if (images.length === 0) return;
            event.preventDefault();
            materials.addFiles(images);
          }}
          onKeyDown={(e) => {
            if (submitting) return;
            if (onSkillHandleBackspace(e)) return;
            if (openMenu === 'skill') return; // a slash query is menu navigation, not a submit
            if (mentionMenuOpen) return; // …and so does the `@` course menu
            if (!shouldSendComposerKey(e)) return;
            e.preventDefault();
            submit();
          }}
          rows={2}
          aria-keyshortcuts={COMPOSER_SEND_ARIA_KEYSHORTCUTS}
          placeholder={t('proMode.launchPlaceholder')}
          className={cn(
            'w-full resize-none bg-transparent text-[14px] leading-relaxed outline-none placeholder:text-muted-foreground/40',
            // The workspace composer is the page's centrepiece, so it gets the
            // room to look like one; the classic face stays as it was.
            variant === 'workspace'
              ? cn('px-5 pb-2', hasComposerExtras ? 'pt-2' : 'pt-[18px]')
              : cn('px-4 pb-4', hasComposerExtras ? 'pt-2' : 'pt-4'),
          )}
        />

        <div
          className={cn(
            'flex items-center gap-1',
            variant === 'workspace' ? 'px-4 pb-3.5' : 'px-3 pb-3',
          )}
        >
          {/* Three glyphs: a file, a classroom, a skill (ZCode-shaped — the
              skill pick lands in the box as `/handle` text). */}
          <AttachButton
            testId="pro-launch-attach"
            disabled={submitting}
            label={t('proMode.attach')}
            onFiles={materials.addFiles}
          />
          {courseOptions.length > 0 ? (
            <AtSignButton
              testId="pro-launch-mention-button"
              disabled={submitting}
              label={t('proMode.mentionCourse')}
              onClick={openMention}
            />
          ) : null}
          <SkillButton
            testId="pro-launch-skill"
            disabled={submitting}
            label={t('proMode.loadSkill')}
            onClick={openSkillMenu}
          />
          <div className="flex-1" />
          <ProLaunchSend canSend={canSend} onSubmit={submit} />
        </div>
      </div>
    </div>
  );
}

function ProLaunchSend({ canSend, onSubmit }: { canSend: boolean; onSubmit: () => void }) {
  const { t } = useI18n();

  return (
    <button
      type="button"
      data-testid="pro-launch-start"
      aria-label={t('proMode.launchSend')}
      onClick={onSubmit}
      // No outside-press exemption here, unlike the chat composer's send:
      // `canSend` includes `openMenu === null`, so this button is DISABLED
      // while a menu is open (and disabled controls take no pointer events)
      // — the refusal is structural, and an unreachable exemption attribute
      // would only suggest a mechanism that is not the one working.
      disabled={!canSend}
      className={cn(
        'inline-flex size-8 items-center justify-center rounded-lg transition-all duration-200',
        canSend
          ? 'bg-violet-600 text-white shadow-sm shadow-violet-600/25 hover:opacity-90'
          : 'bg-muted text-muted-foreground/40',
      )}
    >
      <ArrowUp className="size-[17px]" />
    </button>
  );
}
