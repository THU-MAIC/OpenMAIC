'use client';

import { ArrowUpRight, BookOpenCheck, X } from 'lucide-react';
import { Dialog } from 'radix-ui';
import { useEffect, useRef, useState, type RefObject } from 'react';
import { useI18n } from '@/lib/hooks/use-i18n';

function reportHandoffFrames(
  card: HTMLElement,
  button: HTMLButtonElement,
  target: HTMLButtonElement,
): Keyframe[] | null {
  const sheet = card.getBoundingClientRect();
  const from = button.getBoundingClientRect();
  const to = target.getBoundingClientRect();
  if (!sheet.width || !sheet.height || !from.width || !from.height || !to.width || !to.height)
    return null;

  // Translate viewport measurements into the card's local space (the host may be scaled).
  const sx = card.offsetWidth / sheet.width;
  const sy = card.offsetHeight / sheet.height;
  const clip = `inset(${(from.top - sheet.top) * sy}px ${(sheet.right - from.right) * sx}px ${(sheet.bottom - from.bottom) * sy}px ${(from.left - sheet.left) * sx}px round 12px)`;
  const centerX = from.left + from.width / 2;
  const centerY = from.top + from.height / 2;
  const dx = (to.left + to.width / 2 - centerX) * sx;
  const dy = (to.top + to.height / 2 - centerY) * sy;
  const origin = `${(centerX - sheet.left) * sx}px ${(centerY - sheet.top) * sy}px`;
  return [
    { clipPath: 'inset(0px round 24px)', transformOrigin: origin, transform: 'none', opacity: 1 },
    { clipPath: clip, transformOrigin: origin, transform: 'none', opacity: 1, offset: 0.32 },
    {
      clipPath: clip,
      transformOrigin: origin,
      transform: `translate(${dx}px, ${dy}px) scale(${to.width / from.width}, ${to.height / from.height})`,
      opacity: 0,
    },
  ];
}

export function ProjectCompletionDialog({
  root,
  getReportTarget,
  onDismiss,
  onOpenReport,
}: {
  root: RefObject<HTMLElement | null>;
  getReportTarget: () => HTMLButtonElement | null;
  onDismiss: () => void;
  onOpenReport: () => void;
}) {
  const { t } = useI18n();
  const card = useRef<HTMLDivElement>(null);
  const overlay = useRef<HTMLDivElement>(null);
  const primary = useRef<HTMLButtonElement>(null);
  const flight = useRef<Animation | null>(null);
  const dismissing = useRef(false);
  const [fullscreen, setFullscreen] = useState(
    () => typeof document !== 'undefined' && !!document.fullscreenElement,
  );

  useEffect(() => {
    const finishFlight = () => flight.current?.finish();
    const syncFullscreen = () => {
      if (dismissing.current) finishFlight();
      else setFullscreen(!!document.fullscreenElement);
    };
    window.addEventListener('resize', finishFlight);
    document.addEventListener('fullscreenchange', syncFullscreen);
    return () => {
      window.removeEventListener('resize', finishFlight);
      document.removeEventListener('fullscreenchange', syncFullscreen);
      flight.current?.cancel();
    };
  }, []);

  function dismiss() {
    if (dismissing.current) return;
    dismissing.current = true;
    const sheet = card.current;
    if (!sheet?.animate) {
      onDismiss();
      return;
    }
    const target = getReportTarget();
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const frames =
      !reduceMotion && primary.current && target
        ? reportHandoffFrames(sheet, primary.current, target)
        : null;
    const fade = [{ opacity: 1 }, { opacity: 0 }];
    overlay.current?.animate(fade, { duration: frames ? 180 : 100, fill: 'forwards' });
    const animation = sheet.animate(frames ?? fade, {
      duration: frames ? 420 : 100,
      easing: 'cubic-bezier(0.28, 0.02, 0.18, 1)',
      fill: 'forwards',
    });
    flight.current = animation;
    animation.onfinish = onDismiss;
  }

  return (
    <Dialog.Root open onOpenChange={(open) => !open && dismiss()}>
      <Dialog.Portal container={root.current}>
        <Dialog.Overlay
          ref={overlay}
          className="pbl-completion-overlay absolute inset-0 z-[60] bg-slate-950/45 backdrop-blur-[3px] motion-safe:animate-in motion-safe:fade-in"
        />
        <Dialog.Content
          key={fullscreen ? 'native' : 'page'}
          ref={card}
          data-pbl-completion-dialog
          className="absolute top-1/2 left-1/2 z-[61] max-h-[calc(100%-1.5rem)] w-[min(26rem,calc(100%-1.5rem))] -translate-x-1/2 -translate-y-1/2 overflow-auto rounded-3xl border bg-popover px-5 py-7 text-center text-popover-foreground shadow-2xl outline-none sm:px-8"
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            primary.current?.focus({ preventScroll: true });
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (!dismissing.current) return;
            const target = getReportTarget();
            (target ?? root.current)?.focus({ preventScroll: true });
            target?.animate?.(
              [
                { boxShadow: '0 0 0 3px var(--pbl-guidance)' },
                { boxShadow: '0 0 0 3px transparent' },
              ],
              { duration: 700 },
            );
          }}
          onEscapeKeyDown={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
        >
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 top-0 h-28 bg-linear-to-b from-(--pbl-guidance)/10 to-transparent"
          />
          <button
            type="button"
            aria-label={t('common.close')}
            className="absolute end-2 top-2 z-10 grid size-10 place-items-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
            onClick={dismiss}
          >
            <X size={16} aria-hidden="true" />
          </button>
          <div className="relative mx-auto mb-5 grid size-14 place-items-center rounded-2xl border border-(--pbl-guidance)/30 bg-popover text-(--pbl-guidance) shadow-sm ring-4 ring-(--pbl-guidance)/10">
            <BookOpenCheck size={26} strokeWidth={1.6} aria-hidden="true" />
          </div>
          <Dialog.Title className="relative text-xl leading-snug font-semibold text-balance">
            {t('pblV3.completion.title')}
          </Dialog.Title>
          <Dialog.Description className="mt-2 text-sm leading-relaxed text-pretty text-muted-foreground">
            {t('pblV3.completion.description')}
          </Dialog.Description>
          <button
            ref={primary}
            type="button"
            className="pbl-report-action mx-auto mt-6 flex min-h-11 w-full items-center justify-center gap-2 rounded-xl px-4 py-2 text-sm font-semibold shadow-sm"
            onClick={() => !dismissing.current && onOpenReport()}
          >
            {t('pblV3.completion.openReport')}
            <ArrowUpRight size={16} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="mt-1 min-h-11 rounded-xl px-4 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
            onClick={dismiss}
          >
            {t('pblV3.completion.stay')}
          </button>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
