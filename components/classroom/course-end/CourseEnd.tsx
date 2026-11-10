'use client';

/**
 * The end of a course: a state over the last page, never a page of its own, so the deck
 * still counts only its real pages. A medal, what the quizzes came to, what to do next,
 * and everything underneath as it was left.
 *
 * Under two seconds and never in the way: its buttons work from the first frame, and a
 * click or Esc during the sequence skips to its end.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ListChecks, ListX, RotateCcw, X, type LucideIcon } from 'lucide-react';
import { useI18n } from '@/lib/hooks/use-i18n';
import type { CompleteSummary } from '@/lib/classroom/complete-summary';
import { courseEndActions, tiltAllowed, type CourseEndAction } from '@/lib/classroom/course-end';
import { cn } from '@/lib/utils';
import { BADGE } from './badges';
import './course-end.css';

/** The sequence, after which a click and Esc mean close rather than skip. */
const SEQUENCE_MS = 1800;

const ACTION_ICON: Record<CourseEndAction, LucideIcon> = {
  reviewWrong: ListX,
  doQuiz: ListChecks,
  restart: RotateCcw,
};

export function CourseEnd({
  summary,
  courseName,
  pageCount,
  blurBehind,
  onAction,
  onDismiss,
}: {
  readonly summary: CompleteSummary;
  readonly courseName: string;
  readonly pageCount: number;
  /** Blur what is behind. A live iframe is costly to blur, so it is only dimmed. */
  readonly blurBehind: boolean;
  readonly onAction: (action: CourseEndAction) => void;
  readonly onDismiss: () => void;
}) {
  const { t } = useI18n();
  const [settled, setSettled] = useState(false);
  const tiltRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const settledRef = useRef(false);
  const dismissRef = useRef(onDismiss);
  useEffect(() => {
    dismissRef.current = onDismiss;
  }, [onDismiss]);

  const settle = () => {
    settledRef.current = true;
    setSettled(true);
  };

  useEffect(() => {
    const timer = window.setTimeout(settle, SEQUENCE_MS);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      if (settledRef.current) dismissRef.current();
      else settle();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  // Centred in an odd space the card lands on half a pixel, blurring its icons.
  useLayoutEffect(() => {
    const root = rootRef.current;
    const card = cardRef.current;
    if (!root || !card || typeof ResizeObserver === 'undefined') return;
    const align = () => {
      root.style.paddingBottom = '';
      const { paddingTop, paddingBottom } = getComputedStyle(root);
      const free =
        root.clientHeight - card.offsetHeight - parseFloat(paddingTop) - parseFloat(paddingBottom);
      if (free > 0 && free % 2 === 1)
        root.style.paddingBottom = `${parseFloat(paddingBottom) + 1}px`;
    };
    align();
    const resized = new ResizeObserver(align);
    resized.observe(root);
    return () => resized.disconnect();
  }, []);

  // The medal leans toward the pointer. Only a real pointer, and only with motion on.
  useEffect(() => {
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const fine = window.matchMedia('(pointer: fine)').matches;
    if (!tiltAllowed(reduced, fine)) return;
    const current = { x: 0, y: 0 };
    const target = { x: 0, y: 0 };
    const onMove = (event: PointerEvent) => {
      const el = tiltRef.current;
      if (!el) return;
      const box = el.getBoundingClientRect();
      const clamp = (v: number) => Math.max(-1, Math.min(1, v));
      target.x = clamp((event.clientX - (box.left + box.width / 2)) / 240);
      target.y = clamp((event.clientY - (box.top + box.height / 2)) / 200);
    };
    let frame = 0;
    const tick = () => {
      current.x += (target.x - current.x) * 0.1;
      current.y += (target.y - current.y) * 0.1;
      const el = tiltRef.current;
      if (el) {
        el.style.setProperty('--ce-rx', `${(-current.y * 16).toFixed(2)}deg`);
        el.style.setProperty('--ce-ry', `${(current.x * 18).toFixed(2)}deg`);
        el.style.setProperty('--ce-sx', `${(50 + current.x * 38).toFixed(1)}%`);
        el.style.setProperty('--ce-sy', `${(45 + current.y * 38).toFixed(1)}%`);
      }
      frame = requestAnimationFrame(tick);
    };
    window.addEventListener('pointermove', onMove);
    frame = requestAnimationFrame(tick);
    return () => {
      window.removeEventListener('pointermove', onMove);
      cancelAnimationFrame(frame);
    };
  }, []);

  const actions = courseEndActions(summary);
  // A score over part of the quizzes would say something untrue about the course.
  const scored = summary.unattemptedQuizIds.length === 0 && summary.quiz;
  const titleId = 'course-end-title';

  return (
    <div
      ref={rootRef}
      className={cn('ce-root', blurBehind && 'ce-blur')}
      data-testid="course-end"
      data-badge={BADGE.id}
      data-skip={settled ? 'true' : undefined}
      onClick={(event) => {
        if (!settledRef.current) {
          settle();
          return;
        }
        if (!cardRef.current?.contains(event.target as Node)) onDismiss();
      }}
    >
      <div
        ref={cardRef}
        role="dialog"
        aria-labelledby={titleId}
        className="ce-card"
        data-testid="course-end-card"
      >
        <button
          type="button"
          className="ce-x"
          data-testid="course-end-close"
          aria-label={t('classroomEnd.close')}
          onClick={onDismiss}
        >
          <X size={14} aria-hidden />
        </button>
        <div className="ce-medal">
          <div className="ce-drop">
            <div ref={tiltRef} className="ce-tilt">
              <div className="ce-shadow" />
              <BADGE.Art />
            </div>
          </div>
        </div>
        <div className="ce-title-wrap">
          <div id={titleId} className="ce-title">
            {courseName}
          </div>
        </div>
        <div className="ce-meta ce-up" style={{ '--ce-d': '.5s' } as React.CSSProperties}>
          <span>{t('classroomEnd.learned', { count: pageCount })}</span>
          {scored ? (
            <>
              <i aria-hidden>·</i>
              <b data-testid="course-end-result">
                {t('classroomEnd.result', { correct: scored.correct, total: scored.total })}
              </b>
            </>
          ) : null}
        </div>
        <div className="ce-actions ce-up" style={{ '--ce-d': '.34s' } as React.CSSProperties}>
          {actions.map((action, index) => {
            const Icon = ACTION_ICON[action];
            return (
              <button
                key={action}
                type="button"
                autoFocus={index === 0}
                data-testid={`course-end-${action}`}
                className={cn('ce-btn', index === 0 && action !== 'restart' && 'ce-btn-primary')}
                onClick={() => onAction(action)}
              >
                <Icon size={16} aria-hidden />
                <span>{t(`classroomEnd.actions.${action}`)}</span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
