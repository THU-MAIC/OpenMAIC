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
import { createWorkbenchSession, type WorkbenchMaterial } from '@/lib/workbench/session-store';
import {
  COMPOSER_SEND_ARIA_KEYSHORTCUTS,
  composerKeyEventOf,
  shouldSendComposerKey,
} from '@/lib/workbench/composer-keys';
import {
  AtSignButton,
  AttachButton,
  MaterialChips,
  SkillButton,
  SkillSlashMenu,
  useComposerMaterials,
  useMaterialMentions,
  useMaterialSeed,
  type AgentSkillInfo,
  type ComposerMaterials,
  type MaterialSeed,
} from '@/components/workbench/compose-extras';
import { insertSkillHandle, seedSlashQuery } from '@/lib/workbench/composer-skills';
import { takePromptSeed, type PromptSeed } from '@/lib/workbench/prompt-seed';
import { resolveComposerMenu } from '@/lib/workbench/composer-menus';
import {
  ComposerInput,
  focusComposerWhenShown,
  type ComposerInputHandle,
} from '@/components/workbench/composer-input';
import { useInlineMentions } from '@/components/workbench/use-inline-mentions';
import {
  expandMentions,
  stripMentions,
  type InlineMention,
} from '@/lib/workbench/composer-mentions';
import { ComposerPillRow } from '@/components/workbench/composer-pill';
import { CourseMentionMenu } from '@/components/workbench/course-mention-menu';
import { stagedMaterialOf } from '@/lib/workbench/material-mention';
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

export type { PromptSeed } from '@/lib/workbench/prompt-seed';

/** Stable identity, so the `@` memo does not re-run on every parentless render. */
const NO_COURSE_OPTIONS: readonly CourseMentionSource[] = [];

/** The composer's editable box, by the test id it already carries. */
const PROMPT_TEST_ID = 'pro-launch-prompt';

export function ProLaunchPanel({
  autoFocus = false,
  focusSignal = 0,
  variant = 'default',
  courseOptions = NO_COURSE_OPTIONS,
  onSessionCreated,
  onSessionCreatedAfterLeaving,
  materialSeed,
  onMaterialSeedConsumed,
  promptSeed,
  onPromptSeedConsumed,
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
  /**
   * The conversation was created after this composer left the tree (its POST
   * was in flight). The host decides whether that leaving was the teacher
   * moving on; without it, such an answer is dropped.
   */
  onSessionCreatedAfterLeaving?: (sessionId: string) => void;
  /** A knowledge base hand-over; this composer takes the ones for `home`. */
  materialSeed?: MaterialSeed | null;
  onMaterialSeedConsumed?: (key: number) => void;
  /**
   * An example picked outside the composer (the first-run tour): its text
   * replaces the draft and, with `send`, is sent. Taken once per key, ever (see
   * `lib/workbench/prompt-seed.ts`); the host drops it on `onPromptSeedConsumed`.
   */
  promptSeed?: PromptSeed | null;
  onPromptSeedConsumed?: (key: number) => void;
}) {
  const { t } = useI18n();
  const [prompt, setPrompt] = useState('');
  const [submitting, setSubmitting] = useState(false);
  /** Invalidates a slow create when this panel is reset or sends again. */
  const requestGeneration = useRef(0);
  /** A create is in flight from this composer (see `submit`). */
  const sending = useRef(false);
  /** This panel left the tree: a slow create's answer goes to the host. */
  const left = useRef(false);
  /** The draft an Escape closed the `@` menu on — same rule as the chat composer. */
  const [mentionDismissed, setMentionDismissed] = useState<string | null>(null);
  const inputRef = useRef<ComposerInputHandle | null>(null);

  const focusWhenShown = useCallback(() => focusComposerWhenShown(inputRef, PROMPT_TEST_ID), []);

  useEffect(() => {
    if (autoFocus) return focusWhenShown();
  }, [autoFocus, focusWhenShown]);

  useLayoutEffect(() => {
    left.current = false;
    return () => {
      left.current = true;
    };
  }, []);

  // Durable materials (upload first, referenced at session creation) and
  // the `/` skill menu.
  const materials = useComposerMaterials();
  // Read by the mention hook's drop handler, which is declared before it is.
  useEffect(() => {
    materialsRef.current = materials;
  });
  /**
   * Where the caret goes after a skill handle is written into the draft — the
   * same one-shot DOM instruction the conversation composer uses.
   */
  const pendingCaret = useRef<number | null>(null);
  /**
   * Where the caret is in the box — the other half of both triggers (the token
   * around it is what opens a menu). Reported by `ComposerInput`; the two
   * programmatic moves set it themselves. Same wiring as `WorkbenchChat`.
   */
  const [caret, setCaret] = useState(0);
  const [caretBesideChip, setCaretBesideChip] = useState(false);
  const reportCaret = useCallback((next: number, besideChip: boolean) => {
    setCaret(next);
    setCaretBesideChip(besideChip);
  }, []);
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
  /**
   * The `@` picks, written into the draft as inline mentions; taking one out of
   * the text takes its reference with it.
   */
  const materialsRef = useRef<Pick<ComposerMaterials, 'remove' | 'addExisting'> | null>(null);
  /** What an `@` pick staged, for the undo that brings its chip back. */
  const pickedMaterials = useRef(new Map<string, WorkbenchMaterial>());
  const inlineMentions = useInlineMentions(
    useCallback((dropped: InlineMention) => {
      if (dropped.kind === 'course') {
        setCourseRefs((current) => removeCourseRef(current, dropped.id));
      } else {
        materialsRef.current?.remove(dropped.id);
      }
    }, []),
    useCallback((revived: InlineMention) => {
      if (revived.kind === 'course') {
        const ref = makeCourseRef(revived.id, revived.name);
        if (ref) setCourseRefs((current) => addCourseRef(current, ref));
      } else {
        const material = pickedMaterials.current.get(revived.id);
        if (material) materialsRef.current?.addExisting(material);
      }
    }, []),
  );
  const [mentionOpen, setMentionOpen] = useState(false);
  const [pickerQuery, setPickerQuery] = useState('');
  // One popover at a time, one rule for both composers. The `@` menu's two
  // ways in: the keystroke and the `@` button.
  const {
    menu: openMenu,
    slash,
    mention,
  } = resolveComposerMenu({
    draft: prompt,
    caret,
    caretBesideChip,
    slashDismissedOn: slashDismissed,
    mentionDismissedOn: mentionDismissed,
    courseMenuRequested: mentionOpen,
    // Classrooms, or the knowledge base when materials are enabled.
    courseMenuAvailable: courseOptions.length > 0 || materials.enabled,
  });
  const mentionQuery = mentionOpen ? pickerQuery : (mention?.query ?? '');
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
    inputRef.current?.focus();
  }, [prompt]);
  /** The toolbar opens the same picker with a dedicated search field. */
  const openMention = useCallback(() => {
    inputRef.current?.focus();
    setMentionDismissed(null);
    setPickerQuery('');
    setMentionOpen(true);
  }, []);
  /**
   * What every pick leaves behind. Mid-sentence picks are possible, so the
   * caret goes back to the gap the token left. Same rule as
   * `WorkbenchChat.finishMentionPick`.
   */
  const finishMentionPick = (pick?: Parameters<typeof inlineMentions.add>[3]) => {
    const removal = !mentionOpen && mention ? replaceCourseMention(prompt, mention) : null;
    let next = removal?.draft ?? prompt;
    let nextCaret = removal?.caret ?? inputRef.current?.selectionStart ?? prompt.length;
    // The pick goes into the sentence where the `@` was, as an inline mention.
    const written = pick ? inlineMentions.add(next, nextCaret, nextCaret, pick) : null;
    if (written) {
      next = written.draft;
      nextCaret = written.caret;
    }
    if (next !== prompt) {
      pendingCaret.current = nextCaret;
      setCaret(nextCaret);
      setPrompt(next);
    }
    // The mention just written must not reopen the menu it came from.
    setMentionDismissed(next);
    setMentionOpen(false);
    setSlashDismissed(next);
    inputRef.current?.focus();
  };
  // No conversation yet: nothing is attached, so no row is marked as such.
  const materialMentions = useMaterialMentions({
    open: mentionMenuOpen,
    enabled: materials.enabled,
    query: mentionQuery,
    sessionId: null,
    staged: materials.materials,
  });
  const untitledCourse = t('workspace.untitledCourse');
  const mentionCandidates = useMemo(
    () =>
      !mentionMenuOpen
        ? []
        : orderCourseMentionCandidates({
            query: mentionQuery,
            // No classroom pane on this surface, so the ordering falls through
            // to "recent".
            activeCourseId: null,
            courses: courseOptions,
            referencedIds: courseRefs.map((ref) => ref.stageId),
            untitled: untitledCourse,
          }),
    [courseOptions, courseRefs, mentionQuery, mentionMenuOpen, untitledCourse],
  );
  // A course is only ever named in the text; a material picked from the `@`
  // menu is too, so only uploads keep a pill.
  const pillMaterials = materials.materials.filter(
    (item) => !inlineMentions.has('material', item.materialId),
  );
  const hasComposerExtras =
    pillMaterials.length > 0 || materials.uploading.length > 0 || materials.failed.length > 0;

  /**
   * Write `/skill-name ` into the draft and leave NO menu open behind it. Same
   * function, same discipline as `WorkbenchChat.loadSkill` — an input box is an
   * input box.
   */
  const loadSkill = useCallback((picked: AgentSkillInfo) => {
    // The live selection: the element is the freshest answer either way.
    const at = inputRef.current?.selectionStart ?? null;
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
    inputRef.current?.focus();
    // Same rule as `WorkbenchChat.openSkillMenu`: clear the dismissal, then
    // look at the token — a live one reopens, a missing one gets seeded
    // (normalized, so a word-end caret still yields a real query token).
    setSlashDismissed(null);
    if (slash !== null) return;
    const seed = seedSlashQuery(prompt, inputRef.current?.selectionStart ?? prompt.length);
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
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    input.setSelectionRange(caret, caret);
  }, [prompt]);

  useEffect(() => {
    if (focusSignal === 0) return;
    requestGeneration.current += 1;
    sending.current = false;
    setSubmitting(false);
    replacePrompt('');
    setCourseRefs([]);
    inlineMentions.reset();
    setMentionOpen(false);
    setMentionDismissed(null);
    // Both dismissal memories go with the draft they named.
    setSlashDismissed(null);
    materials.clear();
    const cancelFocus = focusWhenShown();
    return cancelFocus;
    // `materials.clear` is intentionally event-like; depending on its fresh
    // object identity would rerun this reset after every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusSignal]);

  const seedKey = promptSeed?.key;
  useEffect(() => {
    // A seed is an event: taken once per key for the page's lifetime, so a
    // remount of this composer or a second effect run never repeats it.
    if (!promptSeed || !takePromptSeed(promptSeed.key)) return;
    onPromptSeedConsumed?.(promptSeed.key);
    pendingCaret.current = promptSeed.text.length;
    replacePrompt(promptSeed.text);
    setMentionDismissed(null);
    setSlashDismissed(null);
    if (promptSeed.send) void submit(promptSeed.text);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seedKey]);

  // After the reset above: arriving from the knowledge base remounts this
  // composer with a non-zero `focusSignal`, and that reset runs in the same
  // commit -- declared first, it clears before the material is staged.
  // While the material handed over is waiting for the gate, a send would
  // leave without it: the button and Enter (via `submit`) both wait.
  const awaitingMaterial = useMaterialSeed({
    seed: materialSeed,
    targeted: materialSeed?.target.kind === 'home',
    materials,
    onConsumed: onMaterialSeedConsumed,
  });

  // A message needs words of its own, not only mentions; what is sent is the
  // draft with each mention written out in full (the references go as before).
  const hasWords = !!stripMentions(prompt, inlineMentions.mentions);
  const canSend =
    hasWords && !submitting && !materials.busy && !awaitingMaterial && openMenu === null;

  async function submit(seededText?: string) {
    const text = seededText ?? expandMentions(prompt, inlineMentions.mentions);
    const ready = seededText ? !!seededText.trim() : hasWords;
    // `submitting` is render state: two calls before the next render would both
    // read false. The ref is what actually admits one create at a time.
    if (!ready || sending.current || submitting || materials.busy || awaitingMaterial) return;
    sending.current = true;
    setMentionOpen(false);
    setSubmitting(true);
    const generation = ++requestGeneration.current;
    try {
      const session = await createWorkbenchSession({
        prompt: text,
        ...(materials.materials.length ? { materials: materials.materials } : {}),
        ...(courseRefs.length ? { courseRefs } : {}),
      });
      // A create that was overtaken (the composer was reset meanwhile) or whose
      // composer left still made a conversation: hand it to the host, which
      // lists it, rather than dropping it unseen.
      if (requestGeneration.current !== generation || left.current) {
        onSessionCreatedAfterLeaving?.(session.id);
        return;
      }
      if (session.courseRefsAccepted === false) {
        toast.warning(t('workspace.courseMention.notAccepted'));
      }
      onSessionCreated(session.id);
    } catch (error) {
      if (requestGeneration.current !== generation || left.current) return;
      sending.current = false;
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
            title={t('workspace.composer.skillMenuTitle')}
            onPick={loadSkill}
            onDismiss={closeSkillMenu}
          />
        ) : null}
        {mentionMenuOpen ? (
          // The same picker the conversation composer opens, on the same one
          // entry point (the `@` keystroke).
          <CourseMentionMenu
            id={mentionMenuId}
            search={mentionOpen ? { query: pickerQuery, onChange: setPickerQuery } : undefined}
            candidates={mentionCandidates}
            onClose={closeMention}
            onPick={(candidate) => {
              const ref = makeCourseRef(candidate.stageId, candidate.title);
              if (!ref) return finishMentionPick();
              setCourseRefs((current) => addCourseRef(current, ref));
              finishMentionPick({ kind: 'course', id: ref.stageId, name: ref.title });
            }}
            // A knowledge-base pick stages one more pill, attached when the
            // conversation starts -- the same rule as the conversation composer.
            materials={materialMentions}
            onPickMaterial={(candidate) => {
              const staged = stagedMaterialOf(candidate);
              const outcome = materials.addExisting(staged);
              pickedMaterials.current.set(staged.materialId, staged);
              finishMentionPick(
                outcome === 'staged' || outcome === 'already'
                  ? { kind: 'material', id: staged.materialId, name: staged.name }
                  : undefined,
              );
            }}
          />
        ) : null}
        {hasComposerExtras ? (
          <ComposerPillRow className="px-3 pb-0 pt-2">
            <MaterialChips
              inline
              materials={pillMaterials}
              uploading={materials.uploading}
              failed={materials.failed}
              onRemove={materials.remove}
              onRemoveFailed={materials.removeFailed}
              extraction={materials.extraction}
              onRetryFailed={materials.retryFailed}
              onRetryExtraction={materials.retryExtraction}
            />
          </ComposerPillRow>
        ) : null}
        <ComposerInput
          inputRef={inputRef}
          testId={PROMPT_TEST_ID}
          value={prompt}
          readOnly={submitting}
          onCaretChange={reportCaret}
          mentions={inlineMentions.mentions}
          onMentionRestored={inlineMentions.revive}
          onValueChange={(text) => {
            setPrompt(text);
            inlineMentions.afterEdit(text);
          }}
          onPaste={(event) => {
            if (submitting || !materials.enabled || !event.clipboardData) return;
            const images = composerImagesFromClipboard(event.clipboardData);
            if (images.length === 0) return;
            event.preventDefault();
            materials.addFiles(images);
          }}
          onKeyDown={(e) => {
            if (submitting) return;
            if (openMenu === 'skill') return; // a slash query is menu navigation, not a submit
            if (mentionMenuOpen) return; // …and so does the `@` course menu
            if (!shouldSendComposerKey(composerKeyEventOf(e))) return;
            e.preventDefault();
            submit();
          }}
          rows={2}
          ariaKeyShortcuts={COMPOSER_SEND_ARIA_KEYSHORTCUTS}
          placeholder={t('workspace.composer.launchPlaceholder')}
          className={cn(
            'max-h-[260px] w-full text-[14px] leading-relaxed',
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
            label={t('workspace.composer.attach')}
            onFiles={materials.addFiles}
          />
          {/* Shown exactly when the menu can open: classrooms to name, or the
              knowledge base to pick from. */}
          {courseOptions.length > 0 || materials.enabled ? (
            <AtSignButton
              testId="pro-launch-mention-button"
              disabled={submitting}
              label={t(
                materials.enabled
                  ? 'workspace.composer.mentionCourseOrMaterial'
                  : 'workspace.composer.mentionCourse',
              )}
              onClick={openMention}
            />
          ) : null}
          <SkillButton
            testId="pro-launch-skill"
            disabled={submitting}
            label={t('workspace.composer.loadSkill')}
            onClick={openSkillMenu}
          />
          <div className="flex-1" />
          <ProLaunchSend canSend={canSend} onSubmit={() => void submit()} />
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
      aria-label={t('workspace.composer.launchSend')}
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
