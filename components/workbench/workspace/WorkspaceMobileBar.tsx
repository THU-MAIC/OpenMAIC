'use client';

/**
 * The workspace on a phone.
 *
 * Below `md` the rail is not drawn (`WorkspaceRail` is `hidden md:flex`), and
 * before this bar existed nothing replaced it: a phone could start a
 * conversation from the home composer and reach nothing else — not my courses,
 * not the knowledge base, not an earlier conversation, not search.
 *
 * This is the phone's way in, and deliberately not a second navigation:
 *  - the bar carries three things only: the menu, the mark (home), and new
 *    conversation — the two actions the rail itself raises above its list;
 *  - the menu opens `WorkspaceRail` itself as a sheet (`variant="drawer"`), so
 *    every destination, the conversation list, renaming and the account menu
 *    are the rail's, kept in one place for both widths.
 */

import { useEffect, useState, type ReactNode } from 'react';
import { Menu, SquarePen } from 'lucide-react';
import { Dialog as DialogPrimitive } from 'radix-ui';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useBrand } from '@/lib/brand/brand-context';
import { useMediaQuery } from '@/lib/hooks/use-media-query';

/** Tailwind's `md`: from here up the rail is on screen and the sheet has no job. */
const DESKTOP_QUERY = '(min-width: 768px)';
export function WorkspaceMobileBar({
  isHome = false,
  onOpenMenu,
  onGoHome,
  onNewSession,
}: {
  readonly isHome?: boolean;
  readonly onOpenMenu: () => void;
  readonly onGoHome: () => void;
  readonly onNewSession: () => void;
}) {
  const { t } = useI18n();
  const brand = useBrand();
  return (
    <header
      data-testid="pro-mobile-bar"
      className="ws-mobile-bar flex shrink-0 items-center gap-1 px-1.5 pt-[env(safe-area-inset-top)] md:hidden"
    >
      <div className="flex h-12 w-full items-center gap-1">
        <button
          type="button"
          data-testid="pro-mobile-menu"
          onClick={onOpenMenu}
          aria-label={t('workspace.mobile.openMenu')}
          aria-haspopup="dialog"
          className="ws-quiet grid size-11 shrink-0 place-items-center rounded-lg"
        >
          <Menu className="size-5" aria-hidden="true" />
        </button>
        <a
          href="/workspace"
          data-testid="pro-mobile-home"
          aria-label={t('workspace.homeAria')}
          onClick={(event) => {
            if (event.button !== 0) return;
            if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
            event.preventDefault();
            onGoHome();
          }}
          className="ws-home inline-flex h-11 min-w-0 items-center px-1"
        >
          <img
            src={isHome ? brand.markSrc : brand.logoSrc}
            alt=""
            aria-hidden="true"
            className={isHome ? 'size-[22px]' : 'ws-wordmark h-[22px] w-auto max-w-[128px]'}
          />
        </a>
        <button
          type="button"
          data-testid="pro-mobile-new-session"
          onClick={onNewSession}
          aria-label={t('workspace.newSession')}
          className="ws-quiet ml-auto grid size-11 shrink-0 place-items-center rounded-lg"
        >
          <SquarePen className="size-5" aria-hidden="true" />
        </button>
      </div>
    </header>
  );
}

/**
 * The sheet the bar's menu opens: a left-edge dialog holding the rail.
 * Portalled into the workspace root, not `body`, because the rail's colours
 * are the root's custom properties; the root is found from an anchor in place.
 */
export function WorkspaceMobileDrawer({
  open,
  onOpenChange,
  children,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly children: ReactNode;
}) {
  const { t } = useI18n();
  const [container, setContainer] = useState<HTMLElement | null>(null);
  const desktop = useMediaQuery(DESKTOP_QUERY);
  // Widening past `md` puts the rail back on screen; a sheet left open over it
  // would be a second copy of the same navigation.
  useEffect(() => {
    if (desktop && open) onOpenChange(false);
  }, [desktop, open, onOpenChange]);

  return (
    <>
      <span hidden ref={(node) => setContainer(node?.closest<HTMLElement>('.ws-root') ?? null)} />
      <DialogPrimitive.Root
        open={open && !desktop && container !== null}
        onOpenChange={onOpenChange}
      >
        <DialogPrimitive.Portal container={container}>
          <DialogPrimitive.Overlay
            data-testid="pro-mobile-drawer-overlay"
            // A moving panel can cross the pointer before click fires.
            onPointerDown={(event) => {
              if (event.target === event.currentTarget) onOpenChange(false);
            }}
            className="data-open:animate-in data-closed:animate-out data-closed:fade-out-0 data-open:fade-in-0 fixed inset-0 z-50 bg-black/40 duration-150"
          />
          <DialogPrimitive.Content
            data-testid="pro-mobile-drawer"
            aria-describedby={undefined}
            // Focus the sheet, not its first link: a touch-opened menu should not
            // open with the logo drawn as focused. Tab still enters the list.
            onOpenAutoFocus={(event) => {
              event.preventDefault();
              (event.currentTarget as HTMLElement | null)?.focus();
            }}
            // Nothing inside the sheet is dismissed by its own backdrop, and a
            // press on the panel's own surface is not a press on the sheet's
            // content either — it arrives here after the backdrop's handler.
            onClickCapture={(event) => {
              if (!open) {
                event.preventDefault();
                event.stopPropagation();
              }
            }}
            onPointerDownCapture={(event) => {
              if (
                !open ||
                !event.currentTarget
                  .getAnimations()
                  .some(
                    (animation) =>
                      animation instanceof CSSAnimation &&
                      animation.animationName === 'enter' &&
                      animation.playState !== 'finished',
                  )
              )
                return;
              event.preventDefault();
              event.stopPropagation();
              onOpenChange(false);
            }}
            className="data-open:animate-in data-closed:animate-out data-open:slide-in-from-left data-closed:slide-out-to-left fixed inset-y-0 left-0 z-50 flex h-[100dvh] w-[min(300px,85vw)] flex-col bg-[color:var(--ws-canvas-top)] pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] shadow-2xl duration-200 outline-none"
          >
            <DialogPrimitive.Title className="sr-only">
              {t('workspace.navAria')}
            </DialogPrimitive.Title>
            {children}
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>
    </>
  );
}
