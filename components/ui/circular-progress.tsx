'use client';

/**
 * `CircularProgress` — a small determinate progress ring.
 *
 * Rendered as an SVG with two stacked circles (track + arc); the arc length is
 * driven by `value` via stroke-dashoffset. Sized to overlay an icon button, so
 * it defaults small and inherits color from `currentColor`. Purely presentational.
 */
import { cn } from '@/lib/utils';

interface CircularProgressProps {
  /** Progress 0..100. */
  value: number;
  /** Outer diameter in px. */
  size?: number;
  /** Ring thickness in px. */
  strokeWidth?: number;
  className?: string;
}

export function CircularProgress({
  value,
  size = 24,
  strokeWidth = 2.5,
  className,
}: CircularProgressProps) {
  const clamped = Math.max(0, Math.min(100, value));
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - clamped / 100);
  const center = size / 2;

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      className={cn('shrink-0', className)}
      role="progressbar"
      aria-valuenow={Math.round(clamped)}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      {/* Track */}
      <circle
        cx={center}
        cy={center}
        r={radius}
        fill="none"
        strokeWidth={strokeWidth}
        className="stroke-current opacity-20"
      />
      {/* Arc — starts at 12 o'clock, fills clockwise. */}
      <circle
        cx={center}
        cy={center}
        r={radius}
        fill="none"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={offset}
        className="stroke-current transition-[stroke-dashoffset] duration-500"
        transform={`rotate(-90 ${center} ${center})`}
      />
    </svg>
  );
}
