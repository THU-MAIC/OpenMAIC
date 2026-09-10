import { create } from 'zustand';
import { useEffect } from 'react';
import { createSelectors } from '@/lib/utils/create-selectors';
import { sameDraftPick, stampDraft } from '@/lib/store/draft-generation';
import {
  MAX_ELEMENT_REFS,
  addElementRef,
  elementRefIdentity,
  elementRefOrdinal,
  hasElementRef,
  removeElementRef,
  removeElementRefValue,
  sameElementRef,
  toggleElementRef,
  type ElementRef,
} from '@/lib/workbench/element-refs';

/**
 * Element Refs Store — the elements staged for the NEXT message.
 *
 * Draft state, deliberately not persisted: a reference is only meaningful while
 * the sentence it belongs to is being written, and a stale ref revived after a
 * reload would point at an element the agent has since rewritten. The send path
 * clears it; nothing else outlives the composer.
 *
 * `hovered` is the cross-surface link between a chip and the canvas: the
 * composer's chips write it on hover, and the canvas pin layer reads it to ring
 * the element. It lives here rather than in the canvas store because it is a
 * property of the reference list, not of the canvas's own selection.
 */
interface ElementRefsState {
  /** Conversation that owns this draft list. */
  ownerSessionId: string | null;
  refs: ElementRef[];
  /** The ref the pointer is currently over, wherever it is being pointed at. */
  hovered: { stageId: string; sceneId: string; elementId: string } | null;
  /** Monotonic local token; never serialized with the wire ref. */
  nextGeneration: number;

  attachOwner: (sessionId: string) => void;
  /** Drop an ephemeral draft when its chat detaches. */
  detachOwner: (sessionId?: string) => void;
  add: (ref: ElementRef) => void;
  /** Add unique refs in order and report only unique items actually lost to the cap. */
  addMany: (refs: readonly ElementRef[]) => { added: number; droppedByCap: number };
  remove: (stageId: string, sceneId: string, elementId: string) => void;
  removeRef: (ref: ElementRef) => void;
  removeSent: (sessionId: string, refs: readonly ElementRef[]) => void;
  toggle: (ref: ElementRef) => void;
  clear: () => void;
  setHovered: (target: { stageId: string; sceneId: string; elementId: string } | null) => void;
}

/** The shared stamp (`lib/store/draft-generation`) — see `removeSent` below. */
const draftRef = (ref: ElementRef, generation: number): ElementRef =>
  stampDraft(ref, generation) as ElementRef;

const useElementRefsStoreBase = create<ElementRefsState>((set, get) => ({
  ownerSessionId: null,
  refs: [],
  hovered: null,
  nextGeneration: 1,

  attachOwner: (sessionId) =>
    set((state) =>
      state.ownerSessionId === sessionId
        ? state
        : { ownerSessionId: sessionId, refs: [], hovered: null },
    ),

  detachOwner: (sessionId) =>
    set((state) =>
      sessionId !== undefined && state.ownerSessionId !== sessionId
        ? state
        : { ownerSessionId: null, refs: [], hovered: null },
    ),

  add: (ref) =>
    set((state) => {
      if (
        state.refs.length >= MAX_ELEMENT_REFS ||
        state.refs.some((candidate) => sameElementRef(candidate, ref))
      ) {
        return state;
      }
      return {
        refs: addElementRef(state.refs, draftRef(ref, state.nextGeneration)),
        nextGeneration: state.nextGeneration + 1,
      };
    }),

  addMany: (refs) => {
    const before = get().refs;
    let next = before;
    let droppedByCap = 0;
    let nextGeneration = get().nextGeneration;
    const seen = new Set(before.map(elementRefIdentity));
    for (const ref of refs) {
      const key = elementRefIdentity(ref);
      if (seen.has(key)) continue;
      seen.add(key);
      if (next.length >= MAX_ELEMENT_REFS) {
        droppedByCap += 1;
        continue;
      }
      next = addElementRef(next, draftRef(ref, nextGeneration));
      nextGeneration += 1;
    }
    if (next !== before) set({ refs: next, nextGeneration });
    return { added: next.length - before.length, droppedByCap };
  },

  remove: (stageId, sceneId, elementId) =>
    set((state) => {
      const refs = removeElementRef(state.refs, stageId, sceneId, elementId);
      const hovered =
        state.hovered &&
        state.hovered.stageId === stageId &&
        state.hovered.sceneId === sceneId &&
        state.hovered.elementId === elementId
          ? null
          : state.hovered;
      return { refs, hovered };
    }),

  removeRef: (target) =>
    set((state) => {
      const refs = removeElementRefValue(state.refs, target);
      const hovered =
        target.kind === 'slide-element' &&
        state.hovered?.stageId === target.stageId &&
        state.hovered.sceneId === target.sceneId &&
        state.hovered.elementId === target.elementId
          ? null
          : state.hovered;
      return refs === state.refs ? state : { refs, hovered };
    }),

  removeSent: (sessionId, sent) =>
    set((state) => {
      if (state.ownerSessionId !== sessionId || sent.length === 0) return state;
      const wasSent = (ref: ElementRef) =>
        sent.some((snapshot) => sameDraftPick(ref, snapshot, sameElementRef));
      const refs = state.refs.filter((ref) => !wasSent(ref));
      const hovered =
        state.hovered &&
        state.refs.some(
          (ref) =>
            ref.kind === 'slide-element' &&
            ref.stageId === state.hovered!.stageId &&
            ref.sceneId === state.hovered!.sceneId &&
            ref.elementId === state.hovered!.elementId &&
            wasSent(ref),
        )
          ? null
          : state.hovered;
      return refs.length === state.refs.length ? state : { refs, hovered };
    }),

  toggle: (ref) =>
    set((state) => {
      if (state.refs.some((candidate) => sameElementRef(candidate, ref))) {
        return { refs: toggleElementRef(state.refs, ref) };
      }
      if (state.refs.length >= MAX_ELEMENT_REFS) return state;
      return {
        refs: addElementRef(state.refs, draftRef(ref, state.nextGeneration)),
        nextGeneration: state.nextGeneration + 1,
      };
    }),

  clear: () => set({ refs: [], hovered: null }),

  setHovered: (hovered) => set({ hovered }),
}));

export const useElementRefsStore = createSelectors(useElementRefsStoreBase);

const NO_OWNED_REFS: ElementRef[] = [];

/** Never render a draft owned by another chat. This selector has no lifecycle side effects. */
export function useElementRefsForSession(sessionId: string | null): ElementRef[] {
  return useElementRefsStore((state) =>
    sessionId && state.ownerSessionId === sessionId ? state.refs : NO_OWNED_REFS,
  );
}

/** The authoritative chat lifecycle. Auxiliary consumers must only use the fenced selector. */
export function useElementRefsOwnerLifecycle(sessionId: string | null): void {
  useEffect(() => {
    const store = useElementRefsStore.getState();
    if (!sessionId) {
      store.detachOwner();
      return;
    }
    store.attachOwner(sessionId);
    return () => useElementRefsStore.getState().detachOwner(sessionId);
  }, [sessionId]);
}

/** Never expose another conversation's cross-surface hover during navigation. */
export function useElementRefsHoveredForSession(
  sessionId: string | null,
): ElementRefsState['hovered'] {
  return useElementRefsStore((state) =>
    sessionId && state.ownerSessionId === sessionId ? state.hovered : null,
  );
}

/** Is this element already staged? Read outside React (pick layer hit-tests). */
export function isElementReferenced(
  sessionId: string | null,
  stageId: string,
  sceneId: string,
  elementId: string,
): boolean {
  const state = useElementRefsStore.getState();
  return (
    !!sessionId &&
    state.ownerSessionId === sessionId &&
    hasElementRef(state.refs, stageId, sceneId, elementId)
  );
}

/** 1-based pin number for an element, or 0 when it is not staged. */
export function referencedElementOrdinal(
  sessionId: string | null,
  stageId: string,
  sceneId: string,
  elementId: string,
): number {
  const state = useElementRefsStore.getState();
  return sessionId && state.ownerSessionId === sessionId
    ? elementRefOrdinal(state.refs, stageId, sceneId, elementId)
    : 0;
}

export { MAX_ELEMENT_REFS };
