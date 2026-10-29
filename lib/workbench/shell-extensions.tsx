'use client';

/**
 * Host extension slots for the workspace shell.
 *
 * The shell's rail, account block and home are generic: what the product ships
 * upstream is the complete set of built-in destinations and settings, and a
 * deployment that needs more (its own pages, account details, a notice) adds
 * them here instead of editing the shell. Everything is optional and the
 * default is empty, so a deployment that provides nothing renders exactly the
 * upstream shell.
 *
 * Provide the slots once, high in the tree (the root layout already mounts an
 * empty provider; replace it, or nest another one inside it):
 *
 * ```tsx
 * <WorkbenchShellExtensionsProvider
 *   value={{
 *     navItems: [{ id: 'gallery', label: 'Gallery', icon: Images, render: () => <Gallery /> }],
 *     accountMenuItems: [{ id: 'billing', label: 'Billing', icon: CreditCard, href: '/billing' }],
 *     accountSummary: <span>120 credits</span>,
 *     accountBadge: hasUnread,
 *   }}
 * >
 *   {children}
 * </WorkbenchShellExtensionsProvider>
 * ```
 *
 * Nested providers merge: lists are concatenated (outer first) and single
 * values from the innermost provider win, so separate features can each add
 * their own entries.
 */

import { createContext, useContext, useMemo, type ComponentType, type ReactNode } from 'react';

/** An icon component, such as one from `lucide-react`. */
export type WorkbenchShellIcon = ComponentType<{ className?: string; 'aria-hidden'?: boolean }>;

/**
 * A destination in the rail's primary navigation, rendered after the
 * built-in ones (in the folded rail too, as an icon).
 *
 * Exactly one of `render`, `href` or `onSelect` decides what selecting it
 * does: `render` opens a page in the main area (addressable as
 * `/workspace?view=<id>`, so `id` must be lowercase letters, digits and
 * dashes), `href` navigates (a new tab when `external`), and `onSelect` runs.
 */
export interface WorkbenchShellNavItem {
  readonly id: string;
  readonly label: string;
  readonly icon: WorkbenchShellIcon;
  readonly render?: () => ReactNode;
  readonly href?: string;
  readonly external?: boolean;
  readonly onSelect?: () => void;
  /** A short tag at the row's end, such as "New". Hidden in the folded rail. */
  readonly tag?: string;
}

/** An entry in the account menu, shown in its own group above the settings. */
export interface WorkbenchShellMenuItem {
  readonly id: string;
  readonly label: string;
  readonly icon?: WorkbenchShellIcon;
  readonly href?: string;
  readonly external?: boolean;
  readonly onSelect?: () => void;
  /** Right-aligned detail, such as a count or a status. */
  readonly trailing?: ReactNode;
}

/**
 * Who is using the shell, for deployments with accounts. Without it the
 * account block shows the local learner profile (name and avatar), which is
 * all a single-owner deployment has.
 */
export interface WorkbenchShellIdentity {
  /** False shows the sign-in entry instead of a name. */
  readonly signedIn: boolean;
  readonly name?: string;
  /** An image URL; the initial of `name` is used without one. */
  readonly avatarUrl?: string;
  /** A second line under the name in the menu header, such as an email. */
  readonly detail?: string;
  /** Shown while signed out. */
  readonly signIn?: {
    readonly label?: string;
    readonly onSelect: () => void;
    /** A short line under the sign-in button. */
    readonly hint?: ReactNode;
  };
  /** Shown while signed in, as the menu's last entry. */
  readonly onSignOut?: () => void;
}

export interface WorkbenchShellExtensions {
  readonly navItems?: readonly WorkbenchShellNavItem[];
  readonly accountMenuItems?: readonly WorkbenchShellMenuItem[];
  /** A line in the account block and the account menu header (a balance, a plan). */
  readonly accountSummary?: ReactNode;
  /** An unread dot on the avatar, for something waiting in the account menu. */
  readonly accountBadge?: boolean;
  readonly identity?: WorkbenchShellIdentity;
  /** Content under the home composer, such as a featured-course strip. */
  readonly homeSection?: ReactNode;
}

const EMPTY: WorkbenchShellExtensions = {};

const WorkbenchShellExtensionsContext = createContext<WorkbenchShellExtensions>(EMPTY);

/** Merge an inner provider's slots into the outer ones (see the module comment). */
export function mergeWorkbenchShellExtensions(
  outer: WorkbenchShellExtensions,
  inner: WorkbenchShellExtensions,
): WorkbenchShellExtensions {
  return {
    navItems: [...(outer.navItems ?? []), ...(inner.navItems ?? [])],
    accountMenuItems: [...(outer.accountMenuItems ?? []), ...(inner.accountMenuItems ?? [])],
    accountSummary: inner.accountSummary ?? outer.accountSummary,
    accountBadge: inner.accountBadge ?? outer.accountBadge,
    identity: inner.identity ?? outer.identity,
    homeSection: inner.homeSection ?? outer.homeSection,
  };
}

export function WorkbenchShellExtensionsProvider({
  value = EMPTY,
  children,
}: {
  readonly value?: WorkbenchShellExtensions;
  readonly children?: ReactNode;
}) {
  const outer = useContext(WorkbenchShellExtensionsContext);
  const merged = useMemo(
    () => (outer === EMPTY ? value : mergeWorkbenchShellExtensions(outer, value)),
    [outer, value],
  );
  return (
    <WorkbenchShellExtensionsContext.Provider value={merged}>
      {children}
    </WorkbenchShellExtensionsContext.Provider>
  );
}

export function useWorkbenchShellExtensions(): WorkbenchShellExtensions {
  return useContext(WorkbenchShellExtensionsContext);
}

/** The host nav items that open a page, keyed by their view id. */
export function hostPageItems(
  extensions: WorkbenchShellExtensions,
): ReadonlyMap<string, WorkbenchShellNavItem> {
  const pages = new Map<string, WorkbenchShellNavItem>();
  for (const item of extensions.navItems ?? []) {
    if (item.render) pages.set(item.id, item);
  }
  return pages;
}
