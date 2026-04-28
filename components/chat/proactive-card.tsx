'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { motion } from 'motion/react';
import { Play, Pause, X } from 'lucide-react';
import { useI18n } from '@/lib/hooks/use-i18n';
import type { DiscussionAction } from '@/lib/types/action';

interface ProactiveCardProps {
  action: DiscussionAction;
  mode: 'playback' | 'paused' | 'autonomous';
  /** Ref to the anchor element the card points to (avatar, etc.) */
  anchorRef: React.RefObject<HTMLElement | null>;
  /** Where the card prefers to align relative to the anchor */
  align?: 'left' | 'right';
  /** Portal target — defaults to document.body. Pass the fullscreen container
   *  when in presentation mode so the card stays visible inside the top-layer. */
  portalContainer?: HTMLElement | null;
  agentName?: string;
  agentAvatar?: string;
  agentColor?: string;
  onSkip: () => void;
  onListen: () => void;
  onTogglePause: () => void;
}

const CARD_WIDTH = 256; // w-64
const VIEWPORT_PAD = 12;

/**
 * 主动讨论卡片组件
 *
 * 通过 React Portal 渲染到 document.body，使用 fixed 定位，
 * 不受父级 overflow/z-index stacking context 影响。
 */
export const ProactiveCard = ({
  action,
  mode,
  anchorRef,
  align = 'right',
  portalContainer,
  agentName,
  agentAvatar,
  agentColor,
  onSkip,
  onListen,
  onTogglePause,
}: ProactiveCardProps) => {
  const { t } = useI18n();
  const [progress, setProgress] = useState(100);
  const skippedRef = useRef(false);
  const isPaused = mode === 'paused';

  // Computed position state
  const [pos, setPos] = useState<{
    left: number;
    bottom: number;
    tailOffset: number;
  } | null>(null);

  const updatePosition = useCallback(() => {
    const el = anchorRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const anchorCenterX = rect.left + rect.width / 2;
    const anchorTop = rect.top;

    // Center card on anchor, clamped to viewport
    let cardLeft = anchorCenterX - CARD_WIDTH / 2;
    cardLeft = Math.max(
      VIEWPORT_PAD,
      Math.min(window.innerWidth - CARD_WIDTH - VIEWPORT_PAD, cardLeft),
    );
    const tailOffset = Math.max(16, Math.min(CARD_WIDTH - 16, anchorCenterX - cardLeft));
    const bottom = window.innerHeight - anchorTop + 12; // 12px gap above anchor

    setPos({ left: cardLeft, bottom, tailOffset });
  }, [anchorRef]);

  // Continuously track anchor position via rAF to handle CSS transitions, sidebar collapse, etc.
  useEffect(() => {
    let rafId: number;
    const tick = () => {
      updatePosition();
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [updatePosition]);

  useEffect(() => {
    if (mode !== 'playback') return;

    const duration = 5000;
    const interval = 50;
    const step = (interval / duration) * 100;

    const timer = setInterval(() => {
      setProgress((prev) => {
        const newProgress = prev - step;
        if (newProgress <= 0) {
          clearInterval(timer);
          return 0;
        }
        return newProgress;
      });
    }, interval);

    return () => clearInterval(timer);
  }, [mode]);

  useEffect(() => {
    if (progress <= 0 && !skippedRef.current && mode === 'playback') {
      skippedRef.current = true;
      onSkip();
    }
  }, [progress, onSkip, mode]);

  if (!pos) return null;

  const card = (
    <motion.div
      initial={{ opacity: 0, y: 10, scale: 0.95 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, scale: 0.95, transition: { duration: 0.2 } }}
      className="fixed w-64 z-[9999] pointer-events-auto"
      style={{
        left: pos.left,
        bottom: pos.bottom,
        ...(align === 'left'
          ? { transformOrigin: 'bottom left' }
          : { transformOrigin: 'bottom right' }),
      }}
    >
      <div className="relative">
        {/* Close button */}
        <button
          onClick={(e) => {
            e.stopPropagation();
            onSkip();
          }}
          className="absolute -top-2 -right-2 w-6 h-6 bg-white dark:bg-gray-800 shadow-md border border-gray-100 dark:border-gray-700 rounded-full flex items-center justify-center text-gray-400 hover:text-red-500 hover:scale-110 transition-all z-20 group/close"
          title={t('proactiveCard.skip')}
        >
          <X className="w-3 h-3 stroke-[2.5]" />
        </button>

        {/* Triangle Tail */}
        <div
          className="absolute -bottom-[6px] w-3 h-3 bg-white dark:bg-gray-800 border-b border-r border-gray-100 dark:border-gray-700 z-10"
          style={{
            left: `${pos.tailOffset}px`,
            transform: 'translateX(-50%) rotate(45deg)',
          }}
        />

        {/* Card body */}
        <div className="bg-white/95 dark:bg-gray-800/95 backdrop-blur-sm p-3.5 rounded-2xl shadow-[0_8px_32px_rgba(0,0,0,0.12)] border border-gray-100 dark:border-gray-700 flex flex-col gap-2.5 relative overflow-hidden">
          {/* Progress Bar */}
          <div className="absolute top-0 left-0 right-0 h-1 bg-gray-50/50 dark:bg-gray-700/50">
            <div
              className={`h-full transition-all duration-[50ms] ease-linear ${
                isPaused
                  ? 'bg-gray-300 dark:bg-gray-600'
                  : 'bg-gradient-to-r from-amber-400 to-amber-500 dark:from-amber-500 dark:to-amber-600'
              }`}
              style={{ width: `${progress}%` }}
            />
          </div>

          {/* Header */}
          <div className="flex items-center gap-2 px-0.5 pt-1">
            {agentAvatar && (
              <div className="w-6 h-6 rounded-full overflow-hidden shrink-0 border border-gray-100 dark:border-gray-700">
                <img
                  src={agentAvatar}
                  alt={agentName || ''}
                  className="w-full h-full object-cover"
                />
              </div>
            )}
            <div className="flex items-center gap-1.5 flex-1 min-w-0">
              {agentName && (
                <span className="text-[11px] font-semibold text-gray-700 dark:text-gray-300 truncate">
                  {agentName}
                </span>
              )}
              <span
                className="text-[9px] font-black uppercase tracking-widest px-1.5 py-0.5 rounded-full shrink-0"
                style={{
                  color: agentColor || '#d97706',
                  backgroundColor: agentColor ? `${agentColor}18` : 'rgba(217, 119, 6, 0.08)',
                }}
              >
                {t('proactiveCard.discussion')}
              </span>
            </div>
            <span
              className={`text-[10px] font-bold tabular-nums shrink-0 ${
                isPaused ? 'text-gray-300 dark:text-gray-600' : 'text-gray-400 dark:text-gray-500'
              }`}
            >
              {Math.max(0, Math.ceil((progress / 100) * 5))}s
            </span>
          </div>

          <p className="text-[13px] font-bold text-gray-800 dark:text-gray-200 leading-snug px-0.5">
            {action.topic}
          </p>

          <div className="flex items-center gap-1.5 mt-0.5">
            <button
              onClick={(e) => {
                e.stopPropagation();
                onListen();
              }}
              className="flex-1 py-2 bg-gradient-to-r from-amber-400 to-amber-500 hover:from-amber-500 hover:to-amber-600 dark:from-amber-500 dark:to-amber-600 dark:hover:from-amber-600 dark:hover:to-amber-700 text-white text-[11px] font-black rounded-lg flex items-center justify-center gap-1.5 transition-all active:scale-[0.97] shadow-sm shadow-amber-200/50 dark:shadow-amber-800/50"
            >
              <Play className="w-3 h-3 fill-current" /> {t('proactiveCard.join')}
            </button>

            <button
              onClick={(e) => {
                e.stopPropagation();
                onTogglePause();
              }}
              className={`p-2 aspect-square rounded-lg border transition-colors active:scale-90 ${
                isPaused
                  ? 'bg-amber-50 dark:bg-amber-900/30 text-amber-600 dark:text-amber-400 border-amber-200 dark:border-amber-700 hover:bg-amber-100 dark:hover:bg-amber-900/50'
                  : 'bg-gray-50 hover:bg-gray-100 dark:bg-gray-700 dark:hover:bg-gray-600 text-gray-400 hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-300 border-gray-100 dark:border-gray-600'
              }`}
              title={isPaused ? t('proactiveCard.resume') : t('proactiveCard.pause')}
            >
              {isPaused ? (
                <Play className="w-3 h-3 fill-current" />
              ) : (
                <Pause className="w-3 h-3 fill-current" />
              )}
            </button>
          </div>
        </div>
      </div>
    </motion.div>
  );

  return createPortal(card, portalContainer || document.body);
};
