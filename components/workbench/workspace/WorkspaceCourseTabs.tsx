'use client';

/**
 * The right pane's tab strip — the courses this chat has open.
 *
 * The pane header used to be "course name + controls". The name half IS this
 * strip now, so any number of open courses costs NO new row of chrome: a
 * permanent shelf was refused in the rail and a second row here would be the
 * same mistake in a different pane.
 *
 * ── Shrink to a floor, then scroll ───────────────────────────────────────
 *
 * There is no cap and no eviction, so the strip has to degrade gracefully
 * forever. Two pixels of policy do that: a `min-width` floor below which a tab
 * will not compress (a tab narrower than a few characters of its own name
 * identifies nothing), and `overflow-x`, so past the floor the strip scrolls
 * instead of lying. The floor is 86px and it is derived, not guessed — see the
 * comment on `.ws-ctab` in `workspace-shell.css`.
 *
 * Saying there is more takes two signals, because neither alone is enough: an
 * edge fade on whichever side has off-screen tabs (a hard clip reads as damage,
 * a fade reads as continuation), plus a drawn scrollbar. The native one is an
 * overlay scrollbar here — it reserves 0px and paints nothing until you are
 * already scrolling, i.e. an affordance you can only see after guessing it
 * exists — so it is suppressed and replaced by two background layers whose size
 * and offset this file keeps in sync with `scrollLeft`.
 *
 * ── Keeping the active tab visible ───────────────────────────────────────
 *
 * `scrollIntoView` on every render is the naive version and it is worse than
 * nothing: it yanks the strip back the moment you scroll away to look at the
 * others, because unrelated renders happen too. It fires on a change of active
 * tab or of tab count, never otherwise — so a strip you scrolled by hand stays
 * where you put it — and it aims TWICE, because the pane's width transitions:
 * the first shot can compute against a scrollport that is still the width it is
 * leaving, which is how an active tab ends up half off-screen.
 *
 * ── Keyboard ─────────────────────────────────────────────────────────────
 *
 * A real `role=tablist` with a roving tabindex. The handler is bound to THIS
 * element and queries `.ws-ctab` inside it, so it can never be reached by the
 * rail's tablist handler (which listens on its own container and queries
 * `.ws-navtab`); the two scopes do not overlap. ←/→ move and activate, matching
 * the rail's idiom — one keyboard model in the product, not two — Home/End
 * jump, and Delete/Backspace closes the focused tab, which is the keyboard path
 * to a close button that is deliberately not a tab stop of its own.
 */

import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { useI18n } from '@/lib/hooks/use-i18n';
import { cn } from '@/lib/utils/cn';

export interface WorkspaceCourseTabItem {
  readonly id: string;
  readonly name: string;
}

/** Long enough to outlast the pane's width transition before the second aim. */
const SETTLE_MS = 340;
/** The drawn thumb stays grabbable when very many tabs are open. */
const THUMB_MIN_PX = 28;

export function WorkspaceCourseTabs({
  tabs,
  activeCourseId,
  onActivate,
  onClose,
}: {
  readonly tabs: readonly WorkspaceCourseTabItem[];
  readonly activeCourseId: string;
  readonly onActivate: (courseId: string) => void;
  readonly onClose: (courseId: string) => void;
}) {
  const { t } = useI18n();
  const stripRef = useRef<HTMLDivElement>(null);
  const revealTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /**
   * Which side has more, and how much. `data-more` drives the CSS fade; the two
   * background layers are the drawn scrollbar. Only the size and the x offset
   * come from here — every other property stays in the stylesheet.
   */
  const paintEdges = useCallback(() => {
    const strip = stripRef.current;
    if (!strip) return;
    const over = strip.scrollWidth - strip.clientWidth;
    if (over <= 1) {
      strip.dataset.more = 'none';
      strip.style.backgroundSize = '';
      strip.style.backgroundPosition = '';
      return;
    }
    const left = strip.scrollLeft > 1;
    const right = strip.scrollLeft < over - 1;
    strip.dataset.more = left && right ? 'both' : left ? 'left' : 'right';
    const width = Math.max(
      THUMB_MIN_PX,
      Math.round(strip.clientWidth * (strip.clientWidth / strip.scrollWidth)),
    );
    const x = Math.round((strip.clientWidth - width) * (strip.scrollLeft / over));
    strip.style.backgroundSize = `${width}px 3px, 100% 3px`;
    strip.style.backgroundPosition = `${x}px bottom, 0 bottom`;
  }, []);

  const activeFullyVisible = useCallback(() => {
    const strip = stripRef.current;
    const el = strip?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!strip || !el) return true;
    const sb = strip.getBoundingClientRect();
    const ab = el.getBoundingClientRect();
    return ab.left >= sb.left - 0.5 && ab.right <= sb.right + 0.5;
  }, []);

  const revealActive = useCallback(() => {
    const aim = () => {
      const el = stripRef.current?.querySelector<HTMLElement>('[aria-selected="true"]');
      el?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    };
    aim();
    if (revealTimer.current) clearTimeout(revealTimer.current);
    revealTimer.current = setTimeout(aim, SETTLE_MS);
  }, []);

  // Paint before the first frame so the fade is never a frame late.
  useLayoutEffect(() => {
    paintEdges();
  }, [paintEdges, tabs]);

  // A new tab, or a different active one, is re-aimed. Nothing else is.
  useEffect(() => {
    revealActive();
    return () => {
      if (revealTimer.current) clearTimeout(revealTimer.current);
    };
  }, [activeCourseId, tabs.length, revealActive]);

  /**
   * The rail is draggable and the chat pane resizable, so the strip can be
   * squeezed with no state change at all. The fade and the thumb are always
   * recomputed; the active tab is re-aimed only if the squeeze actually pushed
   * it out of sight — which is what a browser does when you narrow its window,
   * and never otherwise, so a hand-scrolled strip is left where it was put.
   */
  useEffect(() => {
    const strip = stripRef.current;
    if (!strip || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      paintEdges();
      if (!activeFullyVisible()) revealActive();
    });
    observer.observe(strip);
    return () => observer.disconnect();
  }, [activeFullyVisible, paintEdges, revealActive]);

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const strip = stripRef.current;
    if (!strip) return;
    const items = [...strip.querySelectorAll<HTMLElement>('.ws-ctab')];
    const current =
      event.target instanceof Element ? event.target.closest<HTMLElement>('.ws-ctab') : null;
    const index = current ? items.indexOf(current) : -1;
    if (index < 0) return;

    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      const id = current?.dataset.courseId;
      if (!id) return;
      onClose(id);
      // Focus the tab that slid into this slot, or the new last one.
      requestAnimationFrame(() => {
        const rest = [...(stripRef.current?.querySelectorAll<HTMLElement>('.ws-ctab') ?? [])];
        rest[Math.min(index, rest.length - 1)]?.focus();
      });
      return;
    }

    let next: number | null = null;
    if (event.key === 'ArrowRight') next = (index + 1) % items.length;
    else if (event.key === 'ArrowLeft') next = (index - 1 + items.length) % items.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = items.length - 1;
    else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      const id = current?.dataset.courseId;
      if (id) onActivate(id);
      return;
    }
    if (next === null) return;
    event.preventDefault();
    const target = items[next];
    const id = target?.dataset.courseId;
    if (!id) return;
    target.focus();
    onActivate(id);
  };

  return (
    <div
      ref={stripRef}
      data-testid="workspace-course-tabs"
      role="tablist"
      aria-label={t('workspace.courseTabsAria')}
      aria-orientation="horizontal"
      data-more="none"
      className="ws-ctabs"
      onScroll={paintEdges}
      onKeyDown={onKeyDown}
    >
      {tabs.map((tab) => {
        const selected = tab.id === activeCourseId;
        const name = tab.name || t('workspace.untitledCourse');
        return (
          /* A div, not a button: it contains a real close <button>, and
             interactive content cannot nest. */
          <div
            key={tab.id}
            role="tab"
            data-testid={`workspace-course-tab-${tab.id}`}
            data-course-id={tab.id}
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            title={name}
            className={cn('ws-ctab', selected && 'ws-ctab-on')}
            onClick={(event) => {
              if (event.target instanceof Element && event.target.closest('.ws-ctab-x')) return;
              onActivate(tab.id);
            }}
          >
            <span className="ws-ctab-name">{name}</span>
            <button
              type="button"
              tabIndex={-1}
              data-testid={`workspace-course-tab-close-${tab.id}`}
              aria-label={t('workspace.courseTabClose', { name })}
              className="ws-ctab-x"
              onClick={(event) => {
                event.stopPropagation();
                onClose(tab.id);
              }}
            >
              <svg
                width="10"
                height="10"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.9"
                strokeLinecap="round"
                aria-hidden="true"
              >
                <path d="m4.8 4.8 6.4 6.4M11.2 4.8l-6.4 6.4" />
              </svg>
            </button>
          </div>
        );
      })}
    </div>
  );
}
