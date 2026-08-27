'use client';

/**
 * "This classroom is hosted inside the workbench panel" — ambient context.
 *
 */
import { createContext, useContext, useMemo, type ReactNode } from 'react';
import type { WorkbenchMaterial } from './session-store';
import type { ElementRef } from './element-refs';
import type { CourseRef } from './course-refs';

export interface WorkbenchPanelState {
  readonly hosted: boolean;
  /** Whether the classroom column is actually visible in the workspace. */
  readonly visible: boolean;
  /** Whether the hosted classroom is in full-screen learning playback. */
  readonly playback: boolean;
}

const OUTSIDE_WORKBENCH: WorkbenchPanelState = {
  hosted: false,
  visible: true,
  playback: false,
};

const WorkbenchPanelContext = createContext<WorkbenchPanelState>(OUTSIDE_WORKBENCH);

export function WorkbenchPanelProvider({
  children,
  visible = true,
  playback = false,
}: {
  readonly children: ReactNode;
  readonly visible?: boolean;
  readonly playback?: boolean;
}) {
  const value = useMemo<WorkbenchPanelState>(
    () => ({ hosted: true, visible, playback }),
    [playback, visible],
  );
  return <WorkbenchPanelContext.Provider value={value}>{children}</WorkbenchPanelContext.Provider>;
}

export function useInWorkbenchPanel(): boolean {
  return useContext(WorkbenchPanelContext).hosted;
}

/**
 * View state supplied by the workspace pane itself.
 */
export function useWorkbenchPanelState(): WorkbenchPanelState {
  return useContext(WorkbenchPanelContext);
}

/**
 * What a course link needs to know about a course to name it.
 */
export interface WorkbenchCourseSummary {
  readonly id: string;
  readonly name: string;
  readonly pageCount: number | null;
}

/**
 * One course the composer's `@` picker may offer.
 */
export interface WorkbenchCourseOption {
  readonly id: string;
  readonly name: string;
}

/**
 * Navigation capability supplied by `/workspace` to hosted chat content.
 */
export interface WorkbenchCourseNavigation {
  readonly openCourse: (courseId: string) => void;
  /** The one on screen; `null` when the right pane holds nothing. */
  readonly activeCourseId: string | null;
  /** `null` for an id the workspace cannot name — the link then degrades. */
  readonly lookupCourse: (courseId: string) => WorkbenchCourseSummary | null;
  /**
   * Everything the owner has, newest-updated first — the `@` picker's third
   * tier.
   */
  readonly courseOptions: readonly WorkbenchCourseOption[];
}

const WorkbenchCourseNavigationContext = createContext<WorkbenchCourseNavigation | null>(null);

export function WorkbenchCourseNavigationProvider({
  navigation,
  children,
}: {
  readonly navigation: WorkbenchCourseNavigation;
  readonly children: ReactNode;
}) {
  return (
    <WorkbenchCourseNavigationContext.Provider value={navigation}>
      {children}
    </WorkbenchCourseNavigationContext.Provider>
  );
}

export function useWorkbenchCourseNavigation(): WorkbenchCourseNavigation | null {
  return useContext(WorkbenchCourseNavigationContext);
}

/**
 * "There is no conversation yet, and that is fine — type."
 *
 * Supplied by `/workspace` when the middle column is an EMPTY composer: the user
 * has no conversations at all, and one is minted by their first message.
 */
export interface WorkbenchDraftConversation {
  readonly ownerKey: string;
  readonly start: (message: {
    readonly text: string;
    readonly materials: readonly WorkbenchMaterial[];
    readonly elementRefs: readonly ElementRef[];
    readonly courseRefs: readonly CourseRef[];
  }) => Promise<{
    readonly accepted: boolean;
    readonly elementRefsAccepted: boolean;
    readonly courseRefsAccepted: boolean;
  }>;
}

const WorkbenchDraftConversationContext = createContext<WorkbenchDraftConversation | null>(null);

export function WorkbenchDraftConversationProvider({
  draft,
  children,
}: {
  readonly draft: WorkbenchDraftConversation | null;
  readonly children: ReactNode;
}) {
  return (
    <WorkbenchDraftConversationContext.Provider value={draft}>
      {children}
    </WorkbenchDraftConversationContext.Provider>
  );
}

export function useWorkbenchDraftConversation(): WorkbenchDraftConversation | null {
  return useContext(WorkbenchDraftConversationContext);
}
