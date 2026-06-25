import type { Action } from '@/lib/types/action';

/**
 * Pure, immutable edit operations on a scene's `actions` list, plus a factory
 * for new actions. The ActionsBar timeline drives all of its editing — inline
 * speech text, drag-to-add, reorder, element targeting, delete — through these,
 * then persists the result with `useStageStore.updateScene(sceneId, { actions })`.
 */

/**
 * Action types the timeline palette can add by drag — only the ones that stand
 * alone. Whiteboard cues (板书 etc.) need an open→draw→close workflow with
 * content/positioning, so they aren't bare-addable here.
 */
export type AddableType = 'speech' | 'spotlight' | 'laser';

/** Build a fresh action of the given type with a stable id. */
export function makeAction(type: AddableType, id: string): Action {
  switch (type) {
    case 'speech':
      return { id, type: 'speech', text: '' } as unknown as Action;
    case 'spotlight':
      return { id, type: 'spotlight', elementId: '' } as unknown as Action;
    case 'laser':
      return { id, type: 'laser', elementId: '' } as unknown as Action;
  }
}

/**
 * Build a fresh discussion action with an empty topic. A discussion isn't
 * drag-addable like the palette cues: it must be the LAST action and there is
 * at most one per scene (mirrors the `action-parser` post-processing invariant),
 * so it's appended via {@link appendDiscussion} rather than dropped at a slot.
 */
export function makeDiscussion(id: string): Action {
  return { id, type: 'discussion', topic: '' } as unknown as Action;
}

/** Index of the scene's discussion action, or -1 when there is none. */
export function discussionIndex(actions: Action[]): number {
  return actions.findIndex((a) => a.type === 'discussion');
}

/** Whether the scene already has a discussion (at most one is allowed). */
export function hasDiscussion(actions: Action[]): boolean {
  return discussionIndex(actions) !== -1;
}

/**
 * Append a discussion to the very end of the scene. No-op when one already
 * exists, enforcing the at-most-one + terminal invariant.
 */
export function appendDiscussion(actions: Action[], id: string): Action[] {
  if (hasDiscussion(actions)) return actions;
  return [...actions, makeDiscussion(id)];
}

/**
 * Cap an insertion slot so nothing can land AFTER the discussion — it stays
 * terminal. Returns the slot unchanged when there is no discussion.
 */
export function clampInsertSlot(actions: Action[], slot: number): number {
  const d = discussionIndex(actions);
  return d === -1 ? slot : Math.min(slot, d);
}

/** Insert `action` so it lands at position `index` (clamped). */
export function insertAt(actions: Action[], index: number, action: Action): Action[] {
  const i = Math.max(0, Math.min(index, actions.length));
  return [...actions.slice(0, i), action, ...actions.slice(i)];
}

/** Remove the action at `index` (no-op if out of range). */
export function removeAt(actions: Action[], index: number): Action[] {
  if (index < 0 || index >= actions.length) return actions;
  return [...actions.slice(0, index), ...actions.slice(index + 1)];
}

/**
 * Move the item at `from` to insertion slot `to` (an index into the ORIGINAL
 * array, i.e. one of the n+1 gaps). No-op when the slot is where it already is.
 */
export function move(actions: Action[], from: number, to: number): Action[] {
  if (from < 0 || from >= actions.length) return actions;
  if (to === from || to === from + 1) return actions;
  const next = actions.slice();
  const [item] = next.splice(from, 1);
  const dest = from < to ? to - 1 : to;
  next.splice(Math.max(0, Math.min(dest, next.length)), 0, item);
  return next;
}

/** Set a speech action's text (no-op if `index` isn't a speech action). */
export function setSpeechText(actions: Action[], index: number, text: string): Action[] {
  const a = actions[index];
  if (!a || a.type !== 'speech') return actions;
  const next = actions.slice();
  next[index] = { ...a, text } as Action;
  return next;
}

/** Like {@link setSpeechText} but targets an action by id (index-stale-safe). */
export function setSpeechTextById(actions: Action[], id: string, text: string): Action[] {
  const index = actions.findIndex((a) => a.id === id);
  return index < 0 ? actions : setSpeechText(actions, index, text);
}

/**
 * Edit a speech line's text AND drop its stamped audio fields (index-stale-safe).
 * The cached audio blob is keyed by sceneOrder+actionId, not the text, so an
 * edit must invalidate it or the stale audio would replay for the new wording —
 * after this the line reads as un-voiced until regenerated. (Deleting the blob
 * itself is done separately via `discardSpeechAudio`.)
 */
export function setSpeechTextClearAudioById(actions: Action[], id: string, text: string): Action[] {
  const index = actions.findIndex((a) => a.id === id);
  const a = actions[index];
  if (!a || a.type !== 'speech') return actions;
  const next = actions.slice();
  const cleaned = { ...a, text } as Action & { audioId?: string; audioUrl?: string };
  delete cleaned.audioId;
  delete cleaned.audioUrl;
  next[index] = cleaned;
  return next;
}

/** Remove an action by id (index-stale-safe). */
export function removeById(actions: Action[], id: string): Action[] {
  const index = actions.findIndex((a) => a.id === id);
  return index < 0 ? actions : removeAt(actions, index);
}

/** Move an action (by id) to insertion slot `to` (index-stale-safe). */
export function moveById(actions: Action[], id: string, to: number): Action[] {
  const index = actions.findIndex((a) => a.id === id);
  return index < 0 ? actions : move(actions, index, to);
}

/** Nudge an action one slot left (`dir < 0`) or right (`dir > 0`), by id. */
export function moveByIdDir(actions: Action[], id: string, dir: number): Action[] {
  const index = actions.findIndex((a) => a.id === id);
  if (index < 0) return actions;
  return dir < 0 ? move(actions, index, index - 1) : move(actions, index, index + 2);
}

/** Element-bound cue types whose `elementId` may be set. */
const ELEMENT_BOUND_TYPES = new Set(['spotlight', 'laser', 'play_video']);

/** Set an element-bound cue's `elementId` (no-op for other types / out of range). */
export function setElementId(actions: Action[], index: number, elementId: string): Action[] {
  const a = actions[index];
  if (!a || !ELEMENT_BOUND_TYPES.has(a.type)) return actions;
  const next = actions.slice();
  next[index] = { ...a, elementId } as Action;
  return next;
}

/** Like {@link setElementId} but targets an action by id (index-stale-safe). */
export function setElementIdById(actions: Action[], id: string, elementId: string): Action[] {
  const index = actions.findIndex((a) => a.id === id);
  return index < 0 ? actions : setElementId(actions, index, elementId);
}

/** Stamp a speech action's cached `audioId` (no-op if not a speech action). */
export function setAudioId(actions: Action[], index: number, audioId: string): Action[] {
  const a = actions[index];
  if (!a || a.type !== 'speech') return actions;
  const next = actions.slice();
  next[index] = { ...a, audioId } as Action;
  return next;
}

/** Like {@link setAudioId} but targets an action by id (index-stale-safe). */
export function setAudioIdById(actions: Action[], id: string, audioId: string): Action[] {
  const index = actions.findIndex((a) => a.id === id);
  return index < 0 ? actions : setAudioId(actions, index, audioId);
}

/** Set a discussion's `topic` by id (no-op for a missing id / non-discussion). */
export function setDiscussionTopicById(actions: Action[], id: string, topic: string): Action[] {
  const index = actions.findIndex((a) => a.id === id);
  const a = actions[index];
  if (!a || a.type !== 'discussion') return actions;
  const next = actions.slice();
  next[index] = { ...a, topic } as Action;
  return next;
}

/**
 * Set (or, for an empty value, clear) one of a discussion's optional fields by
 * id. `prompt` / `agentId` are optional, so an empty string drops the key
 * rather than persisting a blank — keeping the serialized action clean.
 */
function setDiscussionOptionalById(
  actions: Action[],
  id: string,
  field: 'prompt' | 'agentId',
  value: string,
): Action[] {
  const index = actions.findIndex((a) => a.id === id);
  const a = actions[index];
  if (!a || a.type !== 'discussion') return actions;
  const next = actions.slice();
  const updated = { ...a } as Action & { prompt?: string; agentId?: string };
  if (value) updated[field] = value;
  else delete updated[field];
  next[index] = updated;
  return next;
}

/** Set a discussion's `prompt` by id; an empty string clears it. */
export function setDiscussionPromptById(actions: Action[], id: string, prompt: string): Action[] {
  return setDiscussionOptionalById(actions, id, 'prompt', prompt);
}

/** Set a discussion's initiating `agentId` by id; an empty string clears it. */
export function setDiscussionAgentById(actions: Action[], id: string, agentId: string): Action[] {
  return setDiscussionOptionalById(actions, id, 'agentId', agentId);
}
