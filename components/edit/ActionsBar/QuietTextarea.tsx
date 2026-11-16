'use client';

/**
 * A card's text field: whole lines, a quiet scrollbar, a soft edge.
 *
 * A native scrollbar here is either always there or takes a gutter from the text,
 * depending on the machine's settings, so the native one is off and a thin thumb is
 * drawn over the text instead; it shows while the card is hovered or the field is
 * being scrolled, and moves no line. The field is cut to a whole number of lines,
 * whatever height the dock gives it, and the edge fades out while there is more
 * below, so no line is ever left sliced in half to say so.
 */
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type TextareaHTMLAttributes,
} from 'react';
import { cn } from '@/lib/utils/cn';

const SCROLL_REST_MS = 700;
/** The thumb stays big enough to see. */
const THUMB_MIN_PX = 12;
const FADE =
  '[mask-image:linear-gradient(to_bottom,#000_calc(100%-14px),transparent)] [-webkit-mask-image:linear-gradient(to_bottom,#000_calc(100%-14px),transparent)]';

export const QuietTextarea = forwardRef<
  HTMLTextAreaElement,
  TextareaHTMLAttributes<HTMLTextAreaElement> & {
    /** Must be a whole px value, and the same one the class sets. */
    readonly lineHeightPx: number;
    readonly wrapperClassName?: string;
  }
>(function QuietTextarea({ lineHeightPx, wrapperClassName, className, onScroll, ...rest }, outer) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  useImperativeHandle(outer, () => ref.current as HTMLTextAreaElement);
  const restTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [thumb, setThumb] = useState<{ top: number; size: number } | null>(null);
  const [moreBelow, setMoreBelow] = useState(false);
  const [scrolling, setScrolling] = useState(false);

  const measure = useCallback(() => {
    const field = ref.current;
    if (!field) return;
    const { scrollHeight, clientHeight, scrollTop } = field;
    if (scrollHeight <= clientHeight + 1) {
      setThumb(null);
      setMoreBelow(false);
      return;
    }
    const size = Math.max(THUMB_MIN_PX, (clientHeight / scrollHeight) * clientHeight);
    const travel = clientHeight - size;
    setThumb({ top: (scrollTop / (scrollHeight - clientHeight)) * travel, size });
    // A single line has no room to fade: the 14px edge would wash it out.
    setMoreBelow(clientHeight >= lineHeightPx * 2 && scrollTop + clientHeight < scrollHeight - 1);
  }, [lineHeightPx]);

  // Whole lines, directly on the element: the dock's height changes every frame of a
  // drag, and this must not render for it. A change in height changes what there is
  // to scroll, too.
  useEffect(() => {
    const wrapper = wrapperRef.current;
    const field = ref.current;
    if (!wrapper || !field || typeof ResizeObserver === 'undefined') return;
    const fit = () => {
      const lines = Math.max(1, Math.floor(wrapper.clientHeight / lineHeightPx));
      field.style.height = `${lines * lineHeightPx}px`;
      measure();
    };
    const resized = new ResizeObserver(fit);
    resized.observe(wrapper);
    return () => resized.disconnect();
  }, [lineHeightPx, measure]);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- the thumb follows the text, measured before paint
  useLayoutEffect(measure, [measure, rest.value]);
  useEffect(() => () => clearTimeout(restTimer.current), []);

  return (
    <div ref={wrapperRef} className={cn('group/quiet relative min-h-0 flex-1', wrapperClassName)}>
      <textarea
        {...rest}
        ref={ref}
        onScroll={(event) => {
          measure();
          setScrolling(true);
          clearTimeout(restTimer.current);
          restTimer.current = setTimeout(() => setScrolling(false), SCROLL_REST_MS);
          onScroll?.(event);
        }}
        className={cn(
          'block w-full resize-none bg-transparent outline-none [scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
          moreBelow && FADE,
          className,
        )}
      />
      {thumb ? (
        <span
          aria-hidden="true"
          data-testid="quiet-scroll-thumb"
          style={{ top: thumb.top, height: thumb.size }}
          className={cn(
            'pointer-events-none absolute right-[3px] w-[3px] rounded-full bg-gray-500/35 opacity-0 transition-opacity duration-150 group-hover/quiet:opacity-100 dark:bg-gray-400/35',
            scrolling && 'opacity-100',
          )}
        />
      ) : null}
    </div>
  );
});
