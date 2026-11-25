'use client';
import { useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { Whiteboard } from '@openmaic/dsl';
import { WhiteboardWindow } from '@/components/whiteboard/whiteboard-window';
import { wbClearMs } from '@/lib/choreography/timing';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useCanvasStore } from '@/lib/store/canvas';
import type { LearningView } from '@/lib/pbl/v3/types';

/**
 * The stage's whiteboard: the classroom's own whiteboard window over the work area. Boards
 * the role has since wiped, and those of earlier steps, stay one page turn away.
 */
export function ExplainBoard({
  board,
  hidden,
  clears = 0,
  kept,
  onClose,
}: {
  board: NonNullable<LearningView['explainBoard']>;
  /** Elements the role has written but not yet reached in what it is saying. */
  hidden?: ReadonlySet<string>;
  /** Wipes already made that the role's telling has not reached: the board is still as it was. */
  clears?: number;
  /** Elements already taken off the board that the telling has not reached: still on it. */
  kept?: ReadonlySet<string>;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const pages = board.pages ?? [];
  // A page is pinned only against the board version it was opened from: when the role
  // writes again, the window returns to the live board the reply points at.
  const [pinned, setPinned] = useState<{ seq: number | null; index: number } | null>(null);
  const index = pinned?.seq === board.lastSeq ? Math.min(pinned.index, pages.length) : pages.length;
  const page = index < pages.length ? pages[index] : undefined;
  // Until the telling reaches a wipe, the board is the one that was wiped. When it does, that
  // board is swept away as the classroom sweeps its own, and only then is the next one written.
  const before = (count: number) =>
    count > 0 ? (pages.at(-count)?.whiteboard ?? board.whiteboard) : board.whiteboard;
  const [seen, setSeen] = useState(clears);
  const [swept, setSwept] = useState<Whiteboard | null>(null);
  if (clears !== seen) {
    setSeen(clears);
    if (clears < seen) setSwept(before(seen) ?? null);
  }
  useEffect(() => {
    if (!swept) return;
    const canvas = useCanvasStore.getState();
    canvas.setWhiteboardClearing(true);
    const timer = setTimeout(
      () => {
        setSwept(null);
        canvas.setWhiteboardClearing(false);
      },
      Math.min(wbClearMs(swept.elements.length), 900),
    );
    return () => {
      clearTimeout(timer);
      canvas.setWhiteboardClearing(false);
    };
  }, [swept]);
  const shown = swept ?? before(clears);
  // The board as the stream last had each element, so one that was taken off can stay in
  // view until the telling gets to its removal.
  const [known, setKnown] = useState<ReadonlyMap<string, Whiteboard['elements'][number]>>(
    new Map(),
  );
  const live = board.whiteboard?.elements;
  if (live?.some((element) => known.get(element.id) !== element))
    setKnown(new Map([...known, ...live.map((element) => [element.id, element] as const)]));
  const restored =
    kept?.size && shown
      ? [...kept].flatMap((id) => {
          const element = known.get(id);
          return element && !shown.elements.some((now) => now.id === id) ? [element] : [];
        })
      : [];
  const current =
    shown && (hidden?.size || restored.length)
      ? {
          ...shown,
          elements: [...shown.elements, ...restored].filter((element) => !hidden?.has(element.id)),
        }
      : shown;
  const turn = (to: number) => setPinned({ seq: board.lastSeq, index: to });
  const button =
    'grid size-7 place-items-center rounded-full text-gray-500 transition-colors hover:bg-white hover:text-purple-600 hover:shadow-sm disabled:pointer-events-none disabled:opacity-30 dark:text-gray-400 dark:hover:bg-gray-700';
  return (
    <WhiteboardWindow
      testId="pbl-explain-board"
      className="z-[30]"
      // A 16:9 sheet under a 56px title bar, clear of the companion at the end edge.
      initial={({ width, height }) => {
        const w = Math.min(Math.max(width - 480, 520), 1000, width - 32);
        const h = Math.min(w * 0.5625 + 56, height - 32);
        return { x: 16, y: 16, width: w, height: h };
      }}
      title={t('whiteboard.title')}
      whiteboard={page ? page.whiteboard : current}
      onClose={onClose}
      actions={
        pages.length > 0 ? (
          // A fixed-width pager: the arrows never move, whatever page is showing.
          <div
            className="flex h-8 items-center rounded-full bg-gray-100/70 px-0.5 dark:bg-gray-800/60"
            data-testid="pbl-board-pager"
            title={
              page
                ? `M${page.milestoneIndex + 1} · ${t(`pblV3.journey.steps.${page.step}`)}`
                : t('pblV3.board.current')
            }
          >
            <button
              type="button"
              className={button}
              aria-label={t('pblV3.board.previous')}
              disabled={index === 0}
              onClick={() => turn(index - 1)}
            >
              <ChevronLeft className="size-4" />
            </button>
            <span className="flex h-full w-12 items-center justify-center text-xs font-medium leading-none tabular-nums text-gray-600 dark:text-gray-300">
              {index + 1}
              <span className="mx-0.5 text-gray-300 dark:text-gray-600">/</span>
              {pages.length + 1}
            </span>
            <button
              type="button"
              className={button}
              aria-label={t('pblV3.board.next')}
              disabled={!page}
              onClick={() => turn(index + 1)}
            >
              <ChevronRight className="size-4" />
            </button>
          </div>
        ) : undefined
      }
    />
  );
}
