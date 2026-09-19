'use client';

/**
 * The conversation pane.
 *
 * The chat itself is `WorkbenchChat`, unchanged — this adds the pane header
 * (which session, how it is doing, and the way to collapse) and the drag that
 * moves the seam between the conversation and the classroom.
 *
 * Width: the conversation is the fixed-ish column and the classroom takes the
 * rest, which is the same convention the workbench had. With no classroom
 * open the pane simply stretches, and the chat's own reading measure keeps
 * the text from running the full width of a wide window.
 */

import { useEffect, useRef, useState } from 'react';
import { LoaderCircle } from 'lucide-react';
import { useI18n } from '@/lib/hooks/use-i18n';
import { cn } from '@/lib/utils/cn';
import { WorkbenchChat } from '@/components/workbench/WorkbenchChat';
import { PaneFoldButton } from './PaneFoldButton';
import { useWorkbenchStore } from '@/lib/workbench/session-store';
import { presentWorkspaceSession } from '@/lib/workbench/workspace-navigation';
import { SESSION_TITLE_MAX_LENGTH, workbenchSessionTitle } from '@/lib/workbench/session-title';
import {
  WorkbenchCourseNavigationProvider,
  WorkbenchDraftConversationProvider,
  type WorkbenchCourseNavigation,
  type WorkbenchDraftConversation,
} from '@/lib/workbench/panel-context';

export function WorkspaceChatPane({
  width,
  fill,
  hidden,
  navigation,
  draftConversation = null,
  onCollapse,
  onRename,
  resizeHandle,
}: {
  /**
   * The pane's width in px. The conversation keeps ITS OWN column in every
   * layout — with a classroom beside it and without — so that opening a
   * course never resizes the transcript mid-sentence. The classroom slot to
   * its right is filled by the classroom or by a quiet placeholder.
   */
  readonly width: number;
  /**
   * The classroom was put away (its tab is on the right), so the conversation
   * takes its column too. Off by default: with no classroom in play the slot
   * keeps its width, which is what stops this column from resizing the moment
   * a course opens beside it.
   */
  readonly fill: boolean;
  /**
   * Collapsed. The pane stays MOUNTED and merely stops painting, because the
   * composer draft and the scroll position are worth more than the few
   * hundred bytes of an unmounted subtree.
   */
  readonly hidden: boolean;
  /** Course links in hosted chat read and drive this one shell-owned seam. */
  readonly navigation: WorkbenchCourseNavigation;
  /**
   * Present when this pane has NO session behind it: the composer is live and the
   * user's first message is what creates the conversation. Absent for every
   * ordinary attached chat.
   */
  readonly draftConversation?: WorkbenchDraftConversation | null;
  /**
   * Fold this pane away, when there is another pane to take the column. Rendered
   * at the end of the pane's own header — see `PaneFoldButton` for why it is not
   * on the seam any more.
   */
  readonly onCollapse?: () => void;
  /**
   * Rename this conversation. Resolves to null when it landed, or to a readable
   * message when it did not (the caller has already rolled its optimistic write
   * back). Absent while there is no conversation to name yet.
   */
  readonly onRename?: (title: string) => Promise<string | null>;
  readonly resizeHandle?: React.ReactNode;
}) {
  const { t } = useI18n();
  const sessionPrompt = useWorkbenchStore((s) => s.sessionPrompt);
  const sessionTitle = useWorkbenchStore((s) => s.sessionTitle);
  const status = useWorkbenchStore((s) => s.status);
  /**
   * How the run is doing, or null when there is no run to report.
   *
   * `idle` is the store holding no session at all: a draft conversation, and the
   * frame between this pane mounting on a `?session=` deep link and `attach()`.
   * Neither has a run, so the header shows no status rather than guessing one —
   * it used to take the initial `connecting` and show a connecting label beside
   * a composer that was simply waiting to be typed into.
   */
  const presentation = status === 'idle' ? null : presentWorkspaceSession(status);
  const [renaming, setRenaming] = useState(false);

  /**
   * What this conversation is called: the name the user gave it, else what was
   * asked in it.
   *
   * It used to fall back to the open course's name, which said the conversation
   * was that course's record — the same binding the two independent columns
   * removed, restated in the header. A conversation with nothing asked in it yet
   * is simply a new one.
   */
  const named = workbenchSessionTitle({ title: sessionTitle, prompt: sessionPrompt });
  const title = named ?? t(draftConversation ? 'workspace.newSession' : 'workspace.currentSession');
  const canRename = !!onRename && !draftConversation;

  return (
    <section
      data-testid="workspace-chat-pane"
      aria-label={t('workspace.chatPaneAria')}
      aria-hidden={hidden || undefined}
      className={cn(
        'ws-pane h-full flex-col',
        hidden ? 'hidden' : 'flex',
        fill ? 'min-w-0 flex-1' : 'shrink-0',
      )}
      style={fill ? undefined : { width }}
    >
      <header className="ws-pane-head flex shrink-0 items-center gap-2 px-3">
        {/* A conversation that does not exist yet has no run to report. It used to
            take the initial `connecting` status and show a connecting label with a
            live spinner beside a composer that was simply waiting to be typed
            into — which is what made the empty state look like a hang. No
            session, no status. */}
        {draftConversation || !presentation ? null : presentation.tone === 'live' ? (
          <LoaderCircle aria-hidden="true" className="ws-spin-live" />
        ) : (
          <span
            aria-hidden="true"
            className={cn('ws-dot', presentation.tone === 'error' && 'ws-dot-fail')}
          />
        )}
        <div className="min-w-0 flex-1">
          {renaming && onRename ? (
            <SessionTitleInput
              // The stored name, not the derived one: the box opens on what the
              // user chose, and an untitled conversation opens EMPTY rather than
              // pre-filled with its first message — the placeholder shows what it
              // will fall back to if nothing is typed.
              initial={sessionTitle ?? ''}
              placeholder={named ?? title}
              onCommit={onRename}
              onClose={() => setRenaming(false)}
            />
          ) : canRename ? (
            <button
              type="button"
              data-testid="workspace-chat-title"
              onClick={() => setRenaming(true)}
              title={t('workspace.renameSession')}
              aria-label={t('workspace.renameSessionAria', { name: title })}
              className="ws-pane-title block w-full truncate rounded-md px-1 text-left transition-colors hover:bg-[var(--ws-tint,rgba(0,0,0,0.04))] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--ws-accent-thread,currentColor)]"
            >
              {title}
            </button>
          ) : (
            <p data-testid="workspace-chat-title" className="ws-pane-title truncate" title={title}>
              {title}
            </p>
          )}
        </div>
        {draftConversation || !presentation ? null : (
          <span className="ws-pane-eyebrow shrink-0">{t(presentation.labelKey)}</span>
        )}
        {onCollapse ? (
          <PaneFoldButton
            testId="workspace-chat-fold"
            label={t('workspace.collapseChat')}
            direction="left"
            onClick={onCollapse}
          />
        ) : null}
      </header>

      <div className="relative min-h-0 flex-1">
        <WorkbenchCourseNavigationProvider navigation={navigation}>
          <WorkbenchDraftConversationProvider draft={draftConversation}>
            <WorkbenchChat hosted adjacentPanelOpen={!fill} />
          </WorkbenchDraftConversationProvider>
        </WorkbenchCourseNavigationProvider>
      </div>

      {resizeHandle}
    </section>
  );
}

/**
 * The title, being edited, in the title's own place.
 *
 * Not a dialog: the thing being named is the header you are looking at, and the
 * rail renames its rows in place for the same reason. Enter commits, Escape
 * puts the old name back, and blurring commits too — the box has no buttons of
 * its own (there is no room for a pair in a 42px header) so clicking away has
 * to mean something, and here it can only mean "that's the name". Nothing is
 * lost either way: an empty box clears the override and the title goes back to
 * being derived from the first message.
 */
function SessionTitleInput({
  initial,
  placeholder,
  onCommit,
  onClose,
}: {
  readonly initial: string;
  readonly placeholder: string;
  readonly onCommit: (title: string) => Promise<string | null>;
  readonly onClose: () => void;
}) {
  const { t } = useI18n();
  const [value, setValue] = useState(initial);
  const inputRef = useRef<HTMLInputElement>(null);
  // One commit per open, whichever way it is triggered: Enter blurs the input
  // on its way out, and without this the same rename would be sent twice.
  const settled = useRef(false);

  useEffect(() => {
    // Selected, not just focused: renaming usually means replacing.
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const commit = () => {
    if (settled.current) return;
    settled.current = true;
    onClose();
    void onCommit(value);
  };

  return (
    <form
      className="flex min-w-0 items-center"
      onSubmit={(event) => {
        event.preventDefault();
        commit();
      }}
    >
      <input
        ref={inputRef}
        data-testid="workspace-chat-title-input"
        value={value}
        maxLength={SESSION_TITLE_MAX_LENGTH}
        onChange={(event) => setValue(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key !== 'Escape') return;
          event.preventDefault();
          event.stopPropagation();
          settled.current = true;
          onClose();
        }}
        placeholder={placeholder}
        aria-label={t('workspace.renameSession')}
        className="ws-pane-title min-w-0 flex-1 rounded-md border-0 bg-[var(--ws-tint,rgba(0,0,0,0.04))] px-1 outline-none ring-1 ring-[var(--ws-accent-thread,currentColor)]"
      />
    </form>
  );
}
