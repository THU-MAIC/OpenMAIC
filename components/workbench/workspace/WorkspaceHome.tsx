'use client';

/**
 * The workspace's resting surface: the product lockup, the composer, and the
 * featured feed under it.
 *
 * The surface is one continuous column with a hinge in it. Lockup and composer
 * are centred in the first viewport with nothing beside them; the discover feed
 * follows, lifted just far enough that its section head and the top of its
 * first card row cross the fold. Packing the whole feed into the first screen
 * was an earlier round, and it made the front door of the product read as a
 * page with a search box at the top rather than as an invitation to type;
 * banishing it a full screen down was the round after that, and it made the
 * feed read as an unrelated second page. The overlap is the middle answer.
 *
 * It fills the main column only when nothing is open — a conversation or a
 * course takes its place, because a home page behind a working session is a
 * page nobody reads. Discovery runs in `discover-only` mode: folders, courses
 * and sessions are managed in the navigation tree, never twice on one screen.
 *
 * The hero is the CLASSIC home's hero, not a composed one. An earlier cut put
 * an invented headline here ("What will you create today?") over a lone mark;
 * it was a second voice for a product that already has one. What the homepage
 * puts above its composer is the horizontal logo with the Pro badge at the
 * wordmark's shoulder, the tagline, and the GitHub pill — the same three
 * things, the same components, sized for a column that is narrower than a full
 * page but not shrunk out of the page's weight class: the round that pinned
 * the mark at 40px left the surface top-light, and no amount of trimming below
 * fixes a masthead nobody sees.
 *
 * The badge here is also the mode switch. It sits beside the product identity,
 * so making that visible Pro state actionable keeps both home surfaces
 * symmetrical: off enters Pro on `/`, on returns to classic here. The rail
 * keeps its copy because the hero only exists on this resting surface.
 */

import { type ReactNode, useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useBrand, useIsDesktop } from '@/lib/brand/brand-context';
import { arrivedByProSwap } from '@/lib/workbench/pro-swap';
import { cn } from '@/lib/utils/cn';
import { ProBadge } from '@/components/workbench/ProBadge';
import { ProLaunchPanel } from '@/components/workbench/ProLaunchPanel';
import type { CourseMentionSource } from '@/lib/workbench/course-mention';

export function WorkspaceHome({
  composerReset,
  discoveryContent,
  courseOptions,
  onOpenSession,
  onExitPro,
}: {
  readonly composerReset: number;
  readonly discoveryContent: ReactNode;
  /**
   * What the composer's `@` picker may name. The shell already has this list
   * (the rail renders it), so it is handed down rather than fetched again here.
   */
  readonly courseOptions: readonly CourseMentionSource[];
  readonly onOpenSession: (sessionId: string) => void;
  readonly onExitPro: () => void;
}) {
  const { t } = useI18n();
  const brand = useBrand();
  const isDesktop = useIsDesktop();

  // Someone who arrived through the Pro swap has just watched the surfaces
  // crossfade around a fixed lockup and the composer turn over into this face;
  // staggering the hero again would replay that arrival, and would slide the
  // composer up out of the flip it just landed. Read once at mount — the answer
  // must not change under the surface while it is on screen.
  const [swapped] = useState(arrivedByProSwap);

  return (
    <main
      data-testid="pro-workspace-home"
      aria-label={t('workspace.homeAria')}
      className="ws-canvas relative flex min-w-0 flex-1 flex-col overflow-y-auto"
    >
      {/* Below `md` the sidebar is gone, so the exit switch needs a home. A
          plain button, not a second ProBadge: two elements answering to
          `pro-mode-exit` would be one testid too many. */}
      <div className="flex h-12 shrink-0 items-center justify-between px-4 md:hidden">
        <img src={brand.logoSrc} alt={brand.productName} className="h-5 w-auto" />
        <button
          type="button"
          data-testid="pro-workspace-exit-compact"
          onClick={onExitPro}
          className="ws-quiet inline-flex items-center gap-1.5 text-[12px]"
        >
          <ArrowLeft className="size-3.5" aria-hidden="true" />
          {t('workspace.exitPro')}
        </button>
      </div>

      {/* One column, not two. The discover feed used to run to 1180px under a
          720px composer — 230px of extra card on each side, which is what made
          the page bottom-heavy however the hero was sized. The outer column is
          now 980px (900px of content at `lg`), the composer 760px inside it,
          so the feed breathes 70px per side rather than a third of a screen. */}
      <div className="mx-auto w-full max-w-[980px] px-5 pb-24 sm:px-8 lg:px-10">
        {/* Beat zero, and the rule the whole surface hangs on: hero + composer
            own the first screen and sit optically centred in it, the way a
            product whose front door is a text field should. This block stays
            one viewport tall (`.ws-home-first`) whatever the feed under it
            does — the feed rises INTO the fold with a negative margin of its
            own, so the centring here is never renegotiated. */}
        <section
          className="ws-home-first relative mx-auto w-full max-w-[760px]"
          data-testid="pro-workspace-first-screen"
        >
          {/* Beat one: the lockup. Same structure as `app/page.tsx` — the badge
              hangs off the wordmark's right edge absolutely, so it never
              shifts the logo off the column's centre line.

              `data-pro-morph` names it for the Pro swap: this box and `/`'s
              equivalent are the fixed anchor while the two surfaces fade.
              The name sits on the lockup itself, not on the `ws-enter`
              wrapper, so the entrance animation is never captured. */}
          <div className={cn('flex flex-col items-center', !swapped && 'ws-enter ws-d1')}>
            <div
              className="relative w-fit"
              data-testid="pro-workspace-hero-lockup"
              data-pro-morph="lockup"
            >
              {isDesktop && !brand.logoHasWordmark ? (
                // A brand whose mark carries no wordmark gets the product name
                // beside it, exactly as the classic hero does.
                <div className="flex items-center gap-3">
                  <img src={brand.markSrc} alt={brand.productName} className="size-11 md:size-14" />
                  <span
                    className="text-xl font-semibold tracking-tight md:text-2xl"
                    style={{ color: brand.themeColor }}
                  >
                    {brand.productName}
                  </span>
                </div>
              ) : (
                <img
                  src={brand.logoSrc}
                  alt={brand.productName}
                  data-testid="pro-workspace-hero-logo"
                  className="ws-hero-logo"
                />
              )}
              {/* At the wordmark's cap height, where a trademark mark goes —
                  offset from the image TOP, not centred on it, and scaled with
                  the 46/56px lockup rather than the classic page's 48/64px. */}
              <div
                className="absolute left-full top-0 ml-2 mt-[9px] md:mt-[12px]"
                data-pro-morph="badge"
                data-pro-stamp
              >
                <ProBadge active onToggle={onExitPro} testId="pro-workspace-hero-badge" />
              </div>
            </div>

            <div className="mt-3.5 flex items-center gap-3">
              <p className="ws-tagline" data-testid="pro-workspace-hero-tagline">
                {t('home.slogan')}
              </p>
            </div>
          </div>

          {/* Beat two: the composer, the one object on this page with real
              craft spent on it. It gets the larger gap of the two, because the
              gap is what says which of them the page is actually about. */}
          <div className={cn('mt-8', !swapped && 'ws-enter ws-d2')}>
            <ProLaunchPanel
              autoFocus
              focusSignal={composerReset}
              variant="workspace"
              courseOptions={courseOptions}
              onSessionCreated={onOpenSession}
            />
          </div>
        </section>

        {/* The featured feed. It no longer waits below the fold: `.ws-featured`
            carries a negative margin that lifts its head — and a slice of the
            first card row — over the fold, so the composer's screen ends by
            showing what the rest of the surface is rather than by pointing at
            it. The first screen's own box is untouched, so the lockup and the
            composer sit exactly where they sat.

            No entrance animation here. It used to rise on a 260ms delay as the
            third beat of the load; the head is now on screen at rest, and a
            section that animates in under a composer the user is typing into
            is a distraction with a delay on it. */}
        <section
          data-testid="pro-workspace-featured"
          className="ws-featured flex w-full flex-col items-center [&>div]:mt-0"
        >
          {discoveryContent}
        </section>
      </div>
    </main>
  );
}
