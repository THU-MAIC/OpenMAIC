'use client';

/**
 * "Fix with agent" — the ONE hand-off from an observed course issue to a
 * conversation about that course (RFC #1899, issue #2329).
 *
 * Every trigger (one issue, or the whole list, in the editor's issues list)
 * routes through `useAgentFix().handOff`. The destination is an EMPTY
 * conversation beside the course, its composer naming the course as an `@`
 * mention with the issue pre-filled as text the owner reviews and sends
 * themselves — nothing is ever sent automatically.
 *
 * `Stage` decides who gets it (see `AgentFixContext`): hosted in the workspace
 * classroom pane, the shell takes the request in place; on the standalone
 * classroom, the request is staged in sessionStorage (this tab, one shot) and
 * the classroom goes to `/workspace?course=<id>`, where the shell takes it on
 * arrival.
 */

import { createContext, useContext } from 'react';

/** What one "Fix with agent" trigger hands over. */
export interface AgentFixRequest {
  readonly courseId: string;
  /** Composed, localized prefill text. */
  readonly prefill: string;
}

/** Where this viewer can take a course's problems. */
export interface AgentFixAccess {
  /**
   * The hand-off, wherever a conversation could change the course: its owner,
   * a workspace to go to, no generation run holding it. Null everywhere else,
   * which hides every "Fix with agent" entry.
   */
  readonly handOff: ((request: AgentFixRequest) => void) | null;
}

/** Outside a classroom that says otherwise: nothing to repair. */
const NO_AGENT_FIX: AgentFixAccess = { handOff: null };

export const AgentFixContext = createContext<AgentFixAccess>(NO_AGENT_FIX);

export function useAgentFix(): AgentFixAccess {
  return useContext(AgentFixContext);
}

type Translate = (key: string, options?: Record<string, unknown>) => string;

/** How a hand-off names a page: "Page 3 · Graph". */
export function agentFixPageLabel(t: Translate, index: number, title: string | undefined): string {
  return t('edit.issues.pageLabel', {
    index: index + 1,
    title: title?.trim() || t('edit.issues.untitledPage'),
  });
}

const STORAGE_KEY = 'openmaic.agentFixHandoff';
/**
 * How long a staged request waits for the workspace. The navigation takes a
 * moment; anything older was never taken (the course never opened, its access
 * never answered) and must not surface in some later visit.
 */
export const AGENT_FIX_STAGED_TTL_MS = 2 * 60_000;

/** Stage the standalone classroom's request for the workspace to take over. */
export function stageAgentFixForWorkspace(request: AgentFixRequest, now = Date.now()): void {
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ ...request, stagedAt: now }));
  } catch {
    // Storage unavailable (private mode, quota): the navigation still opens the
    // course; the owner retypes what they saw.
  }
}

/** Drop the staged request (taken, stale, or landing in another course). */
export function dropStagedAgentFix(): void {
  try {
    window.sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing to undo without storage.
  }
}

/** The staged request, if a fresh one is waiting. Does not take it. */
export function peekStagedAgentFix(now = Date.now()): AgentFixRequest | null {
  let raw: string | null;
  try {
    raw = window.sessionStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { courseId?: unknown; prefill?: unknown; stagedAt?: unknown };
    if (
      typeof parsed.courseId === 'string' &&
      parsed.courseId &&
      typeof parsed.prefill === 'string' &&
      typeof parsed.stagedAt === 'number' &&
      now - parsed.stagedAt >= 0 &&
      now - parsed.stagedAt <= AGENT_FIX_STAGED_TTL_MS
    ) {
      return { courseId: parsed.courseId, prefill: parsed.prefill };
    }
  } catch {
    // Not ours, or not readable: dropped below.
  }
  dropStagedAgentFix();
  return null;
}

/** The composer-side seed: one prefill for one draft conversation's composer. */
export interface AgentFixDraftSeed {
  readonly key: number;
  /** The draft composer it is for (`draft:<courseId>`). */
  readonly ownerKey: string;
  /** The course the draft names; the prefill follows its `@` mention. */
  readonly courseId: string;
  readonly text: string;
}

let lastSeedKey = 0;

/** Seed keys are unique for the page's lifetime, so a seed applies once. */
export function nextAgentFixSeedKey(): number {
  lastSeedKey += 1;
  return lastSeedKey;
}
