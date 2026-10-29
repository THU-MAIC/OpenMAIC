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
 * The hero is the CLASSIC home's hero, not a composed one: the horizontal
 * logo, the tagline and the GitHub link, sized for a column that is narrower
 * than a full page but not shrunk out of the page's weight class.
 *
 * Under the composer, a host may add a section of its own (a featured-course
 * strip, say) through `WorkbenchShellExtensions.homeSection`. Upstream has no
 * feed of other people's courses, so by default nothing follows the composer.
 */

import type { ReactNode } from 'react';
import { Github } from 'lucide-react';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useWorkbenchShellExtensions } from '@/lib/workbench/shell-extensions';
import { OPENMAIC_GITHUB_URL } from '@/lib/workbench/shell-links';
import { useBrand, useIsDesktop } from '@/lib/brand/brand-context';
import { ProLaunchPanel } from '@/components/workbench/ProLaunchPanel';
import type { CourseMentionSource } from '@/lib/workbench/course-mention';
import type { MaterialSeed } from '@/components/workbench/compose-extras';

export function WorkspaceHome({
  composerReset,
  discoveryContent,
  courseOptions,
  onOpenSession,
  onOpenSessionAfterLeaving,
  materialSeed,
  onMaterialSeedConsumed,
}: {
  readonly composerReset: number;
  readonly discoveryContent: ReactNode;
  /**
   * What the composer's `@` picker may name. The shell already has this list
   * (the rail renders it), so it is handed down rather than fetched again here.
   */
  readonly courseOptions: readonly CourseMentionSource[];
  readonly onOpenSession: (sessionId: string) => void;
  /** The composer's conversation exists, but home was left meanwhile. */
  readonly onOpenSessionAfterLeaving: (sessionId: string) => void;
  /** A knowledge base hand-over, passed through to the composer. */
  readonly materialSeed?: MaterialSeed | null;
  readonly onMaterialSeedConsumed?: (key: number) => void;
}) {
  const { t } = useI18n();
  const brand = useBrand();
  const isDesktop = useIsDesktop();
  const { homeSection } = useWorkbenchShellExtensions();

  return (
    <main
      data-testid="pro-workspace-home"
      aria-label={t('workspace.homeAria')}
      className="ws-canvas relative flex min-w-0 flex-1 flex-col overflow-y-auto"
    >
      {/* Below `md` the sidebar is gone, so the brand needs a home. */}
      <div className="flex h-12 shrink-0 items-center px-4 md:hidden">
        <img src={brand.logoSrc} alt={brand.productName} className="h-5 w-auto" />
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
          {/* Beat one: the lockup. */}
          <div className="ws-enter ws-d1 flex flex-col items-center">
            <div className="relative w-fit" data-testid="pro-workspace-hero-lockup">
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
            </div>

            <div className="mt-3.5 flex flex-wrap items-center justify-center gap-3">
              <p className="ws-tagline" data-testid="pro-workspace-hero-tagline">
                {t('home.slogan')}
              </p>
              <a
                href={OPENMAIC_GITHUB_URL}
                target="_blank"
                rel="noopener noreferrer"
                data-testid="pro-workspace-hero-github"
                className="ws-gh-pill"
              >
                <Github className="size-3.5" aria-hidden="true" />
                GitHub
              </a>
            </div>
          </div>

          {/* Beat two: the composer, the one object on this page with real
              craft spent on it. It gets the larger gap of the two, because the
              gap is what says which of them the page is actually about. */}
          <div className="ws-enter ws-d2 mt-8">
            <ProLaunchPanel
              autoFocus
              focusSignal={composerReset}
              variant="workspace"
              courseOptions={courseOptions}
              onSessionCreated={onOpenSession}
              onSessionCreatedAfterLeaving={onOpenSessionAfterLeaving}
              materialSeed={materialSeed}
              onMaterialSeedConsumed={onMaterialSeedConsumed}
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
          {homeSection ? (
            <div className="w-full" data-testid="pro-workspace-host-section">
              {homeSection}
            </div>
          ) : null}
        </section>
      </div>
    </main>
  );
}
