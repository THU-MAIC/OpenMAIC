'use client';

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { ArrowRight, Check, FileText, LoaderCircle } from 'lucide-react';
import { AvatarDisplay } from '@/components/ui/avatar-display';
import { useI18n } from '@/lib/hooks/use-i18n';
import type { ProjectHeroDetails } from '@/lib/pbl/project-hero';
import type { AgentRole } from '@/lib/pbl/v3/domain/project/project-schema';
import { ROLE_PERSONAS } from '@/lib/pbl/v3/personas';
import { trimmedPBLText } from '@/lib/pbl/v2/readers';
import { cn } from '@/lib/utils';
import { computeFitScale } from '../v2/fit-scale';

/** The order the learner meets them in: understand and decide, plan, build, look back. */
const CAST: readonly AgentRole[] = ['discussion', 'planner', 'coder', 'mentor'];
const EASE = [0.16, 1, 0.3, 1] as const;
/** A beat of typing before each line, long enough to be read as someone about to speak. */
const TYPING_MS = 620;
const READ_MS = 760;

/**
 * The way into a project, with its company already at the table. The four companions are
 * mid-conversation about what they will do with the learner: each line arrives after a beat
 * of typing, in the order the project runs, so the page explains the journey by letting the
 * people on it speak. Then they wait, and the way in is the only thing left to do.
 */
export function ProjectCast({
  details,
  started,
  completed = false,
  launching = false,
  onStart,
  onContinue,
  onReport,
}: {
  details: ProjectHeroDetails;
  started: boolean;
  completed?: boolean;
  launching?: boolean;
  onStart: () => void;
  onContinue: () => void;
  onReport?: () => void;
}) {
  const { t } = useI18n();
  const still = useReducedMotion();
  const gains = (details.gains ?? []).map(trimmedPBLText).filter(Boolean).slice(0, 3);

  // How far the conversation has come: lines said, and whether the next speaker is typing.
  const [said, setSaid] = useState(0);
  const [typing, setTyping] = useState(false);
  useEffect(() => {
    if (still || said >= CAST.length) return;
    const start = setTimeout(() => setTyping(true), said === 0 ? 420 : READ_MS);
    const land = setTimeout(
      () => {
        setTyping(false);
        setSaid((count) => count + 1);
      },
      (said === 0 ? 420 : READ_MS) + TYPING_MS,
    );
    return () => {
      clearTimeout(start);
      clearTimeout(land);
    };
  }, [said, still]);
  const lines = still ? CAST.length : said;
  const settled = lines >= CAST.length;

  // The page lives in the stage's fixed box: scale to fit instead of clipping the way in.
  const box = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  useLayoutEffect(() => {
    const outer = box.current,
      inner = content.current;
    if (!outer || !inner) return;
    const measure = () => {
      const next = computeFitScale({
        containerWidth: outer.clientWidth,
        containerHeight: outer.clientHeight,
        contentWidth: inner.offsetWidth,
        contentHeight: inner.offsetHeight,
      });
      setScale((previous) => (Math.abs(previous - next) < 0.002 ? previous : next));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(outer);
    observer.observe(inner);
    return () => observer.disconnect();
  }, []);

  const speaker = (role: AgentRole, size: number) => (
    <span
      className="block shrink-0 overflow-hidden rounded-full bg-background ring-2"
      style={
        { width: size, height: size, '--tw-ring-color': ROLE_PERSONAS[role].color } as CSSProperties
      }
    >
      <AvatarDisplay src={ROLE_PERSONAS[role].avatar} alt="" />
    </span>
  );

  return (
    <div
      ref={box}
      data-testid="pbl-project-cast"
      className="relative h-full w-full overflow-hidden bg-background selection:bg-primary/20"
    >
      {/* One wash of the product's violet behind the conversation, where the eye should go. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-y-0 right-0 w-[58%] bg-[radial-gradient(120%_90%_at_78%_45%,color-mix(in_srgb,var(--primary)_14%,transparent),transparent_68%)]"
      />
      <div className="absolute inset-0 flex items-center justify-center">
        <div
          ref={content}
          className="relative grid w-[1180px] grid-cols-[minmax(0,1fr)_500px] items-center gap-16 px-12 py-10"
          style={
            scale < 1 ? { transform: `scale(${scale})`, transformOrigin: 'center' } : undefined
          }
        >
          <div className="min-w-0">
            <h1 className="text-balance break-keep text-[2.75rem] font-extrabold leading-[1.12] tracking-[-0.02em] text-foreground">
              {details.title}
            </h1>
            <p className="mt-5 max-w-[34rem] text-[16px] leading-[1.7] text-foreground/70">
              {details.finishedWork || details.description}
            </p>
            {gains.length > 0 && (
              <ul className="mt-7 space-y-2.5">
                {gains.map((gain) => (
                  <li
                    key={gain}
                    className="flex items-start gap-3 text-[14.5px] text-foreground/85"
                  >
                    <span className="mt-[3px] grid size-[18px] shrink-0 place-items-center rounded-full bg-primary/12 text-primary">
                      <Check className="size-3" strokeWidth={3} />
                    </span>
                    {gain}
                  </li>
                ))}
              </ul>
            )}
            <div className="mt-10 flex items-center gap-3">
              <motion.button
                type="button"
                data-testid="pbl-cast-start"
                onClick={() => (started ? onContinue() : onStart())}
                disabled={launching}
                // The one authored moment ends here: when the company has spoken, the way in answers.
                animate={
                  settled && !still
                    ? {
                        boxShadow: [
                          '0 10px 26px -12px color-mix(in srgb, var(--primary) 55%, transparent)',
                          '0 16px 40px -10px color-mix(in srgb, var(--primary) 80%, transparent)',
                          '0 10px 26px -12px color-mix(in srgb, var(--primary) 55%, transparent)',
                        ],
                      }
                    : {
                        boxShadow:
                          '0 10px 26px -12px color-mix(in srgb, var(--primary) 55%, transparent)',
                      }
                }
                transition={{ duration: 1.6, ease: 'easeInOut', times: [0, 0.4, 1] }}
                whileHover={{ y: -2 }}
                whileTap={{ y: 0, scale: 0.985 }}
                className="flex h-14 items-center gap-2.5 rounded-2xl bg-primary px-8 text-[16px] font-semibold text-primary-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:opacity-70"
              >
                {launching && <LoaderCircle className="size-4 animate-spin" />}
                {t(
                  completed
                    ? 'pblV3.reportCopy.viewWorkbench'
                    : started
                      ? 'pbl.v2.hero.continueProject'
                      : 'pbl.v2.hero.startProject',
                )}
                <ArrowRight className="size-[18px]" />
              </motion.button>
              {completed && onReport && (
                <button
                  type="button"
                  onClick={onReport}
                  className="flex h-14 items-center gap-2 rounded-2xl px-5 text-[15px] font-medium text-foreground/80 outline-none transition-colors hover:bg-foreground/[0.05] focus-visible:ring-2 focus-visible:ring-primary"
                >
                  <FileText className="size-4" />
                  {t('pblV3.report')}
                </button>
              )}
            </div>
          </div>

          {/* The company, mid-conversation. Rows are offset by who speaks, not laid out as cards. */}
          <div
            className="relative flex min-h-[452px] flex-col justify-center gap-5"
            aria-label={t('pblV3.cast.title')}
          >
            {/* Every line has its place from the start, so nothing moves when one arrives:
                the speaker fades in typing, and the words take the dots' place where they are. */}
            {CAST.map((role, index) => {
              const here = index < lines;
              const writing = typing && index === lines;
              return (
                <motion.div
                  key={role}
                  data-testid="pbl-cast-member"
                  data-said={here || undefined}
                  initial={false}
                  animate={{ opacity: here || writing ? 1 : 0, y: here || writing ? 0 : 10 }}
                  transition={{ duration: 0.45, ease: EASE }}
                  className={cn('flex items-start gap-3.5', index % 2 === 1 && 'pl-12')}
                  aria-hidden={!here}
                >
                  {speaker(role, 40)}
                  <div className="min-w-0">
                    <div className="mb-1.5 flex items-baseline gap-2">
                      <span className="text-[14px] font-semibold text-foreground">
                        {t(`pblV3.personas.${role}`)}
                      </span>
                      <span
                        className="text-[12px] font-medium"
                        style={{ color: ROLE_PERSONAS[role].color }}
                      >
                        {t(`pblV3.cast.${role}.part`)}
                      </span>
                    </div>
                    <div className="relative">
                      <motion.p
                        initial={false}
                        animate={{
                          opacity: here ? 1 : 0,
                          scale: here ? 1 : 0.97,
                          filter: here ? 'blur(0px)' : 'blur(4px)',
                        }}
                        transition={{ duration: 0.4, ease: EASE }}
                        className="max-w-[25rem] origin-top-left text-pretty rounded-2xl rounded-tl-md px-4 py-2.5 text-[15px] leading-[1.6] text-foreground shadow-[0_6px_18px_-12px_rgba(15,23,42,0.35)]"
                        style={{
                          backgroundColor: `color-mix(in srgb, ${ROLE_PERSONAS[role].color} 10%, var(--background))`,
                        }}
                      >
                        {t(`pblV3.cast.${role}.line`)}
                      </motion.p>
                      <motion.span
                        aria-hidden="true"
                        initial={false}
                        animate={{ opacity: writing ? 1 : 0 }}
                        transition={{ duration: writing ? 0.25 : 0.18, ease: 'easeOut' }}
                        className="absolute left-0 top-0 flex h-[44px] items-center gap-1.5 rounded-2xl rounded-tl-md px-4"
                        style={{
                          backgroundColor: `color-mix(in srgb, ${ROLE_PERSONAS[role].color} 10%, var(--background))`,
                        }}
                      >
                        {[0, 1, 2].map((dot) => (
                          <motion.span
                            key={dot}
                            className="size-1.5 rounded-full bg-foreground/45"
                            animate={
                              writing
                                ? { opacity: [0.3, 1, 0.3], y: [0, -2, 0] }
                                : { opacity: 0.3, y: 0 }
                            }
                            transition={
                              writing
                                ? { duration: 0.9, repeat: Infinity, delay: dot * 0.14 }
                                : { duration: 0.1 }
                            }
                          />
                        ))}
                      </motion.span>
                    </div>
                  </div>
                </motion.div>
              );
            })}
            <motion.p
              initial={false}
              animate={{ opacity: settled ? 1 : 0, y: settled ? 0 : 6 }}
              transition={{ duration: 0.5, ease: EASE, delay: settled && !still ? 0.35 : 0 }}
              className="flex items-center gap-2.5 pl-1 pt-1 text-[13px] text-foreground/60"
            >
              <span className="flex -space-x-1.5">
                {CAST.map((role) => (
                  <span key={role} className="rounded-full ring-2 ring-background">
                    {speaker(role, 20)}
                  </span>
                ))}
              </span>
              {t('pblV3.cast.hint')}
            </motion.p>
          </div>
        </div>
      </div>
    </div>
  );
}
