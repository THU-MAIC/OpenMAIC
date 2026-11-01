'use client';

/**
 * One roster card, front and back, with its flip — the classic agent reveal's
 * card (`AgentRevealModal`), shared so every surface that reveals a classroom's
 * cast shows the same card. The caller owns the pace (`revealed`) and the
 * layout; this owns the card.
 */
import { motion } from 'motion/react';
import { Sparkles } from 'lucide-react';
import { useI18n } from '@/lib/hooks/use-i18n';

export interface AgentRevealCardAgent {
  readonly id: string;
  readonly name: string;
  readonly role: string;
  readonly persona: string;
  readonly avatar: string;
  readonly color: string;
}

/** The card's own size, before any scaling a caller applies. */
export const AGENT_REVEAL_CARD_SIZE = { width: 196, height: 290 } as const;

export function isUrl(str: string): boolean {
  return str.startsWith('http') || str.startsWith('/') || str.startsWith('data:');
}

/** Lighten a hex color by mixing with white */
export function lighten(hex: string, amount: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const lr = Math.round(r + (255 - r) * amount);
  const lg = Math.round(g + (255 - g) * amount);
  const lb = Math.round(b + (255 - b) * amount);
  return `rgb(${lr},${lg},${lb})`;
}

const ROLE_ICONS: Record<string, string> = {
  teacher: '👨‍🏫',
  assistant: '🤝',
  student: '🎓',
};

export function AgentRevealCard({
  agent,
  index,
  isRevealed,
  flipsComplete,
}: {
  readonly agent: AgentRevealCardAgent;
  /** Position in the cast, for the staggered entrance. */
  readonly index: number;
  /** Front up (revealed) or back up. */
  readonly isRevealed: boolean;
  /** Every flip has finished: flatten the 3D context so the persona can scroll. */
  readonly flipsComplete: boolean;
}) {
  const { t } = useI18n();
  const roleIcon = ROLE_ICONS[agent.role] ?? '🎓';
  return (
    <motion.div
      className="group relative"
      style={{ width: 196, height: 290, perspective: 900 }}
      initial={{ opacity: 0, scale: 0.8 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ delay: index * 0.08, duration: 0.3 }}
    >
      <motion.div
        className="relative size-full"
        style={{
          transformStyle: flipsComplete ? 'flat' : 'preserve-3d',
        }}
        animate={{ rotateY: isRevealed ? 0 : 180 }}
        transition={{ duration: 0.6, ease: [0.23, 1, 0.32, 1] }}
      >
        {/* ====== FRONT FACE ====== */}
        <div
          className="absolute inset-0 overflow-clip rounded-2xl"
          style={{ backfaceVisibility: 'hidden' }}
        >
          {/* Outer colored border */}
          <div
            className="absolute inset-0 rounded-2xl p-[2px]"
            style={{
              background: `linear-gradient(160deg, ${agent.color}, ${lighten(agent.color, 0.35)}, ${agent.color})`,
            }}
          >
            {/* Inner card body */}
            <div className="relative flex size-full flex-col overflow-clip rounded-[14px] bg-white dark:bg-zinc-900">
              {/* Top gradient band with texture */}
              <div className="relative shrink-0 overflow-hidden" style={{ height: 56 }}>
                {/* Color gradient fill */}
                <div
                  className="absolute inset-0"
                  style={{
                    background: `linear-gradient(135deg, ${agent.color}30 0%, ${agent.color}10 100%)`,
                  }}
                />
                {/* Subtle noise texture */}
                <div
                  className="absolute inset-0 opacity-[0.04]"
                  style={{
                    backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E")`,
                  }}
                />
                {/* Decorative corner accent lines */}
                <svg
                  className="absolute right-0 top-0 size-16 text-white/[0.06]"
                  viewBox="0 0 64 64"
                >
                  <line x1="64" y1="0" x2="0" y2="64" stroke="currentColor" strokeWidth="1" />
                  <line x1="64" y1="16" x2="16" y2="64" stroke="currentColor" strokeWidth="1" />
                  <line x1="64" y1="32" x2="32" y2="64" stroke="currentColor" strokeWidth="1" />
                </svg>
              </div>

              {/* Avatar — overlapping the band */}
              <div className="relative z-10 -mt-7 flex justify-center">
                <div
                  className="flex size-[50px] items-center justify-center rounded-full border-[2.5px] shadow-lg shadow-black/40"
                  style={{
                    borderColor: agent.color,
                    backgroundColor: '#f8f8fc',
                  }}
                >
                  {isUrl(agent.avatar) ? (
                    <img
                      src={agent.avatar}
                      alt={agent.name}
                      className="size-full rounded-full object-cover"
                    />
                  ) : (
                    <span className="text-2xl">{agent.avatar || agent.name.charAt(0)}</span>
                  )}
                </div>
              </div>

              {/* Name + role row */}
              <div className="mt-1.5 flex flex-col items-center gap-0.5 px-3">
                <h3
                  className="max-w-full truncate text-center text-[13px] font-bold tracking-wide"
                  style={{ color: agent.color }}
                >
                  {agent.name}
                </h3>
                <span
                  className="inline-flex items-center gap-1 rounded-full px-2 py-px text-[10px] font-medium"
                  style={{
                    color: agent.color,
                    backgroundColor: `${agent.color}12`,
                  }}
                >
                  <span className="text-[9px]">{roleIcon}</span>
                  {t(`settings.agentRoles.${agent.role}`)}
                </span>
              </div>

              {/* Thin ornamental divider */}
              <div className="mx-5 mt-2 flex items-center gap-2">
                <div
                  className="h-px flex-1"
                  style={{
                    background: `linear-gradient(to right, transparent, ${agent.color}40, transparent)`,
                  }}
                />
                <div
                  className="size-1 rounded-full"
                  style={{ backgroundColor: `${agent.color}60` }}
                />
                <div
                  className="h-px flex-1"
                  style={{
                    background: `linear-gradient(to right, transparent, ${agent.color}40, transparent)`,
                  }}
                />
              </div>

              {/* Persona text — fills remaining space */}
              <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3.5 pt-1.5 pb-3">
                <p className="text-left text-[10.5px] leading-[1.65] text-zinc-600 dark:text-zinc-400">
                  {agent.persona}
                </p>
              </div>

              {/* Bottom edge glow */}
              <div
                className="pointer-events-none absolute inset-x-0 bottom-0 h-8"
                style={{
                  background: `linear-gradient(to top, ${agent.color}08, transparent)`,
                }}
              />
            </div>
          </div>
        </div>

        {/* ====== BACK FACE ====== */}
        <div
          className="absolute inset-0 overflow-hidden rounded-2xl"
          style={{
            backfaceVisibility: 'hidden',
            transform: 'rotateY(180deg)',
          }}
        >
          {/* Gradient border matching front style */}
          <div
            className="absolute inset-0 rounded-2xl p-[2px]"
            style={{
              background: 'linear-gradient(160deg, #6366f1, #a855f7, #6366f1)',
            }}
          >
            <div
              className="relative flex size-full flex-col items-center justify-center rounded-[14px]"
              style={{
                background: 'linear-gradient(145deg, #1e1b4b 0%, #312e81 40%, #1e1b4b 100%)',
              }}
            >
              {/* Decorative inner border */}
              <div className="absolute inset-3 rounded-xl border border-white/[0.08]" />
              {/* Diamond pattern corners */}
              <svg className="absolute left-3 top-3 size-5 text-white/[0.07]" viewBox="0 0 20 20">
                <path d="M10 0 L20 10 L10 20 L0 10 Z" fill="currentColor" />
              </svg>
              <svg className="absolute right-3 top-3 size-5 text-white/[0.07]" viewBox="0 0 20 20">
                <path d="M10 0 L20 10 L10 20 L0 10 Z" fill="currentColor" />
              </svg>
              <svg
                className="absolute bottom-3 left-3 size-5 text-white/[0.07]"
                viewBox="0 0 20 20"
              >
                <path d="M10 0 L20 10 L10 20 L0 10 Z" fill="currentColor" />
              </svg>
              <svg
                className="absolute bottom-3 right-3 size-5 text-white/[0.07]"
                viewBox="0 0 20 20"
              >
                <path d="M10 0 L20 10 L10 20 L0 10 Z" fill="currentColor" />
              </svg>
              {/* Center icon */}
              <Sparkles className="size-9 text-purple-300/70" />
              <span className="mt-1.5 text-xl font-bold text-purple-200/60">?</span>
            </div>
          </div>
        </div>
      </motion.div>
    </motion.div>
  );
}
