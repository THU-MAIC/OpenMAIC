'use client';

/**
 * The composer's input, in two layers: a real `<textarea>` over a mirror that
 * draws the skill handles in it as inline pills.
 *
 * WHY A MIRROR AND NOT A RICH EDITOR. A `contenteditable` would let a handle be
 * a real node — and would put IME composition, the undo stack, paste, autosize
 * and `placeholder` on us. This product is Chinese-first; breaking composition to
 * win a rounded rectangle is not a trade. So the textarea stays exactly what it
 * was (same value, same events, same native everything) and a `pointer-events-none`
 * div behind it lays out the SAME string with the handles wrapped in spans.
 *
 * WHAT THE MIRROR CONTRIBUTES IS ONLY THE GROUND. Its own text is transparent:
 * every glyph on screen is still the textarea's. The obvious variant — hide the
 * textarea's text and let the mirror draw it — loses three things at once: the
 * caret (it inherits `color`), the native selection highlight (it would cover a
 * layer with nothing in it, so a selection reads as blank blue blocks), and, worst,
 * the in-flight IME composition, which lives in the element and not in `value` —
 * i.e. invisible Chinese typing. Drawing only the pill's ground keeps all three
 * native and costs one thing: the handle's glyphs stay the composer's text colour
 * instead of the accent, so the pill reads as a highlight rather than as a chip.
 *
 * THE PILL IS METRIC-NEUTRAL. No padding, no border, no margin — horizontal
 * padding/border on an inline box changes the advance width, which would slide
 * the mirror's text off the textarea's by a few pixels per pill and misalign
 * everything after it. The inset is faked with a spread `box-shadow` in the pill's
 * own colour, with `box-decoration-break: clone` so a handle broken across two
 * lines is rounded on both halves. Anyone adding `px-1` here breaks the alignment
 * of every composer; `composer-inline-pill.test.ts` fails if they do.
 *
 * ONE METRIC SOURCE. Both layers get the SAME `className` — the caller's — so
 * font, size, weight, leading and padding cannot drift, and the three composers
 * (whose paddings and font sizes all differ) each stay self-consistent without
 * this file knowing any of their numbers. The mirror then adds only what it must:
 * position, clipping, wrapping, transparent ink.
 *
 * Visually the pill is a HIGHLIGHT, not a member of the composer's standalone
 * pill family (`composer-pill.tsx`): those are nodes in a flex row and may carry
 * a border and real padding, this is a span in a text flow and may carry
 * neither. It shares no layout code with them, and it deliberately does not
 * share their outline either — a lined box drawn around words mid-sentence is
 * the thing this stopped doing.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type RefObject,
} from 'react';

import { cn } from '@/lib/utils/cn';
import { useAgentSkills } from '@/lib/workbench/agent-skills';
import { segmentSkillHandles } from '@/lib/workbench/composer-skills';

/**
 * The pill itself: A SOFT HIGHLIGHT IN A TEXT FLOW, not a chip.
 *
 * ONE ring, not two. It used to stack a 2px ring in the fill's own colour
 * (the fake padding) and a 3px ring in a stronger tone behind it (a hairline)
 * — which paints a visible outline one pixel outside the fake padding, i.e. a
 * DOUBLE-LINED box around a run of words. In a sentence that reads as noise,
 * so the outline is gone: the only ring left is the fake padding, in the fill's
 * own colour, so pill and inset are one shape. Softer ground and a wider radius
 * for the same reason — the highlight must sit under the prose, not compete
 * with it (Notion's mention / an inline code span are the reference).
 *
 * DO NOT ADD THE OUTLINE BACK. `composer-inline-pill.test.ts` fails if a second
 * ring appears in this shadow.
 *
 * Tones come from `--primary` the same way `--wb-accent-soft` does, so this
 * works on the homepage composer too — `.wbchat`'s own tokens do not exist
 * there. Dark mode gets the SAME token at a slightly higher mix, because a 9%
 * wash of an accent that is itself darker disappears against a dark ground; no
 * colour is written down in either mode.
 */
export const SKILL_PILL_CLASS = cn(
  '[--skill-pill-ground:color-mix(in_srgb,var(--primary)_9%,transparent)]',
  'dark:[--skill-pill-ground:color-mix(in_srgb,var(--primary)_17%,transparent)]',
  'rounded-[7px] bg-[var(--skill-pill-ground)]',
  'shadow-[0_0_0_2px_var(--skill-pill-ground)]',
  '[-webkit-box-decoration-break:clone] [box-decoration-break:clone]',
);

/**
 * What the mirror adds on top of the shared metric class. Everything here is
 * either invisibility (transparent ink, no hit testing, hidden from the a11y
 * tree) or geometry the textarea gets from its UA stylesheet instead
 * (`white-space: pre-wrap`, `overflow-wrap: break-word`).
 */
const MIRROR_CLASS =
  'pointer-events-none absolute inset-0 z-0 select-none overflow-hidden whitespace-pre-wrap break-words text-transparent';

export type ComposerTextareaProps = Omit<
  ComponentPropsWithoutRef<'textarea'>,
  'value' | 'children' | 'ref'
> & {
  readonly value: string;
  /** The caller's handle on the real element — autosize and caret placement need it. */
  readonly textareaRef?: RefObject<HTMLTextAreaElement | null>;
  /**
   * Where the caret is now, reported on every way it can move: typing, clicking,
   * arrow keys, selection changes.
   *
   * It lives HERE rather than in each composer because both triggers read the
   * token around the caret (`lib/workbench/composer-tokens`), and a composer that
   * wired only `onChange` would still be deciding on a stale offset the moment the
   * user pressed ←. Three composers, one place to get it right.
   */
  readonly onCaretChange?: (caret: number) => void;
  readonly className?: string;
  readonly mirrorTestId?: string;
};

export function ComposerTextarea({
  value,
  textareaRef,
  onCaretChange,
  className,
  mirrorTestId,
  onScroll,
  onChange,
  onSelect,
  onKeyUp,
  onClick,
  onFocus,
  ...textareaProps
}: ComposerTextareaProps) {
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const mirrorRef = useRef<HTMLDivElement | null>(null);
  /**
   * The mirror's width is MEASURED, not inherited. A vertical scrollbar that
   * takes space (Windows, and any platform without overlay scrollbars) narrows
   * the textarea's content box but not a sibling's, and the two layers would then
   * wrap at different columns — the one misalignment that gets worse the longer
   * the draft is. `clientWidth` excludes exactly that scrollbar.
   */
  const [mirrorWidth, setMirrorWidth] = useState<number | null>(null);
  const { skills } = useAgentSkills();
  const installedNames = useMemo(() => skills.map((skill) => skill.name), [skills]);
  const segments = useMemo(
    () => segmentSkillHandles(value, installedNames),
    [value, installedNames],
  );

  const syncToInput = useCallback(() => {
    const input = inputRef.current;
    const mirror = mirrorRef.current;
    if (!input || !mirror) return;
    mirror.scrollTop = input.scrollTop;
    mirror.scrollLeft = input.scrollLeft;
    setMirrorWidth((current) => (current === input.clientWidth ? current : input.clientWidth));
  }, []);

  // Typing at the bottom of a full box scrolls it, and so does autosize hitting
  // its ceiling; both land here through the value change even when no scroll
  // event fires.
  useEffect(syncToInput, [syncToInput, value]);

  useEffect(() => {
    const input = inputRef.current;
    if (!input || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(syncToInput);
    observer.observe(input);
    return () => observer.disconnect();
  }, [syncToInput]);

  /**
   * Report the caret from the element itself rather than from any event's payload.
   *
   * `selectionStart` after the browser has applied the event is the only value that
   * is right for all of them at once — an `input` has already moved it, a `keyup`
   * for ← has already moved it, and a click has already placed it. Reading it here
   * is also safe under an IME: this only READS the selection, so a live composition
   * is never disturbed (the one path that rewrites the value under the caret is
   * `useSkillHandleBackspace`, which refuses while composing).
   */
  const reportCaret = useCallback(() => {
    if (!onCaretChange) return;
    const input = inputRef.current;
    if (!input) return;
    onCaretChange(input.selectionStart ?? input.value.length);
  }, [onCaretChange]);

  return (
    <div className="relative">
      <div
        ref={mirrorRef}
        aria-hidden="true"
        data-testid={mirrorTestId}
        className={cn(className, MIRROR_CLASS, textareaProps.disabled && 'opacity-60')}
        style={{
          // `text-transparent` says this too, and `cn` does drop the caller's
          // colour utility for it — but only for utilities it recognises as
          // colours. A caller writing `[color:…]` would win in the cascade and
          // print a second, offset copy of the whole draft; inline style cannot
          // lose that argument.
          color: 'transparent',
          // Not `w-full`: see `mirrorWidth`.
          ...(mirrorWidth === null ? {} : { width: `${mirrorWidth}px` }),
        }}
      >
        {segments.map((segment, index) =>
          segment.skill ? (
            <span key={index} className={SKILL_PILL_CLASS}>
              {segment.text}
            </span>
          ) : (
            <span key={index}>{segment.text}</span>
          ),
        )}
        {/* A `pre-wrap` div drops the line box a trailing newline opens, where a
            textarea keeps it. One more newline makes the two scroll the same. */}
        {'\n'}
      </div>
      <textarea
        {...textareaProps}
        ref={(node) => {
          inputRef.current = node;
          if (textareaRef) textareaRef.current = node;
        }}
        value={value}
        onChange={(event) => {
          onChange?.(event);
          reportCaret();
        }}
        // Every other way the caret moves without the value changing: arrow keys
        // and Home/End (`keyup`), a click or drag placing it, a selection change
        // from any source (`select` covers programmatic `setSelectionRange` too),
        // and coming back to a box that kept its caret while blurred.
        onSelect={(event) => {
          onSelect?.(event);
          reportCaret();
        }}
        onKeyUp={(event) => {
          onKeyUp?.(event);
          reportCaret();
        }}
        onClick={(event) => {
          onClick?.(event);
          reportCaret();
        }}
        onFocus={(event) => {
          onFocus?.(event);
          reportCaret();
        }}
        onScroll={(event) => {
          syncToInput();
          onScroll?.(event);
        }}
        // `relative` only to sit above the mirror; the transparent background is
        // what lets the pill show through. Below the composer's own controls,
        // which are z-10.
        className={cn(className, 'relative z-[1] bg-transparent')}
      />
    </div>
  );
}
