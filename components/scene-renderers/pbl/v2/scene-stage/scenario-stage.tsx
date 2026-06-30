'use client';

/**
 * PBL v2 — Scenario stage banner + entrance animation (SCENARIO ONLY,
 * increment 5).
 *
 * Mounted at the top of the chat column. Behaviour:
 *  - Renders ONLY for scenario projects while a roleplay stage is showing
 *    (returns null otherwise → zero footprint on ordinary projects and on
 *    prep/wrapup).
 *  - On a FRESH first entry into the FIRST roleplay stage (the learner has
 *    not acted in the scene yet — robustly detected from project state, so
 *    it correctly replays after a progress reset) it auto-expands and plays
 *    the entrance animation, then STAYS expanded until the learner collapses
 *    it themselves. Later roleplay stages start collapsed (slim bar).
 *  - The backdrop animates its entrance every time the banner expands, so it
 *    is never a static image. Tapping the character plays a cosmetic wave
 *    (no task, no data — just life).
 *
 * The backdrop is driven by the design-time, LLM-authored `scenario.sceneVisual`
 * (a project-wide caption + palette + emoji motifs that fit ALL roleplay
 * stages). Every field is sanitized at render time with neutral fallbacks, so
 * an older package without a sceneVisual still renders safely. All visuals are
 * deterministic (no assets/network) → stable for any scenario.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Image from 'next/image';
import { motion, AnimatePresence } from 'motion/react';
import { ChevronDown, ChevronUp, Hand } from 'lucide-react';
import type { PBLProjectV2 } from '@/lib/pbl/v2/types';
import { useI18n } from '@/lib/hooks/use-i18n';
import { cn } from '@/lib/utils/cn';
import { PBL_SIMULATOR_AGENT_ID } from '@/lib/pbl/v2/operations/progress';
import { SceneBackdrop } from './scene-backdrop';
import { sanitizeSceneVisual } from './scene-types';

interface Props {
  readonly project: PBLProjectV2;
}

export function ScenarioStage({ project }: Props) {
  const { t } = useI18n();

  // --- Gate: scenario project, currently in a roleplay stage ---
  const scenario = project.scenario;
  const stageMilestone = useMemo(() => {
    if (!scenario) return undefined;
    const active = project.milestones.find((m) => m.status === 'active');
    if (active) return active;
    // During a stage handover there is briefly no active milestone — anchor
    // to the just-completed one so the banner stays put mid-scene.
    const h = project.pendingHandover;
    if (h && !h.consumed) return project.milestones.find((m) => m.id === h.completedMilestoneId);
    return undefined;
  }, [scenario, project.milestones, project.pendingHandover]);
  const isRoleplay = !!scenario && stageMilestone?.scenarioStage === 'roleplay';

  const firstRoleplayId = useMemo(
    () =>
      project.milestones
        .filter((m) => m.scenarioStage === 'roleplay')
        .sort((a, b) => a.order - b.order)[0]?.id,
    [project.milestones],
  );
  const isFirstRoleplayStage = !!stageMilestone && stageMilestone.id === firstRoleplayId;

  // Fresh entry = the learner has not spoken in the scene yet. Read off the
  // Simulator thread's user messages, which a progress reset clears — so the
  // intro replays on a fresh playthrough but not on every render / re-entry.
  const learnerHasActed = useMemo(
    () =>
      (project.threads.find((th) => th.agentId === PBL_SIMULATOR_AGENT_ID)?.messages ?? []).some(
        (m) => m.roleType === 'user',
      ),
    [project.threads],
  );
  const freshFirstScene = isRoleplay && isFirstRoleplayStage && !learnerHasActed;

  const [expanded, setExpanded] = useState(false);
  const autoExpandedRef = useRef(false);

  // Auto-expand once on a fresh first entry so the learner sees the entrance.
  // Deferred to after mount (rAF) so the first render matches SSR (no
  // hydration mismatch) and no setState runs synchronously in the effect.
  useEffect(() => {
    if (!freshFirstScene || autoExpandedRef.current) return;
    autoExpandedRef.current = true;
    const raf = window.requestAnimationFrame(() => setExpanded(true));
    return () => window.cancelAnimationFrame(raf);
  }, [freshFirstScene]);

  // Cosmetic character wave (retrigger via key bump).
  const [waveKey, setWaveKey] = useState(0);
  const wave = useCallback(() => setWaveKey((k) => k + 1), []);

  if (!isRoleplay || !scenario) return null;

  const character = scenario.characters?.[0];
  const visual = sanitizeSceneVisual(scenario.sceneVisual);
  const accent = visual.accent;
  // Project-wide scene caption (LLM-authored to fit all roleplay stages);
  // neutral label when an older package has no caption.
  const caption = visual.caption ?? t('pbl.v2.scene.label');
  const title = stageMilestone?.title || project.title;

  return (
    <div className="px-3 pt-3">
      <div
        className="relative overflow-hidden rounded-2xl border border-white/10 shadow-[0_10px_34px_rgba(6,16,34,0.34)]"
        style={{ boxShadow: `inset 0 1px 0 rgba(255,255,255,0.08)` }}
      >
        <AnimatePresence initial={false}>
          {expanded && (
            <motion.div
              key="stage"
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 168, opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
              className="relative w-full"
            >
              <SceneBackdrop visual={visual} />
              {/* character figure */}
              <div className="absolute bottom-3 left-4 flex items-end gap-3">
                <motion.button
                  type="button"
                  onClick={wave}
                  title={t('pbl.v2.scene.greetHint')}
                  aria-label={t('pbl.v2.scene.greetHint')}
                  className="group relative"
                  initial={{ opacity: 0, x: -24 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: 0.35, duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
                >
                  <motion.span
                    className="block"
                    key={`wrap-${waveKey}`}
                    animate={
                      waveKey === 0
                        ? undefined
                        : { rotate: [0, -7, 7, -4, 0], scale: [1, 1.08, 1.02, 1.06, 1] }
                    }
                    transition={{ duration: 0.7 }}
                  >
                    <CharacterAvatar
                      name={character?.name}
                      avatar={character?.avatar}
                      accent={accent}
                    />
                  </motion.span>
                  <motion.span
                    aria-hidden
                    key={`hand-${waveKey}`}
                    className="absolute -right-1 -top-2"
                    initial={{ opacity: 0, rotate: 0 }}
                    animate={
                      waveKey === 0
                        ? { opacity: 0 }
                        : { rotate: [0, -18, 14, -10, 0], opacity: [1, 1, 1, 1, 0] }
                    }
                    transition={{ duration: 0.8 }}
                  >
                    <Hand className="h-4 w-4" style={{ color: accent }} />
                  </motion.span>
                </motion.button>
                <motion.div
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.6, duration: 0.5 }}
                  className="mb-1"
                >
                  {character?.name && (
                    <div className="text-sm font-semibold text-white drop-shadow">
                      {character.name}
                    </div>
                  )}
                  <div className="text-[11px] font-medium tracking-wide text-white/70">
                    {caption}
                  </div>
                </motion.div>
              </div>
              {/* scene title */}
              <motion.div
                initial={{ opacity: 0, y: -8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.7, duration: 0.5 }}
                className="absolute right-4 top-3 max-w-[55%] text-right text-sm font-semibold text-white/90 drop-shadow"
              >
                {title}
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* slim bar — always present; doubles as the expand/collapse control */}
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className={cn(
            'flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors',
            'bg-[#101b32]/90 hover:bg-[#16233f]/90',
          )}
        >
          <span
            className="flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded-full text-xs font-bold text-white"
            style={{ background: accent }}
            aria-hidden
          >
            <CharacterAvatar name={character?.name} avatar={character?.avatar} compact />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-xs font-semibold text-white">
              {character?.name ?? caption}
            </span>
            <span className="block truncate text-[10px] text-white/55">
              {caption} · {title}
            </span>
          </span>
          <span className="flex items-center gap-1 text-[10px] text-white/50">
            {expanded ? t('pbl.v2.scene.collapse') : t('pbl.v2.scene.expand')}
            {expanded ? (
              <ChevronUp className="h-3.5 w-3.5" />
            ) : (
              <ChevronDown className="h-3.5 w-3.5" />
            )}
          </span>
        </button>
      </div>
    </div>
  );
}

function CharacterAvatar({
  name,
  avatar,
  accent,
  compact,
}: {
  name?: string;
  avatar?: string;
  accent?: string;
  compact?: boolean;
}) {
  const initial = (name?.trim()?.[0] ?? '·').toUpperCase();
  // Only LOCAL paths are rendered via next/image. External (http) URLs would
  // need their domain pre-registered in next.config or next/image throws at
  // runtime — since avatars are an optional design-time field, we degrade
  // gracefully to the initial for non-local values instead of risking a crash.
  const isImg = !!avatar && avatar.startsWith('/');
  if (compact) {
    return isImg ? (
      <Image src={avatar} alt="" width={28} height={28} className="h-7 w-7 object-cover" />
    ) : (
      <span>{initial}</span>
    );
  }
  return (
    <span
      className="flex h-12 w-12 items-center justify-center overflow-hidden rounded-full border-2 text-lg font-bold text-white shadow-[0_6px_18px_rgba(0,0,0,0.35)]"
      style={{ borderColor: 'rgba(255,255,255,0.7)', background: accent ?? '#9d8cff' }}
    >
      {isImg ? (
        <Image src={avatar} alt="" width={48} height={48} className="h-12 w-12 object-cover" />
      ) : (
        initial
      )}
    </span>
  );
}
