'use client';

/**
 * "Fix with agent" — the ONE hand-off from an observed course issue to a
 * conversation about that course (RFC #1899, issue #2329).
 *
 * Every trigger (an issue in the editor's list, the interactive runtime-error
 * notice) routes through `useAgentFix().handOff`. The destination is an EMPTY
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
  /**
   * Composed, localized prefill text. Untrusted page output (a runtime error)
   * must already be fenced — see {@link composeAgentFixPrefill}.
   */
  readonly prefill: string;
}

/** Who is looking at a course's problems, and where they can take them. */
export interface AgentFixAccess {
  /**
   * This viewer may repair the course, so a raw runtime error is theirs to
   * see (folded away). Everyone else gets a neutral placeholder.
   */
  readonly repairable: boolean;
  /**
   * The hand-off, wherever a conversation could change the course: its owner,
   * a workspace to go to, no generation run holding it. Null everywhere else,
   * which hides every "Fix with agent" entry.
   */
  readonly handOff: ((request: AgentFixRequest) => void) | null;
  /**
   * The same hand-off for one interactive page's observed runtime errors: the
   * classroom resolves the page and the course, and the caller words the
   * prefill for that page. Resolved where the course is known, so the iframe
   * host needs nothing but this context (it is bundled on its own, without
   * the stage store). Null exactly when `handOff` is.
   */
  readonly fixRuntimeError:
    | ((sceneId: string, prefill: (page: AgentFixPage) => string) => void)
    | null;
}

/** A page of the course, as a hand-off names it. */
export interface AgentFixPage {
  /** Zero-based position in the course. */
  readonly index: number;
  readonly title: string | undefined;
}

/** Outside a classroom that says otherwise: nothing raw, nothing to repair. */
const NO_AGENT_FIX: AgentFixAccess = { repairable: false, handOff: null, fixRuntimeError: null };

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

/** The prefill for an interactive page's runtime errors, from either entry. */
export function runtimeErrorPrefill(t: Translate, page: string, errors: string): string {
  return composeAgentFixPrefill(t('chat.interactiveRuntimeError.fixPrefill', { page }), errors);
}

/** Untrusted detail is bounded and every line is neutralised and quoted. */
export const AGENT_FIX_DETAIL_MAX = 400;

/**
 * Fence untrusted page output (an observed runtime error) so it can ride along
 * in a prompt without being instructions: bounded, line separators normalised,
 * each line stripped of any slash that starts a token (leading or after
 * whitespace, so page text cannot pose as a slash command or skill trigger)
 * and quoted as a block that reads as evidence, not as orders.
 */
export function fenceUntrustedDetail(detail: string): string {
  return detail
    .trim()
    .slice(0, AGENT_FIX_DETAIL_MAX)
    .replace(/\r\n?|[\u2028\u2029\u0085]/g, '\n')
    .split('\n')
    .map((line) => line.trim().replace(/(^|\s)\/+/g, '$1').trim())
    .filter(Boolean)
    .map((line) => `> ${line}`)
    .join('\n');
}

/** A localized intro sentence plus the fenced untrusted detail, if any. */
export function composeAgentFixPrefill(intro: string, detail?: string): string {
  const fenced = detail ? fenceUntrustedDetail(detail) : '';
  return fenced ? `${intro}\n\n${fenced}` : intro;
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
