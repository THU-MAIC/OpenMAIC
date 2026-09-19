/**
 * PBL v2 — Star rating (two variants).
 *
 * One renderer, two presentation policies. Stars are always 0–5 in
 * 0.5 increments (clamped + rounded server-side by normalizeStars;
 * we render whatever number we get).
 *
 *  - <StarRating value={n} />          plain row, NO "n/5" tail.
 *                                       used for milestone reflection
 *                                       (the user explicitly asked for
 *                                       icon vibes, not graded vibes).
 *  - <StarRating value={n} showDenominator />
 *                                       row + "n / 5" trailing text in
 *                                       monospace. used by task-eval
 *                                       card where the score IS a
 *                                       judgement.
 *
 * Half-star rendering: a CSS gradient mask paints the left half of
 * a star glyph gold and the right half neutral. No SVG paint-server
 * hacks, no duplicate glyphs.
 */

import { cn } from '@/lib/utils';

interface Props {
  /** 0-5 in 0.5 increments. Out-of-range values are clamped at
   *  render time; non-finite values fall back to 0. */
  value: number;
  showDenominator?: boolean;
  /** Override star size (px). Defaults to 16. */
  size?: number;
  className?: string;
}

export function StarRating({ value, showDenominator, size = 16, className }: Props) {
  const safe = Number.isFinite(value) ? Math.max(0, Math.min(5, value)) : 0;
  return (
    <span
      role="img"
      aria-label={`Rating ${safe.toFixed(safe % 1 === 0 ? 0 : 1)} out of 5`}
      className={cn('inline-flex items-center gap-0.5', className)}
    >
      {[0, 1, 2, 3, 4].map((i) => {
        const filled = safe >= i + 1;
        const half = !filled && safe > i;
        return (
          <span
            key={i}
            aria-hidden="true"
            style={{
              fontSize: size,
              lineHeight: 1,
              // Half-star: left half gold, right half neutral via
              // gradient + text background-clip.
              background: half ? 'linear-gradient(90deg, #f59e0b 50%, #e5e7eb 50%)' : 'transparent',
              WebkitBackgroundClip: half ? 'text' : undefined,
              WebkitTextFillColor: half ? 'transparent' : undefined,
              backgroundClip: half ? 'text' : undefined,
              color: filled ? '#f59e0b' : half ? undefined : '#e5e7eb',
            }}
          >
            ★
          </span>
        );
      })}
      {showDenominator && (
        <span className="ml-1.5 text-[11px] font-mono font-semibold text-muted-foreground">
          {safe.toFixed(safe % 1 === 0 ? 0 : 1)} / 5
        </span>
      )}
    </span>
  );
}
