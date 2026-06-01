'use client';

import { useEffect, useRef, useState } from 'react';
import { HexColorPicker } from 'react-colorful';
import { Pipette } from 'lucide-react';

// Common slide-text colors — single tight row at the foot of the picker so they
// stay one-click reachable without dominating the popover.
const COMMON: readonly string[] = [
  '#000000',
  '#525252',
  '#a3a3a3',
  '#ffffff',
  '#ef4444',
  '#f97316',
  '#eab308',
  '#22c55e',
  '#3b82f6',
  '#8b5cf6',
];

// EyeDropper API (not in `lib.dom` yet under our TS config). Feature-detected
// at render so the button hides on browsers without it (Safari / Firefox).
interface EyeDropperInstance {
  open(): Promise<{ sRGBHex: string }>;
}
interface EyeDropperCtor {
  new (): EyeDropperInstance;
}

interface ColorPickerProps {
  readonly value: string;
  /** Live color update — fires on every gradient/slider drag tick. */
  readonly onChange: (color: string) => void;
  /** Discrete commit (swatch click / eyedropper). Caller closes the popover. */
  readonly onCommit: (color: string) => void;
}

/**
 * Editor text-color picker. Saturation/value pad + hue slider (react-colorful)
 * for free-form colors, the OS eye-dropper for sampling the screen, and a
 * tight row of common colors at the bottom. No hex text input — picking is
 * meant to be tactile.
 */
export function ColorPicker({ value, onChange, onCommit }: ColorPickerProps) {
  // Local mirror so the picker UI stays responsive while dragging without
  // round-tripping through ProseMirror + store on every tick.
  const [color, setColor] = useState(value);
  // Don't snap the picker back mid-drag: a stale `value` arriving from a
  // ProseMirror dispatch a few ticks behind would otherwise overwrite the
  // user's current pointer position. Gate the re-sync on the pointer being
  // up. External commits (swatch / eyedropper) sync immediately because
  // they fire while no drag is in flight.
  const isDragging = useRef(false);
  useEffect(() => {
    const onUp = () => {
      isDragging.current = false;
    };
    // react-colorful dispatches `mouseup` / `touchend` directly (not
    // synthetic pointer events), so we listen on every gesture-end channel
    // to catch any browser / emulator that only emits one family.
    // `pointercancel` handles the OS yanking the gesture mid-drag.
    const channels = ['mouseup', 'touchend', 'pointerup', 'pointercancel'] as const;
    channels.forEach((ev) => window.addEventListener(ev, onUp));
    return () => channels.forEach((ev) => window.removeEventListener(ev, onUp));
  }, []);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!isDragging.current) setColor(value);
  }, [value]);

  const handleChange = (c: string) => {
    isDragging.current = true;
    setColor(c);
    onChange(c);
  };
  const handleCommit = (c: string) => {
    setColor(c);
    onCommit(c);
  };

  const EyeDropper = (globalThis as unknown as { EyeDropper?: EyeDropperCtor }).EyeDropper;
  const sampleScreen = async () => {
    if (!EyeDropper) return;
    try {
      const result = await new EyeDropper().open();
      handleCommit(result.sRGBHex);
    } catch {
      // User dismissed the OS picker — nothing to do.
    }
  };

  return (
    <div className="color-picker flex w-[224px] flex-col gap-3">
      <HexColorPicker color={color} onChange={handleChange} />
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span
            className="h-5 w-5 shrink-0 rounded ring-1 ring-inset ring-black/15 dark:ring-white/20"
            style={{ backgroundColor: color }}
          />
          <span className="truncate font-mono text-[11px] tracking-wider text-zinc-500 uppercase dark:text-zinc-400">
            {color}
          </span>
        </div>
        {EyeDropper && (
          <button
            type="button"
            aria-label="Sample a color from the screen"
            onMouseDown={(e) => e.preventDefault()}
            onClick={sampleScreen}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
          >
            <Pipette className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      <div className="flex gap-1 border-t border-zinc-100 pt-3 dark:border-zinc-800">
        {COMMON.map((c) => (
          <button
            key={c}
            type="button"
            aria-label={c}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => handleCommit(c)}
            className="h-[18px] w-[18px] rounded ring-1 ring-inset ring-black/10 transition-transform hover:scale-110 dark:ring-white/20"
            style={{ backgroundColor: c }}
          />
        ))}
      </div>
    </div>
  );
}
