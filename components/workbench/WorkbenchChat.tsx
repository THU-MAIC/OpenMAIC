'use client';

/**
 * WorkbenchChat — the Pro workbench conversation, and (until the first page
 * lands) the whole surface.
 *
 * The visual system is the OpenPBL kimi-chat vocabulary adapted to a
 * single-agent surface; see `chat/workbench-chat.css` for the token mapping
 * and `chat/chat-timeline.tsx` for the layout rules.
 *
 * The composer never closes: the session is a conversation, and a run ending
 * (succeeded/failed/cancelled) just means the agent is listening again.
 * Every submit goes to `POST /messages`, steered into a live run, or
 * driving a new run on an idle session. An `ask_user` question card's answer is
 * the same submit with the option's label as its text — the answer protocol is
 * "the next user message" and nothing more. While a question is UNANSWERED the
 * composer is TAKEN OVER by its form (`chat/question-form.tsx`): the run ended on
 * `ask_user`, so there is nothing to type into until it is answered, and its
 * transcript row is at the bottom of a long log and easy to scroll past. The
 * dismiss control hands the box back — the question stays open, the form just stops holding it
 * (`dismissedQuestionKey` below), and the transcript card offers the way back.
 * While a run is live the composer
 * shows STOP (POST cancel) instead of send; that ends the run, never the
 * session. Enter still barges in.
 * Send/cancel failures surface as a sonner toast, not inline chrome.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { ArrowDown, Loader2, Send, Square } from 'lucide-react';
import { toast } from 'sonner';
import { useI18n } from '@/lib/hooks/use-i18n';
import { WORKBENCH_CHAT_MIN_PX } from '@/lib/edit/contain-box';
import { cn } from '@/lib/utils/cn';
import {
  useElementRefsForSession,
  useElementRefsOwnerLifecycle,
  useElementRefsStore,
} from '@/lib/store/element-refs';
import {
  useCourseRefsForSession,
  useCourseRefsOwnerLifecycle,
  useCourseRefsStore,
} from '@/lib/store/course-refs';
import type { ElementRef } from '@/lib/workbench/element-refs';
import { makeCourseRef, type CourseRef } from '@/lib/workbench/course-refs';
import {
  orderCourseMentionCandidates,
  replaceCourseMention,
  type CourseMentionCandidate,
} from '@/lib/workbench/course-mention';
import {
  useWorkbenchCourseNavigation,
  useWorkbenchDraftConversation,
} from '@/lib/workbench/panel-context';
import { ComposerTextarea } from './composer-input';
import { ComposerPillRow } from './composer-pill';
import { ElementRefPills } from './element-ref-pills';
import { CourseRefPills } from './course-ref-pills';
import { CourseMentionMenu } from './course-mention-menu';
import {
  composerImagesFromClipboard,
  composerImagesFromDrop,
  composerTransferHasImages,
} from '@/lib/workbench/composer-image-transfer';
import {
  cancelWorkbenchSession,
  postWorkbenchMessage,
  recoverTerminalCancelStatus,
  useWorkbenchStore,
  type ChatNode,
  type PlannedPage,
  type SessionStatus,
  type WorkbenchMaterial,
} from '@/lib/workbench/session-store';
import {
  AtSignButton,
  AttachButton,
  MaterialChips,
  SkillButton,
  SkillSlashMenu,
  useComposerMaterials,
  type AgentSkillInfo,
} from './compose-extras';
import { insertSkillHandle, seedSlashQuery } from '@/lib/workbench/composer-skills';
import { useSkillHandleBackspace } from './use-skill-handle-backspace';
import { resolveComposerMenu } from '@/lib/workbench/composer-menus';
import {
  isComposerLive,
  shouldPromptForRefInstruction,
  shouldDropPendingSend,
  shouldDropPendingStop,
} from './chat/composer-send-state';
import {
  COMPOSER_SEND_ARIA_KEYSHORTCUTS,
  shouldSendComposerKey,
} from '@/lib/workbench/composer-keys';
import { useDoubleEscapeStop } from './chat/composer-escape';
import { useWorkbenchAutoscroll } from './chat/autoscroll';
import { composerLayout, wbStyles as styles } from './chat/chat-styles';
import { ChatTimeline } from './chat/chat-timeline';
import { pendingQuestion } from './chat/question-card-state';
import { QuestionForm } from './chat/question-form';
import { composerTakeover } from './chat/question-form-state';
import { shouldShowWorkbenchEmptyState, WorkbenchChatEmptyState } from './chat/empty-state';
import { invalidateAgentSkills } from '@/lib/workbench/agent-skills';
import { settleSentElementRefs } from '@/lib/workbench/element-ref-send-result';
import { settleSentCourseRefs } from '@/lib/workbench/course-ref-send-result';

const NO_ELEMENT_REFS: ElementRef[] = [];
const NO_COURSE_REFS: CourseRef[] = [];

export function WorkbenchChat({
  hosted = false,
  adjacentPanelOpen = false,
}: {
  /**
   * Rendered inside the workspace's conversation pane, which supplies the
   * header, the collapse and the way back to everything else. The chat then
   * carries none of its own navigation — a second back arrow floating over
   * the transcript would point somewhere the navigation tree already is.
   */
  hosted?: boolean;
  /**
   * Actual workspace layout, supplied by the shell. The attached conversation
   * fold briefly starts from its initial `panelOpen` value whenever Chat
   * changes, so a hosted chat must not use that value to size its transcript.
   */
  adjacentPanelOpen?: boolean;
}) {
  const { t } = useI18n();
  const sessionId = useWorkbenchStore((s) => s.sessionId);
  /**
   * No conversation yet — the workspace is showing an empty composer and the
   * session will be minted by the first message (see
   * `lib/workbench/first-message-session`). Everything below treats this as a
   * conversation that simply has no id yet: the composer is live, drafts are
   * staged against `composerOwnerId`, and `submit` routes through `start`.
   */
  const draftConversation = useWorkbenchDraftConversation();
  const composerOwnerId = sessionId ?? draftConversation?.ownerKey ?? null;
  const canSend = sessionId !== null || draftConversation !== null;
  const chat = useWorkbenchStore((s) => s.chat);
  const replaying = useWorkbenchStore((s) => s.replaying);
  const status = useWorkbenchStore((s) => s.status);
  const plan = useWorkbenchStore((s) => s.plan);
  const panelOpen = useWorkbenchStore((s) => s.panelOpen);
  const effectivePanelOpen = hosted ? adjacentPanelOpen : panelOpen;
  /**
   * Is this pane waiting for a conversation's log?
   *
   * NOT the store's raw `replaying`. A pane holding a DRAFT conversation has no
   * session yet — the first message creates it — so there is nothing to catch up
   * to, and the stream hook that would eventually clear `replaying` never runs
   * without a session id.
   *
   * The `sessionId === null` term covers a deep link's first render, before the
   * store has attached to the id already present in workspace state.
   */
  const catchingUp = !draftConversation && (replaying || sessionId === null);
  /**
   * Switching conversations rebuilds the attached fold from its event log. The
   * old implementation replaced the whole transcript with a blank, centred
   * spinner for that interval; when chat owned the wide column this read as a
   * full-screen flash. Keep the last settled transcript painted but inert until
   * the next fold is ready. An initial deep link still gets the ordinary loader
   * because there is no previous content to retain.
   */
  const settledTranscriptRef = useRef<{
    readonly chat: ChatNode[];
    readonly plan: PlannedPage[];
  } | null>(null);
  useEffect(() => {
    if (catchingUp) return;
    settledTranscriptRef.current = { chat, plan };
  }, [catchingUp, chat, plan]);
  const retainedTranscript = catchingUp ? settledTranscriptRef.current : null;
  const displayedChat = retainedTranscript?.chat ?? chat;
  const displayedPlan = retainedTranscript?.plan ?? plan;

  const [draft, setDraft] = useState('');
  /**
   * Where the caret is in the box.
   *
   * Both triggers read the token AROUND it (`lib/workbench/composer-tokens`), so
   * this is half of what decides whether a menu is open — which is why it is state
   * and not a ref: it has to re-render the menu. `ComposerTextarea` reports it on
   * every way it can move, and the two paths that move it programmatically (a
   * skill insertion, an `@` token spliced out) set it themselves.
   */
  const [caret, setCaret] = useState(0);
  /**
   * Put text in the box, caret at its end — the ONE door for a write that replaces
   * the whole draft (cleared on send, restored when the send is refused).
   *
   * The pair has to move together: `caret` is what both triggers read the token
   * around, so a draft swapped in under a caret that belongs to the previous one
   * can open a menu the user never asked for — a restored `/handle …` message with
   * the caret still at 0 would pop the skill menu open over the failure toast.
   */
  const replaceDraft = useCallback((text: string) => {
    setDraft(text);
    setCaret(text.length);
  }, []);
  /**
   * The draft each popover was last dismissed on. Two of them because the two
   * menus are dismissed independently; both feed the ONE rule that decides which
   * is open (`resolveComposerMenu`).
   *
   * `slashDismissed` exists because splicing an `@` token out can leave a bare
   * `/handle` behind — pick a course out of `/stage-design @course` and the draft
   * becomes `/stage-design`, a live slash query — and finishing with one menu must
   * never open the other.
   */
  const [slashDismissed, setSlashDismissed] = useState<string | null>(null);
  /**
   * The draft an Escape closed the `@` menu on. Typing anything else reopens it,
   * which is the same "not now, and only for this exact query" the skill menu's
   * own dismissal has — a permanent per-session mute would be a setting nobody
   * asked for and nobody could find again.
   */
  const [mentionDismissed, setMentionDismissed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /**
   * Where the caret goes after a skill handle is written into the draft, applied
   * once the controlled textarea has rendered the new value. A ref, not state:
   * it is a one-shot instruction to the DOM, not something anything renders.
   */
  const pendingCaret = useRef<number | null>(null);
  // Optimistic send: the composer must show STOP the instant send is pressed,
  // not when the runner's next claim scan surfaces `session_resumed` in the
  // fold. `pendingSend` bridges that gap; `sendStartedStatus` is the fold
  // status at send time, and the effect below drops the flag the moment the
  // fold moves off it (the runner confirmed, or a terminal `session_end`
  // settled the send) — or the POST failure path clears it directly.
  const [pendingSend, setPendingSend] = useState(false);
  const sendStartedStatus = useRef<SessionStatus | null>(null);
  /**
   * The one question whose form the user waved off, by node key. Local and
   * deliberately shallow: it is a "not now", not an answer, so nothing about it
   * is persisted and nothing about the question changes. Keying it by node means
   * a NEW question takes the composer over again on its own — there is no flag to
   * remember to reset.
   */
  const [dismissedQuestionKey, setDismissedQuestionKey] = useState<string | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  // The mirror flag for stop: `POST /cancel` answers 202 ("asked"), and the run
  // only actually ends when the loop notices between steps — after the tool in
  // flight returns, which can be tens of seconds. Without this the button just
  // sat there and stopping read as broken.
  const [pendingStop, setPendingStop] = useState(false);
  // Durable material assets can be attached mid-conversation too.
  const materials = useComposerMaterials();
  // Slide elements the user pointed at on the canvas (the edit dock's lasso).
  // The staging lives in its own store because the picker is on the other side
  // of the workspace; this surface only reads it and clears it on send.
  useElementRefsOwnerLifecycle(composerOwnerId);
  const elementRefs = useElementRefsForSession(composerOwnerId);
  // The courses the user named with `@` for THIS turn. Same owner-fenced draft
  // discipline as the element refs above, and the same lifecycle owner: this
  // component. The classroom pane never writes it — the whole point of the
  // mention is that the agent is told, not that it infers from what is open.
  useCourseRefsOwnerLifecycle(composerOwnerId);
  const courseRefs = useCourseRefsForSession(composerOwnerId);
  const refreshedCreateCalls = useRef(new Set<string>());

  // The durable completed tool node is the source of truth: replay and a live
  // stream take the same path, and each tool call invalidates the shared
  // registry at most once even though several composer surfaces consume it.
  useEffect(() => {
    for (const node of chat) {
      if (
        node.kind !== 'tool' ||
        node.toolName !== 'create_skill' ||
        node.toolState !== 'done' ||
        !node.toolDetails ||
        refreshedCreateCalls.current.has(node.key)
      ) {
        continue;
      }
      refreshedCreateCalls.current.add(node.key);
      void invalidateAgentSkills().catch(() => {
        // The durable success card remains the receipt. Menus expose their own
        // retry state if this refresh fails.
      });
    }
  }, [chat]);

  const { scrollRef, contentRef, isNearBottom, scrollToBottom } =
    useWorkbenchAutoscroll(displayedChat);
  // How to put a classroom on screen. There is deliberately no derived list of
  // "the classrooms this conversation is involved with" any more: a classroom is
  // picked per answer, and what an answer touched is a row in the transcript
  // (`lib/workbench/run-courses`), not a standing property of the chat.
  const navigation = useWorkbenchCourseNavigation();
  /**
   * The classroom picker: one menu, ONE open state, two ways in.
   *
   * Typing `@` opens it on the token in the draft (`mention`); the `@` BUTTON
   * (between attach and skill) opens it with no token at all (`mentionOpen`).
   * Both feed `mentionMenuOpen`, and every way out goes through `closeMention`
   * — Escape, a press outside the menu, picking a row, sending, and switching
   * conversation.
   *
   * Closing NEVER touches the draft: `mentionDismissed` remembers the text the
   * menu was dismissed on, so the same `@` token does not immediately reopen it,
   * and typing anything else brings it back.
   */
  const [mentionOpen, setMentionOpen] = useState(false);
  const {
    menu: openMenu,
    slash,
    mention,
  } = resolveComposerMenu({
    draft,
    caret,
    slashDismissedOn: slashDismissed,
    mentionDismissedOn: mentionDismissed,
    courseMenuRequested: mentionOpen,
    // The `@` keystroke and the `@` button hold the same bar: no courses to
    // name means no menu at all, not an empty one.
    courseMenuAvailable: (navigation?.courseOptions?.length ?? 0) > 0,
  });
  const mentionQuery = mention?.query ?? null;
  const mentionMenuOpen = openMenu === 'course';
  const mentionMenuId = useId();
  const untitledCourse = t('workspace.untitledCourse');
  const mentionCandidates = useMemo(
    () =>
      !mentionMenuOpen
        ? []
        : orderCourseMentionCandidates({
            query: mentionQuery ?? '',
            activeCourseId: navigation?.activeCourseId ?? null,
            courses: navigation?.courseOptions ?? [],
            referencedIds: courseRefs.map((ref) => ref.stageId),
            untitled: untitledCourse,
          }),
    [
      courseRefs,
      mentionMenuOpen,
      mentionQuery,
      navigation?.activeCourseId,
      navigation?.courseOptions,
      untitledCourse,
    ],
  );
  const closeMention = useCallback(() => {
    setMentionOpen(false);
    // The draft is untouched — this only stops the token in it from reopening
    // the menu that was just dismissed.
    setMentionDismissed(draft);
    composerRef.current?.focus();
  }, [draft]);
  /**
   * The `@` button's way in. Focus FIRST: the picker's keyboard contract
   * (↑/↓/Enter) lives on the textarea, so the button has to hand the keys over
   * to it.
   */
  const openMention = useCallback(() => {
    composerRef.current?.focus();
    setMentionDismissed(null);
    setMentionOpen(true);
  }, []);
  /**
   * A pick names the course for THIS turn, and that is all it does. The trigger
   * text is not part of the sentence, so it goes; a menu opened from the button
   * has no trigger to remove and leaves the draft alone.
   */
  const pickMention = useCallback(
    (candidate: CourseMentionCandidate) => {
      const ref = makeCourseRef(candidate.stageId, candidate.title);
      if (ref) useCourseRefsStore.getState().add(ref);
      // The splice can land mid-sentence now, so the caret goes back where the
      // token was rather than wherever a shrinking controlled value leaves it.
      const removal = mention ? replaceCourseMention(draft, mention) : null;
      const next = removal?.draft ?? draft;
      if (removal) {
        pendingCaret.current = removal.caret;
        setCaret(removal.caret);
        setDraft(removal.draft);
      }
      setMentionDismissed(null);
      setMentionOpen(false);
      // The other direction of the same rule: what the splice leaves behind may
      // be a live `/handle`, and finishing with one menu must not open another.
      setSlashDismissed(next);
    },
    [draft, mention],
  );

  /**
   * A `/` query takes the composer's one popover slot, so the button's request is
   * spent rather than merely hidden — otherwise it would resurface the instant the
   * query ended.
   */
  useEffect(() => {
    if (slash !== null) setMentionOpen(false);
  }, [slash]);

  /**
   * A different conversation (or this surface unmounting) leaves no menu behind.
   * Without this the picker would still be hanging over a composer whose owner,
   * candidates and draft all just changed.
   */
  useEffect(() => {
    setMentionOpen(false);
    return () => setMentionOpen(false);
  }, [composerOwnerId]);

  const live = isComposerLive({ status, pendingSend });
  // The agent's open question, if it is waiting on one. Derived from the same
  // fold the timeline renders, so the composer's form and the transcript's card
  // can never disagree about what was asked or whether it still needs an answer.
  const pending = pendingQuestion(chat);
  // The composer IS the question while one waits, unless this exact question's
  // form was dismissed. One derived value, so the swap below and the card's way
  // back cannot describe different states.
  const takeover = composerTakeover({ pending, dismissedKey: dismissedQuestionKey });
  // Pure-derived: the idle placeholder owns the rail only while it is truly
  // empty — no messages, not catching up, no run live. It disappears the
  // instant a bubble lands or a send flips the composer to STOP.
  const showEmptyState = shouldShowWorkbenchEmptyState({ chat, catchingUp, live });
  // Where the composer sits, and therefore how much of the viewport the
  // transcript gets. See `composerLayout`.
  const layout = composerLayout(takeover !== null);
  // Is anything attached to the next message? The context block inside the input
  // box exists only when it has something to hold, so an empty composer is the
  // same height it always was. A loaded skill is NOT one of these things: it is
  // text in the box, not something staged beside it.
  const hasComposerContext =
    materials.materials.length > 0 ||
    materials.uploading.length > 0 ||
    materials.failed.length > 0 ||
    elementRefs.length > 0 ||
    courseRefs.length > 0;

  /**
   * A skill handle was written into the draft (picked from the `/` menu, opened
   * by typing one or by the skill button): put the caret after it so the user
   * can keep typing. After the controlled value has landed, hence an effect on
   * `draft` rather than a write inside the handler.
   */
  useEffect(() => {
    const caret = pendingCaret.current;
    if (caret === null) return;
    pendingCaret.current = null;
    const textarea = composerRef.current;
    if (!textarea) return;
    textarea.focus();
    textarea.setSelectionRange(caret, caret);
  }, [draft]);

  /**
   * Write a skill handle into the draft, and leave NO menu open behind it —
   * neither the `/` menu it was picked from (the inserted handle ends the query)
   * nor the `@` menu (whose open state must not survive the slash query that hid
   * it). Both dismissals are recorded against the resulting draft, so nothing
   * reopens until the user types something new.
   */
  /** Backspace deletes a whole `/handle`; see the hook for the IME guard. */
  const onSkillHandleBackspace = useSkillHandleBackspace(setDraft, (next) => {
    pendingCaret.current = next;
    setCaret(next);
  });
  const loadSkill = useCallback((skill: AgentSkillInfo) => {
    // The live selection, not the tracked state: the element is the freshest
    // answer either way.
    const at = composerRef.current?.selectionStart ?? null;
    setDraft((current) => {
      const next = insertSkillHandle(current, skill.name, at ?? current.length);
      pendingCaret.current = next.caret;
      setCaret(next.caret);
      setMentionOpen(false);
      setMentionDismissed(next.draft);
      setSlashDismissed(next.draft);
      return next.draft;
    });
  }, []);
  /**
   * The skill button's way in: seed a `/` token at the caret and the menu
   * machinery (`resolveComposerMenu`) opens the slash menu over the input with
   * the full list — the same flow typing `/` has, minus the typing. An
   * Esc-dismissed query reopens; an active one is already open, so the click is
   * spent. Focus first: the menu's keyboard contract (↑/↓/Enter) lives on the
   * textarea.
   */
  const openSkillMenu = useCallback(() => {
    composerRef.current?.focus();
    // An Esc-dismissed query reopens (the menu's Escape records the dismissal
    // against the draft); an undismissed live one is already open, so the
    // click is spent. Both are decided by the token, not by the menu's
    // visibility — clear first, then look.
    setSlashDismissed(null);
    if (slash !== null) return;
    // seedSlashQuery normalizes word-end/word-internal carets (lead space) so
    // the seeded `/` is a real query token — the naive splice glued it onto
    // the preceding word and the menu never opened.
    const seed = seedSlashQuery(draft, composerRef.current?.selectionStart ?? draft.length);
    if (!seed) return;
    pendingCaret.current = seed.caret;
    setCaret(seed.caret);
    setDraft(seed.draft);
  }, [draft, slash]);
  /** The slash menu's one exit, mirroring `closeMention`: record the draft the
   *  dismissal landed on, so the same token does not immediately reopen it. */
  const closeSkillMenu = useCallback(() => {
    setSlashDismissed(draft);
  }, [draft]);

  useEffect(() => {
    if (shouldDropPendingSend({ pendingSend, status, startedStatus: sendStartedStatus.current })) {
      sendStartedStatus.current = null;
      setPendingSend(false);
    }
  }, [pendingSend, status]);

  /**
   * The composer coming back — waved off OR answered — puts the caret where the
   * user's next keystroke should land. Guarded on the transition rather than the
   * state, so a page that simply has no question does not steal focus on mount.
   */
  const formWasOpen = useRef(false);
  useEffect(() => {
    if (formWasOpen.current && !takeover) composerRef.current?.focus();
    formWasOpen.current = takeover !== null;
  }, [takeover]);

  /**
   * The form takes real height out of the timeline's viewport (it is in the
   * layout, not floating over it), so the tail of the transcript has to be
   * re-anchored when it opens — otherwise the last thing the agent said before
   * handing over sits just above the fold. A hand-over is the one agent event
   * that earns a scroll, for the same reason a send does: it is now the user's
   * move, and the question is about what was just said.
   */
  const takeoverKey = takeover?.key ?? null;
  const scrollToBottomRef = useRef(scrollToBottom);
  scrollToBottomRef.current = scrollToBottom;
  useEffect(() => {
    if (takeoverKey) void scrollToBottomRef.current();
  }, [takeoverKey]);

  // The event stream is what lifts the stopping label: whatever terminal status
  // lands (cancelled normally, or succeeded/failed if the run beat the cancel to
  // the finish line) means the run is no longer live, and the composer goes back
  // to being a composer.
  // being a composer.
  useEffect(() => {
    if (shouldDropPendingStop({ pendingStop, status })) setPendingStop(false);
  }, [pendingStop, status]);

  const stop = useCallback(async () => {
    if (!sessionId || busy || pendingStop) return;
    setBusy(true);
    try {
      await cancelWorkbenchSession(sessionId);
      // 202: the runner has been ASKED. The terminal state still arrives through
      // the event stream, so the button says stopping until it does — silence
      // for tens of seconds is exactly what made stopping feel ignored.
      setPendingStop(true);
    } catch (err) {
      if (recoverTerminalCancelStatus(sessionId, err)) {
        // The terminal event may have been fenced before this recovery path.
        // The helper verifies that this cancel still belongs to the attached
        // session before updating the fold, and invents no event id.
        return;
      }
      // Nothing was accepted, so the button springs back to a pressable STOP.
      toast.error(err instanceof Error ? err.message : t('workbench.chat.stopFailed'));
    } finally {
      setBusy(false);
    }
  }, [busy, pendingStop, sessionId, t]);

  useDoubleEscapeStop({
    generating: live && !busy && !pendingStop && !!sessionId,
    onStop: () => {
      void stop();
    },
  });

  /**
   * The one way a user message leaves this surface — typed into the composer or
   * clicked on an `ask_user` question card. Everything that makes a send a send
   * lives here: the optimistic STOP flip (the fold's status cannot move until
   * the runner's next claim scan), the busy guard against a double submit, and
   * the failure toast. Returns whether the message was accepted, so a caller
   * can decide what to restore.
   */
  const submit = useCallback(
    async (
      text: string,
      attachments: WorkbenchMaterial[],
      refs: readonly ElementRef[] = [],
      courses: readonly CourseRef[] = [],
    ): Promise<{
      accepted: boolean;
      elementRefsAccepted: boolean;
      courseRefsAccepted: boolean;
    }> => {
      if (!sessionId && !draftConversation) {
        return { accepted: false, elementRefsAccepted: false, courseRefsAccepted: false };
      }
      if (busy) {
        return { accepted: false, elementRefsAccepted: false, courseRefsAccepted: false };
      }
      setBusy(true);
      // Optimistic: flip the composer to STOP right now. The fold's status only
      // moves once the runner claims the requeued row (`session_resumed`) — up
      // to a claim-scan interval later — and waiting for that reads as a dead
      // send button. The effect above drops the flag the moment an
      // authoritative event moves the status; a failed POST clears it here.
      sendStartedStatus.current = status;
      setPendingSend(true);
      try {
        // No session yet: the first message is what creates one, and the
        // workspace navigates to it. Everything staged rides along — the draft
        // path posts an ordinary message, so refs and materials are not a
        // special case.
        const result = sessionId
          ? {
              accepted: true,
              ...(await postWorkbenchMessage(sessionId, text, attachments, refs, courses)),
            }
          : await draftConversation!.start({
              text,
              materials: attachments,
              elementRefs: refs,
              courseRefs: courses,
            });
        if (!result.accepted) {
          sendStartedStatus.current = null;
          setPendingSend(false);
          return { accepted: false, elementRefsAccepted: false, courseRefsAccepted: false };
        }
        return {
          accepted: true,
          elementRefsAccepted: result.elementRefsAccepted,
          courseRefsAccepted: result.courseRefsAccepted,
        };
      } catch (err) {
        sendStartedStatus.current = null;
        setPendingSend(false);
        toast.error(err instanceof Error ? err.message : t('workbench.chat.sendFailed'));
        return { accepted: false, elementRefsAccepted: false, courseRefsAccepted: false };
      } finally {
        setBusy(false);
      }
    },
    [busy, draftConversation, sessionId, status, t],
  );

  /**
   * A question card's answer. The SAME send path as typing it out, so the answer
   * is an ordinary user message on an ordinary optimistic send — which is the
   * whole answer protocol `ask_user` has (no correlation id; see
   * `LIFECYCLE.userQuestion`).
   */
  const answerQuestion = useCallback(
    async (text: string): Promise<boolean> => {
      const answer = text.trim();
      if (!answer) return false;
      return (await submit(answer, [])).accepted;
    },
    [submit],
  );

  async function send() {
    // What is in the box IS the message — skill handles included. There is
    // nothing to assemble here.
    const text = draft.trim();
    if (
      (!text && materials.materials.length === 0) ||
      busy ||
      !canSend ||
      materials.busy ||
      // A click on the send button must respect an open menu exactly as Enter
      // does (onKeyDown returns early) — sending a half-typed `/query` is the
      // alternative.
      openMenu !== null
    ) {
      return;
    }
    const selectedMaterials = materials.materials;
    // Snapshot the staged element references: a reference is part of THIS
    // message, and the picker stays usable while the POST is in flight.
    const refsState = useElementRefsStore.getState();
    const selectedRefs =
      refsState.ownerSessionId === composerOwnerId ? refsState.refs : NO_ELEMENT_REFS;
    // Same snapshot rule for the named courses.
    const coursesState = useCourseRefsStore.getState();
    const selectedCourses =
      coursesState.ownerSessionId === composerOwnerId ? coursesState.refs : NO_COURSE_REFS;
    // Clear first so Enter does not freeze the box on the in-flight POST.
    replaceDraft('');
    // Both dismissal memories go with the draft they named.
    setSlashDismissed(null);
    setMentionDismissed(null);
    setMentionOpen(false);
    const result = await submit(text, selectedMaterials, selectedRefs, selectedCourses);
    if (result.accepted) {
      materials.clear();
      // Remove only this request's snapshot. Picks added while POST was pending
      // belong to the next message and must survive; an owner change meanwhile
      // also fences this completion from session B's draft. On the draft path the
      // owner key is the draft's, and the switch to the real session clears it
      // anyway — settling by the same key keeps the two paths one path.
      settleSentElementRefs({
        sessionId: composerOwnerId!,
        sent: selectedRefs,
        elementRefsAccepted: result.elementRefsAccepted,
        warnUnsupported: () => toast.warning(t('workbench.chat.elementRefsNotAccepted')),
      });
      settleSentCourseRefs({
        sessionId: composerOwnerId!,
        sent: selectedCourses,
        courseRefsAccepted: result.courseRefsAccepted,
        warnUnsupported: () => toast.warning(t('workspace.courseMention.notAccepted')),
      });
    } else {
      replaceDraft(text);
    }
  }

  // Full-width conversation uses a reading measure. Beside the classroom the
  // chat is the flex leftover (min 400), so dragging the splitter moves the
  // border instead of a right-side gutter.
  const measure = effectivePanelOpen ? '' : 'mx-auto w-full max-w-[760px]';

  return (
    <div
      data-testid="workbench-chat"
      data-panel-open={effectivePanelOpen ? 'true' : 'false'}
      className="wbchat flex h-full min-w-0 flex-1 flex-col bg-background"
      style={effectivePanelOpen && !hosted ? { minWidth: WORKBENCH_CHAT_MIN_PX } : undefined}
    >
      {/* Nothing the user has not read may sit under the composer: `composerLayout`
          is where that rule lives, and `data-composer` is it, visible. */}
      <div className="relative flex min-h-0 flex-1 flex-col" data-composer={layout.mode}>
        <div className="relative min-h-0 flex-1">
          {catchingUp && !retainedTranscript ? (
            <div
              className={cn('flex h-full items-center justify-center', layout.scrollPadding)}
              data-testid="workbench-replay-loading"
            >
              <Loader2
                className="size-5 animate-spin text-muted-foreground motion-reduce:animate-none"
                aria-label={t('workbench.common.loading')}
              />
            </div>
          ) : (
            <div
              ref={scrollRef}
              data-testid="workbench-chat-scroll"
              aria-busy={catchingUp ? 'true' : undefined}
              inert={retainedTranscript ? true : undefined}
              // The same horizontal inset as the composer footer (`px-3`), so
              // the timeline's left edge lines up with the composer box's left
              // edge instead of sitting to its right.
              className={cn(
                'h-full overflow-y-auto px-3 pt-3',
                layout.scrollPadding,
                retainedTranscript ? 'pointer-events-none select-none' : undefined,
              )}
            >
              <div
                ref={contentRef}
                className={cn(
                  'min-h-full',
                  measure,
                  showEmptyState ? 'flex flex-col items-center justify-center' : undefined,
                )}
              >
                {displayedChat.length > 0 ? (
                  <ChatTimeline
                    chat={displayedChat}
                    plan={displayedPlan}
                    onAnswer={answerQuestion}
                    dismissedQuestionKey={dismissedQuestionKey}
                    onReviveQuestion={() => setDismissedQuestionKey(null)}
                    takenOverQuestionKey={takeoverKey}
                    t={t}
                  />
                ) : showEmptyState ? (
                  <WorkbenchChatEmptyState t={t} />
                ) : null}
              </div>
            </div>
          )}
          {retainedTranscript ? (
            <div
              className="pointer-events-none absolute inset-x-0 top-2 z-10 flex justify-center"
              data-testid="workbench-replay-loading"
            >
              <span className="inline-flex items-center rounded-full border border-border/60 bg-background/90 px-2 py-1 shadow-sm backdrop-blur-sm">
                <Loader2
                  className="size-3.5 animate-spin text-muted-foreground motion-reduce:animate-none"
                  aria-label={t('workbench.common.loading')}
                />
              </span>
            </div>
          ) : null}
          {!catchingUp && !isNearBottom ? (
            <button
              type="button"
              data-testid="workbench-scroll-bottom"
              onClick={() => void scrollToBottom()}
              // Inside the SCROLL REGION, so it clears the floating composer in one
              // layout and sits at the viewport's own edge in the other.
              className={cn(styles.scrollToBottom, layout.jumpButtonOffset)}
            >
              <ArrowDown size={12} />
              {t('workbench.chat.jumpToBottom')}
            </button>
          ) : null}
        </div>

        <footer
          data-testid="workbench-composer-footer"
          className={cn('inset-x-0 z-20 px-3', layout.footer)}
        >
          <div className={styles.composer.seamFade} aria-hidden="true" />
          <div className={cn('pointer-events-auto relative', measure)}>
            {/* The agent's open question, IN PLACE OF the composer rather than
                stacked above it: there is nothing else to type while it waits,
                and one surface with one focus beats two that both look live. The
                transcript keeps its own row for the same question, and both read
                the same folded node. */}
            {takeover ? (
              <QuestionForm
                node={takeover}
                onAnswer={answerQuestion}
                onDismiss={() => setDismissedQuestionKey(takeover.key)}
                t={t}
              />
            ) : (
              <div
                className={styles.composer.inputBox}
                onDragOver={(event) => {
                  if (!materials.enabled || !composerTransferHasImages(event.dataTransfer)) return;
                  event.preventDefault();
                  event.dataTransfer.dropEffect = 'copy';
                }}
                onDrop={(event) => {
                  if (!materials.enabled) return;
                  const images = composerImagesFromDrop(event.dataTransfer);
                  if (images.length === 0) return;
                  event.preventDefault();
                  materials.addFiles(images);
                }}
              >
                {/* The composer's context block: everything attached to the next
                    message, in one pill vocabulary (see `composer-pill`), INSIDE
                    the box it is attached to so it can never overlap the
                    transcript. ONE row, not one per kind: a file and an element
                    reference are the same kind of thing here — something staged
                    on this message — and a row each said they were separate
                    mechanisms. They wrap through each other, ordered by how
                    tightly each binds to the sentence: files, then the elements
                    it is about, then the named courses.

                    A loaded skill is deliberately NOT here. Its `/handle` is
                    text the model reads, so it lives in the box as text — see
                    `lib/workbench/composer-skills`. */}
                {hasComposerContext ? (
                  <ComposerPillRow
                    testId="workbench-composer-context"
                    className={styles.composer.context}
                  >
                    <MaterialChips
                      inline
                      materials={materials.materials}
                      uploading={materials.uploading}
                      failed={materials.failed}
                      onRemove={materials.remove}
                      onRemoveFailed={materials.removeFailed}
                    />
                    <ElementRefPills
                      inline
                      refs={elementRefs}
                      onRemove={useElementRefsStore.getState().removeRef}
                    />
                    <CourseRefPills
                      inline
                      refs={courseRefs}
                      onRemove={useCourseRefsStore.getState().remove}
                    />
                  </ComposerPillRow>
                ) : null}
                {openMenu === 'skill' && slash !== null ? (
                  <SkillSlashMenu
                    key={slash}
                    filter={slash}
                    title={t('proMode.skillMenuTitle')}
                    // A completion, not a picker: the half-typed `/query` becomes
                    // the real handle and the caret lands after it.
                    onPick={loadSkill}
                    onDismiss={closeSkillMenu}
                  />
                ) : null}
                {mentionMenuOpen ? (
                  <CourseMentionMenu
                    id={mentionMenuId}
                    candidates={mentionCandidates}
                    onClose={closeMention}
                    onPick={pickMention}
                  />
                ) : null}
                {/* Two layers, one metric class: the mirror behind it draws the
                    draft's `/handle` runs as inline pills without the value ever
                    stopping being plain text (see `composer-input`). */}
                <ComposerTextarea
                  textareaRef={composerRef}
                  data-testid="workbench-chat-composer"
                  mirrorTestId="workbench-chat-composer-mirror"
                  // Moving the caret while typing a query is not a press
                  // "somewhere else" — see `CourseMentionMenu`'s outside press.
                  data-mention-keep-open=""
                  value={draft}
                  onCaretChange={setCaret}
                  onChange={(e) => setDraft(e.target.value)}
                  onPaste={(event) => {
                    if (!materials.enabled) return;
                    const images = composerImagesFromClipboard(event.clipboardData);
                    if (images.length === 0) return;
                    event.preventDefault();
                    materials.addFiles(images);
                  }}
                  onKeyDown={(e) => {
                    if (onSkillHandleBackspace(e)) return;
                    if (openMenu === 'skill') return; // the slash menu owns Enter while open
                    if (mentionMenuOpen) return; // …and so does the `@` course menu
                    if (!shouldSendComposerKey(e)) return;
                    e.preventDefault();
                    void send();
                  }}
                  disabled={!canSend}
                  aria-keyshortcuts={COMPOSER_SEND_ARIA_KEYSHORTCUTS}
                  placeholder={t(
                    shouldPromptForRefInstruction({
                      hasElementRefs: elementRefs.length > 0,
                      hasText: !!draft.trim(),
                    })
                      ? 'workbench.chat.refsNeedInstruction'
                      : live
                        ? 'workbench.chat.interruptPlaceholder'
                        : 'workbench.chat.continuePlaceholder',
                  )}
                  className={styles.composer.input}
                />
                <div className={styles.composer.actionsLeft}>
                  {/* Three glyphs, three attachments for a message: a file, a
                      classroom, a skill. The file opens its picker directly;
                      the classroom and skill both open the popovers their
                      keystrokes (`@` / `/`) open. */}
                  <AttachButton
                    testId="workbench-attach"
                    disabled={busy || !canSend}
                    label={t('proMode.attach')}
                    onFiles={materials.addFiles}
                  />
                  {(navigation?.courseOptions?.length ?? 0) > 0 ? (
                    <AtSignButton
                      testId="workbench-mention-button"
                      disabled={busy || !canSend}
                      label={t('proMode.mentionCourse')}
                      onClick={openMention}
                    />
                  ) : null}
                  <SkillButton
                    testId="workbench-skill-button"
                    disabled={busy || !canSend}
                    label={t('proMode.loadSkill')}
                    onClick={openSkillMenu}
                  />
                </div>
                <div className={styles.composer.actionsRow}>
                  {live ? (
                    // One button, two faces: pressing it swaps the square for a
                    // spinner in place, so the stop lands on the control the
                    // cursor is already on instead of moving under it.
                    <button
                      type="button"
                      data-testid="workbench-stop"
                      data-stopping={pendingStop ? 'true' : undefined}
                      onClick={() => void stop()}
                      disabled={busy || pendingStop}
                      aria-busy={pendingStop}
                      title={t(pendingStop ? 'workbench.chat.stopping' : 'workbench.chat.stop')}
                      aria-label={t(
                        pendingStop ? 'workbench.chat.stoppingAria' : 'workbench.chat.stop',
                      )}
                      className={styles.composer.stopAction}
                    >
                      {pendingStop ? (
                        <Loader2 size={12} className="animate-spin motion-reduce:animate-none" />
                      ) : (
                        <Square size={12} fill="currentColor" />
                      )}
                    </button>
                  ) : (
                    // The send button, plain: the credit/wallet hover card is a
                    // live-only affordance and is dropped in this port.
                    <button
                      type="button"
                      data-testid="workbench-send"
                      // Exempt from the popovers' outside-press close: a
                      // pointerdown here must NOT dismiss an open menu before
                      // the click, or the click would send a half-typed
                      // `/query` that Enter correctly refuses. `send()`'s
                      // openMenu guard needs the menu still open to match.
                      data-mention-keep-open=""
                      onClick={() => void send()}
                      disabled={
                        busy || (!draft.trim() && materials.materials.length === 0) || !canSend
                      }
                      title={t('workbench.common.send')}
                      aria-label={t('workbench.common.send')}
                      aria-keyshortcuts={COMPOSER_SEND_ARIA_KEYSHORTCUTS}
                      className={styles.composer.sendAction}
                    >
                      <Send size={13} />
                    </button>
                  )}
                </div>
              </div>
            )}
            {/* No permanent strip under the box any more. The classrooms this
                conversation is involved with used to sit here on their own line,
                where they wrapped against the pane's bottom edge and read as a
                second, quieter attachment row. Both of its jobs moved into the
                `@` control beside `+`: the count onto its badge, the list into the
                menu's pinned section, where opening one is still one click and
                still names nothing. */}
          </div>
        </footer>
      </div>
    </div>
  );
}
