'use client';

/**
 * Where a blocked conversation's "Start a new chat" goes.
 *
 * The conversation owns the ONE answer path for questions (`question-host`);
 * this is the same shape for the one exit a terminal notice offers. The
 * conversation surface (`WorkbenchChat`) publishes the workspace's new-chat
 * action here while it is mounted, and the notice row deep in the timeline
 * (`SystemNode`) reads it — no prop drilling through the chat's render tree.
 *
 * The published callback must be stable and always current: the workspace
 * resolves which course the new conversation is for at CLICK time, so the
 * publisher backs it with a ref rather than a re-created closure.
 */
import { create } from 'zustand';

interface NewChatHostState {
  /** The workspace's new-chat path, while a conversation is mounted. */
  readonly start: (() => void) | null;
  readonly setStart: (start: (() => void) | null) => void;
}

export const useNewChatHost = create<NewChatHostState>((set) => ({
  start: null,
  setStart: (start) => set({ start }),
}));
