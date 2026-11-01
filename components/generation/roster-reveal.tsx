'use client';

/**
 * The classroom's cast revealed inside the request preview — with the classic
 * agent reveal's own card (`components/agent/agent-reveal-card.tsx`, the same
 * component `AgentRevealModal` renders), its heading, its pace and its
 * progress dots. Only the frame differs: the modal is a full-screen overlay,
 * this owns the preview tab's scene area. Cards keep the classic proportions
 * and scale down only when the pane is too narrow for a row of them; a large
 * cast wraps onto further rows.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { Sparkles } from 'lucide-react';
import { useI18n } from '@/lib/hooks/use-i18n';
import { cn } from '@/lib/utils';
import { AGENT_REVEAL_CARD_SIZE, AgentRevealCard } from '@/components/agent/agent-reveal-card';
import { ROSTER_REVEAL, type RosterAgent } from '@/lib/workbench/request-schedule';

const GAP = 16;
const PER_ROW = 4;
/** Below this the cards would stop being legible; the row wraps instead. */
const MIN_SCALE = 0.62;
/** The classic modal flattens its cards this long after the last flip. */
const FLATTEN_AFTER_MS = 800;

export function RosterRevealVisualizer({ agents }: { readonly agents: readonly RosterAgent[] }) {
  const { t } = useI18n();
  const [revealed, setRevealed] = useState(0);
  const [flipsComplete, setFlipsComplete] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const [available, setAvailable] = useState<number | null>(null);

  // The classic pace: the first card after a beat, then one every half second.
  // Keyed on the cast's identity, not the array: the preview re-derives the
  // roster on every clock tick, and restarting the timers each time would keep
  // every card face down.
  const castKey = agents.map((agent) => agent.id).join('|');
  const count = agents.length;
  // A new cast (set_roster again) is a new reveal: every card face down again.
  const [revealedCast, setRevealedCast] = useState(castKey);
  if (revealedCast !== castKey) {
    setRevealedCast(castKey);
    setRevealed(0);
    setFlipsComplete(false);
  }
  useEffect(() => {
    const timers = Array.from({ length: count }, (_, index) =>
      setTimeout(
        () => setRevealed((shown) => Math.max(shown, index + 1)),
        ROSTER_REVEAL.leadMs + index * ROSTER_REVEAL.perCardMs,
      ),
    );
    return () => timers.forEach(clearTimeout);
  }, [castKey, count]);

  const allRevealed = agents.length > 0 && revealed >= agents.length;
  useEffect(() => {
    if (!allRevealed) return;
    const timer = setTimeout(() => setFlipsComplete(true), FLATTEN_AFTER_MS);
    return () => clearTimeout(timer);
  }, [allRevealed]);

  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const measure = () => setAvailable(box.clientWidth);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    return () => observer.disconnect();
  }, []);

  const { width, height } = AGENT_REVEAL_CARD_SIZE;
  const row = (count: number) => count * width + (count - 1) * GAP;
  let perRow = Math.min(agents.length, PER_ROW);
  let scale = available === null ? 1 : Math.min(1, available / row(perRow));
  while (perRow > 1 && scale < MIN_SCALE) {
    perRow -= 1;
    scale = Math.min(1, (available ?? row(perRow)) / row(perRow));
  }

  return (
    <div
      ref={boxRef}
      data-testid="request-preview-roster"
      data-revealed={revealed}
      className="flex w-full flex-col items-center"
    >
      <motion.h2
        className="mb-6 text-2xl font-bold text-zinc-800 drop-shadow-sm dark:text-white dark:drop-shadow-lg"
        initial={{ opacity: 0, y: -20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.1, duration: 0.4 }}
      >
        <Sparkles className="mr-2 inline-block size-6 text-amber-500 dark:text-yellow-400" />
        {t('generation.agentRevealTitle')}
      </motion.h2>

      <div
        className="flex flex-wrap items-start justify-center"
        style={{ gap: GAP * scale, maxWidth: row(perRow) * scale + 1 }}
      >
        {agents.map((agent, index) => (
          // The card at its own size, scaled as a whole so nothing inside it reflows.
          <div
            key={agent.id}
            data-testid="request-preview-roster-card"
            data-revealed={index < revealed ? 'true' : 'false'}
            style={{ width: width * scale, height: height * scale }}
          >
            <div
              style={{
                width,
                height,
                transform: scale === 1 ? undefined : `scale(${scale})`,
                transformOrigin: 'top left',
              }}
            >
              <AgentRevealCard
                agent={agent}
                index={index}
                isRevealed={index < revealed}
                flipsComplete={flipsComplete}
              />
            </div>
          </div>
        ))}
      </div>

      <div className="mt-5 flex gap-1.5" aria-hidden="true">
        {agents.map((agent, index) => (
          <div
            key={agent.id}
            className={cn(
              'size-2 rounded-full transition-colors duration-300',
              index < revealed ? 'bg-zinc-700 dark:bg-white' : 'bg-zinc-300 dark:bg-white/30',
            )}
          />
        ))}
      </div>
    </div>
  );
}
