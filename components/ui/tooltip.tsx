'use client';

import * as React from 'react';
import { Tooltip as TooltipPrimitive } from 'radix-ui';

import { cn } from '@/lib/utils';
import { useFloatingLayerOwnerProps } from '@/components/ui/floating-layer-owner';

function TooltipProvider({
  delayDuration = 0,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  return (
    <TooltipPrimitive.Provider
      data-slot="tooltip-provider"
      delayDuration={delayDuration}
      {...props}
    />
  );
}

function Tooltip({ ...props }: React.ComponentProps<typeof TooltipPrimitive.Root>) {
  return (
    <TooltipProvider>
      <TooltipPrimitive.Root data-slot="tooltip" {...props} />
    </TooltipProvider>
  );
}

/**
 * What last moved the user's focus, recorded at the document in the capture
 * phase so it is known before any focus that input causes.
 *
 * `:focus-visible` alone cannot tell keyboard navigation from programmatic
 * focus: a browser keeps it set when a script moves focus after keyboard
 * input, so a dialog opened with Enter (its auto-focus) or closed with Escape
 * (focus handed back to its trigger) would still pop a tooltip. A focus right
 * after a navigation key (Tab, arrows, Home/End) is the user moving focus; a
 * focus after any other key (Enter, Space, Escape, a shortcut) or after a
 * pointer press is a script reacting to that input.
 */
type FocusCause = 'none' | 'navigation-key' | 'other-key' | 'pointer';

const NAVIGATION_KEYS = new Set([
  'Tab',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  'PageUp',
  'PageDown',
]);
const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Fn']);

let lastFocusCause: FocusCause = 'none';
let focusCauseTracked = false;

function trackFocusCause() {
  if (focusCauseTracked || typeof document === 'undefined') return;
  focusCauseTracked = true;
  document.addEventListener(
    'keydown',
    (event) => {
      // A modifier pressed on its own (Shift before Shift+Tab) moves nothing.
      if (MODIFIER_KEYS.has(event.key)) return;
      lastFocusCause = NAVIGATION_KEYS.has(event.key) ? 'navigation-key' : 'other-key';
    },
    true,
  );
  document.addEventListener(
    'pointerdown',
    () => {
      lastFocusCause = 'pointer';
    },
    true,
  );
}
trackFocusCause();

/**
 * Whether a focus on a tooltip trigger should open its tooltip: only keyboard
 * navigation does. Hover is handled separately and is unaffected. Before any
 * input has been seen, `:focus-visible` decides, and an engine without it
 * keeps the old behaviour (open).
 */
export function focusOpensTooltip(el: Element, cause: FocusCause = lastFocusCause): boolean {
  if (cause === 'navigation-key') return true;
  if (cause === 'other-key' || cause === 'pointer') return false;
  try {
    return el.matches(':focus-visible');
  } catch {
    return true;
  }
}

function TooltipTrigger({
  onFocus,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Trigger>) {
  return (
    <TooltipPrimitive.Trigger
      data-slot="tooltip-trigger"
      onFocus={(event) => {
        onFocus?.(event);
        // Radix skips its own focus handler for a default-prevented event.
        if (!event.defaultPrevented && !focusOpensTooltip(event.currentTarget)) {
          event.preventDefault();
        }
      }}
      {...props}
    />
  );
}

function TooltipContent({
  className,
  sideOffset = 0,
  children,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content>) {
  const ownerProps = useFloatingLayerOwnerProps();
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        data-slot="tooltip-content"
        sideOffset={sideOffset}
        className={cn(
          'data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-[state=delayed-open]:animate-in data-[state=delayed-open]:fade-in-0 data-[state=delayed-open]:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 rounded-md px-3 py-1.5 text-xs bg-foreground text-background z-50 w-fit max-w-xs origin-(--radix-tooltip-content-transform-origin)',
          className,
        )}
        {...ownerProps}
        {...props}
      >
        {children}
        <TooltipPrimitive.Arrow className="size-2.5 translate-y-[calc(-50%_-_2px)] rotate-45 rounded-[2px] bg-foreground fill-foreground z-50 translate-y-[calc(-50%_-_2px)]" />
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  );
}

export { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger };
