import { create } from 'zustand';
import { useEffect } from 'react';
import { createSelectors } from '@/lib/utils/create-selectors';
import { sameDraftPick, stampDraft } from '@/lib/store/draft-generation';
import {
  MAX_COURSE_REFS,
  addCourseRef,
  hasCourseRef,
  removeCourseRef,
  sameCourseRef,
  type CourseRef,
} from '@/lib/workbench/course-refs';

/**
 * Course Refs Store — the classrooms named for the NEXT message.
 *
 * Draft state, deliberately not persisted, exactly like the element-refs store
 * this mirrors: a mention belongs to the sentence being written, and a mention
 * revived after a reload would aim a turn at a course the user has since
 * navigated away from. The send path clears it; nothing else outlives the
 * composer.
 *
 * There is no `hovered` twin here: an element ref has a canvas pin to ring, a
 * course ref has nothing on screen to point at.
 *
 * The owner fence is the same one: `ownerSessionId` is written ONLY by the chat
 * that owns the composer (`useCourseRefsOwnerLifecycle`, mounted in
 * `WorkbenchChat`), and every other consumer reads through the fenced selector
 * so conversation B can never render or clear conversation A's draft.
 */
interface CourseRefsState {
  /** Conversation that owns this draft list. */
  ownerSessionId: string | null;
  refs: CourseRef[];
  /** Monotonic local token; never serialized with the wire ref. */
  nextGeneration: number;

  attachOwner: (sessionId: string) => void;
  /** Drop an ephemeral draft when its chat detaches. */
  detachOwner: (sessionId?: string) => void;
  add: (ref: CourseRef) => void;
  remove: (stageId: string) => void;
  removeSent: (sessionId: string, refs: readonly CourseRef[]) => void;
  clear: () => void;
}

const useCourseRefsStoreBase = create<CourseRefsState>((set) => ({
  ownerSessionId: null,
  refs: [],
  nextGeneration: 1,

  attachOwner: (sessionId) =>
    set((state) =>
      state.ownerSessionId === sessionId ? state : { ownerSessionId: sessionId, refs: [] },
    ),

  detachOwner: (sessionId) =>
    set((state) =>
      sessionId !== undefined && state.ownerSessionId !== sessionId
        ? state
        : { ownerSessionId: null, refs: [] },
    ),

  add: (ref) =>
    set((state) => {
      if (state.refs.length >= MAX_COURSE_REFS || hasCourseRef(state.refs, ref.stageId)) {
        return state;
      }
      return {
        refs: addCourseRef(state.refs, stampDraft(ref, state.nextGeneration) as CourseRef),
        nextGeneration: state.nextGeneration + 1,
      };
    }),

  remove: (stageId) => set((state) => ({ refs: removeCourseRef(state.refs, stageId) })),

  removeSent: (sessionId, sent) =>
    set((state) => {
      if (state.ownerSessionId !== sessionId || sent.length === 0) return state;
      // Identity is not enough: the user may have re-picked the same course
      // while the POST was in flight, and that pick belongs to the NEXT message.
      const refs = state.refs.filter(
        (ref) => !sent.some((snapshot) => sameDraftPick(ref, snapshot, sameCourseRef)),
      );
      return refs.length === state.refs.length ? state : { refs };
    }),

  clear: () => set({ refs: [] }),
}));

export const useCourseRefsStore = createSelectors(useCourseRefsStoreBase);

const NO_OWNED_REFS: CourseRef[] = [];

/** Never render a draft owned by another chat. This selector has no lifecycle side effects. */
export function useCourseRefsForSession(sessionId: string | null): CourseRef[] {
  return useCourseRefsStore((state) =>
    sessionId && state.ownerSessionId === sessionId ? state.refs : NO_OWNED_REFS,
  );
}

/** The authoritative chat lifecycle. Auxiliary consumers must only use the fenced selector. */
export function useCourseRefsOwnerLifecycle(sessionId: string | null): void {
  useEffect(() => {
    const store = useCourseRefsStore.getState();
    if (!sessionId) {
      store.detachOwner();
      return;
    }
    store.attachOwner(sessionId);
    return () => useCourseRefsStore.getState().detachOwner(sessionId);
  }, [sessionId]);
}

export { MAX_COURSE_REFS };
