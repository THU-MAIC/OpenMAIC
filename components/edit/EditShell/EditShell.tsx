'use client';

import { motion, useReducedMotion } from 'motion/react';
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { SceneEditorSurface, SurfaceState } from '@/lib/edit/scene-editor-surface';
import { sceneEditorRegistry } from '@/lib/edit/scene-editor-registry';
import { NOOP_SURFACE } from '@/lib/edit/noop-surface';
import type { Scene } from '@/lib/types/stage';
import { CHROME_DURATION, CHROME_EASE, CHROME_STAGGER } from '@/lib/edit/transitions';
import { StageGrid } from '@/components/edit/StageGrid';
import { CommandBar } from './CommandBar';
import { FloatingInsertToolbar } from './FloatingInsertToolbar';
import { FloatingToolbar } from './FloatingToolbar';
import { HintRail } from './HintRail';

interface EditShellProps {
  readonly scene: Scene;
  /**
   * Optional left-side navigator slot. In v0 this is the SlideNavRail
   * passed from Stage when mode === 'edit'. Surface code never imports
   * the rail (the prop is the only handoff seam), keeping chrome and
   * surface separable.
   */
  readonly leftRail?: ReactNode;
  /**
   * Right-edge slot of the CommandBar — Stage uses this to hand in the
   * global controls (settings pill + Pro Switch) when the Stage Header
   * is hidden, so the entire top chrome reduces to a single bar.
   */
  readonly commandTrailing?: ReactNode;
}

const CHROME_TRANSITION = { duration: CHROME_DURATION, ease: CHROME_EASE } as const;
const COMMANDBAR_DELAY = CHROME_STAGGER;
const LEFT_RAIL_DELAY = CHROME_STAGGER * 2;

/**
 * Pro mode (edit) chrome — mounts inside the canvas slot of Stage, replacing
 * CanvasArea. The playback Header above stays mounted because it owns the
 * global Pro toggle Switch: exiting Pro mode is done by flipping that Switch
 * off, not by a dedicated button here.
 *
 *   ┌──────────────────────────────────────────────┐  (Stage Header above)
 *   ├──────────────────────────────────────────────┤
 *   │ CommandBar  (undo/redo · title · insert ·    │
 *   │              surface commands)                │
 *   ├──────────┬───────────────────────────────────┤
 *   │ leftRail │ Canvas / unsupported-scene        │
 *   │ (opt)    │ FloatingToolbar (when selected)   │
 *   │          │ HintRail (AI, reserved)            │
 *   └──────────┴───────────────────────────────────┘
 *
 * Mount choreography: CommandBar drops in from top, leftRail slides in
 * from left after a stagger, content opacity-fades in. All three share
 * the single `CHROME_*` source in `lib/edit/transitions.ts` so timing
 * stays consistent with the outer Stage-level cross-fade.
 *
 * Architecture: this shell resolves `scene.type` to a registered surface
 * (or falls back to NOOP_SURFACE for unregistered types) and **never
 * branches into a different component type**. The same `<Frame>` mounts
 * across every scene-type change — only the `surface.CanvasComponent`
 * inside the canvas slot swaps. That guarantees CommandBar and `leftRail`
 * never remount during scene navigation, removing the chrome flicker that
 * the previous two-branch design caused (PR3a rearch).
 */
export function EditShell({ scene, leftRail, commandTrailing }: EditShellProps) {
  const surface = sceneEditorRegistry.resolve(scene.type) ?? NOOP_SURFACE;
  // Surface state is published from a child runner (keyed by sceneType so it
  // remounts when the surface identity changes — that's the boundary at which
  // rules-of-hooks naturally allows a different hook signature). The chrome
  // around it stays mounted and consumes state via these props.
  const [state, setState] = useState<SurfaceState | null>(null);
  const CanvasComponent = surface.CanvasComponent;

  return (
    <>
      {/* `key={scene.type}` is the remount boundary. We can't use
          `surface.sceneType` here because NOOP_SURFACE deliberately reuses
          'slide' as a placeholder (the SceneType union is closed and NOOP
          isn't a real type). The scene's own `type` is the actual signal
          that the hook signature inside `useSurfaceState` is about to
          change — so we remount the runner exactly when it does, keeping
          rules-of-hooks happy across the slide ↔ read-only surface swap
          while the rest of the chrome stays mounted. */}
      <SurfaceStateRunner key={scene.type} surface={surface} onChange={setState} />
      <Frame
        title={scene.title}
        leftRail={leftRail}
        history={state?.history}
        commands={state?.commands}
        trailing={commandTrailing}
      >
        <CanvasComponent />
        {state?.insertItems && state.insertItems.length > 0 && (
          <FloatingInsertToolbar items={state.insertItems} />
        )}
        {state?.hasSelection && <FloatingToolbar actions={state.floatingActions} />}
        <HintRail hints={state?.hints} />
      </Frame>
    </>
  );
}

/**
 * Hidden runner that owns the surface state hook. `key={surface.sceneType}`
 * ensures it remounts when the surface itself changes (slide → noop) — the
 * only point at which the hook call signature can vary. Within a single mount
 * the hook signature is fixed (the surface object is constant), so React's
 * rules-of-hooks are respected.
 *
 * Renders no DOM; state flows up to the chrome via `onChange`. A custom
 * shallow comparison gates the publish — surface hooks (e.g. slideSurface's
 * `useSlideSurfaceState`) return a fresh object literal every render, so naive
 * reference equality would loop infinitely (every publish causes the parent to
 * re-render, which re-runs this hook, which yields a new ref, which publishes
 * again, etc.). We only publish when one of the fields the chrome actually
 * reads has materially changed.
 */
function SurfaceStateRunner({
  surface,
  onChange,
}: {
  readonly surface: SceneEditorSurface;
  readonly onChange: (state: SurfaceState) => void;
}) {
  const state = surface.useSurfaceState();
  const lastRef = useRef<SurfaceState | null>(null);
  useLayoutEffect(() => {
    if (surfaceStateEqual(state, lastRef.current)) return;
    lastRef.current = state;
    onChange(state);
  });
  return null;
}

/**
 * Field-by-field equality for the subset of SurfaceState that the chrome
 * reads. Surface hooks (e.g. `useSlideSurfaceState`) return a fresh object
 * literal every render, so naive reference equality would publish on
 * every render and trip an infinite render loop via the runner →
 * setState → re-render cycle. We compare semantic content instead.
 *
 * **When you extend `SurfaceState`** (new field on `EditorCommand`,
 * `InsertPaletteItem`, `FloatingAction`, `EditorHint`, or a new top-level
 * field), update this function in lock-step. A field that's read by the
 * chrome but missing from the comparison silently goes stale.
 *
 * - `content` is reference-equal as long as the in-memory slide buffer
 *   hasn't been committed — the canonical "real change" signal.
 * - History flags compared individually (functions like undo/redo are
 *   stable references via `useSlideEditSession.getState()`).
 * - InsertPaletteItem / EditorCommand / FloatingAction arrays: length +
 *   per-item `id` + per-item flags that drive visual state.
 * - EditorHint compared by length + per-item severity/message.
 *
 * **Callback identity (`onInvoke`, `popoverContent`) is intentionally
 * NOT compared.** Per-render closure rebinding is normal and would
 * trip equality every render. Today this is safe because slide is the
 * only registered surface and its `floatingActions` is `[]` — the only
 * `onInvoke` set the chrome reads is on `InsertPaletteItem`, which is
 * a stable module-level closure from `buildInsertItems`. A future
 * surface that returns non-empty `floatingActions` with closures
 * capturing per-render state must fold its own change signal (a
 * content ref / version counter) into the comparison, otherwise the
 * stale callback fires at click time.
 */
function surfaceStateEqual(a: SurfaceState, b: SurfaceState | null): boolean {
  if (!b) return false;
  if (a.content !== b.content) return false;
  if (a.hasSelection !== b.hasSelection) return false;
  if ((a.history?.canUndo ?? null) !== (b.history?.canUndo ?? null)) return false;
  if ((a.history?.canRedo ?? null) !== (b.history?.canRedo ?? null)) return false;
  if (a.insertItems.length !== b.insertItems.length) return false;
  for (let i = 0; i < a.insertItems.length; i++) {
    if (a.insertItems[i].id !== b.insertItems[i].id) return false;
    if (a.insertItems[i].active !== b.insertItems[i].active) return false;
    if (a.insertItems[i].disabled !== b.insertItems[i].disabled) return false;
    // Label/tooltip are user-facing and locale-dependent: without them the
    // insert toolbar text stays stale after a language switch.
    if (a.insertItems[i].label !== b.insertItems[i].label) return false;
    if (a.insertItems[i].tooltip !== b.insertItems[i].tooltip) return false;
  }
  if (a.commands.length !== b.commands.length) return false;
  for (let i = 0; i < a.commands.length; i++) {
    if (a.commands[i].id !== b.commands[i].id) return false;
    if (a.commands[i].disabled !== b.commands[i].disabled) return false;
    if (a.commands[i].label !== b.commands[i].label) return false;
    if (a.commands[i].tooltip !== b.commands[i].tooltip) return false;
  }
  if (a.floatingActions.length !== b.floatingActions.length) return false;
  for (let i = 0; i < a.floatingActions.length; i++) {
    if (a.floatingActions[i].id !== b.floatingActions[i].id) return false;
    if (a.floatingActions[i].disabled !== b.floatingActions[i].disabled) return false;
    if (a.floatingActions[i].label !== b.floatingActions[i].label) return false;
  }
  const aHints = a.hints ?? [];
  const bHints = b.hints ?? [];
  if (aHints.length !== bHints.length) return false;
  for (let i = 0; i < aHints.length; i++) {
    if (aHints[i].id !== bHints[i].id) return false;
    if (aHints[i].severity !== bHints[i].severity) return false;
    if (aHints[i].message !== bHints[i].message) return false;
  }
  return true;
}

interface FrameProps {
  readonly title: string;
  readonly leftRail?: ReactNode;
  readonly history?: React.ComponentProps<typeof CommandBar>['history'];
  readonly commands?: React.ComponentProps<typeof CommandBar>['commands'];
  readonly trailing?: ReactNode;
  readonly children: ReactNode;
}

function Frame({ title, leftRail, history, commands, trailing, children }: FrameProps) {
  const prefersReducedMotion = useReducedMotion();

  // Chrome layers fade in (opacity only) — deliberately NO transform (x/y)
  // slide. Two reasons: (1) the CommandBar's trailing slot and the rail host
  // the Pro Switch / settings pill, which animate across the mode swap via
  // `layoutId`; a transform on an ancestor distorts motion's layout
  // measurement and makes the shared element drift. (2) the rail
  // (`backdrop-blur-xl`) and the pills (`backdrop-blur-md`) would force a
  // per-frame backdrop-filter recompute while transforming, which drops
  // frames. A pure opacity fade composites cleanly and keeps the layout
  // static so layoutId morphs land precisely.
  const cmdInitial = { opacity: 0 };
  const cmdAnimate = { opacity: 1 };
  const railInitial = { opacity: 0 };
  const railAnimate = { opacity: 1 };

  const stepTransition = prefersReducedMotion
    ? { duration: 0.12, ease: CHROME_EASE }
    : CHROME_TRANSITION;

  return (
    <StageGrid
      className="bg-gradient-to-b from-zinc-100 to-zinc-200 dark:from-zinc-950 dark:to-zinc-900"
      topSlot={
        <motion.div
          initial={cmdInitial}
          animate={cmdAnimate}
          transition={{ ...stepTransition, delay: prefersReducedMotion ? 0 : COMMANDBAR_DELAY }}
        >
          <CommandBar title={title} history={history} commands={commands} trailing={trailing} />
        </motion.div>
      }
      leftSlot={
        leftRail ? (
          <motion.div
            initial={railInitial}
            animate={railAnimate}
            transition={{ ...stepTransition, delay: prefersReducedMotion ? 0 : LEFT_RAIL_DELAY }}
            className="h-full shrink-0"
          >
            {leftRail}
          </motion.div>
        ) : null
      }
      centerSlot={
        // Padded studio frame around the actual scene renderer. Lifted
        // up from SlideCanvas so the slide and the non-slide read-only
        // renderers share the exact same canvas bounding rect (no
        // layout jump when switching scene type). Children render
        // inside an inner ring/shadow card that the playback
        // CanvasArea visually mirrors.
        <div className="relative h-full w-full p-3 sm:p-4">
          <div className="relative h-full w-full overflow-hidden rounded-xl bg-white ring-1 ring-zinc-200/80 dark:bg-zinc-900 dark:ring-zinc-800/80 shadow-[0_10px_40px_-12px_rgba(15,23,42,0.18)] dark:shadow-[0_10px_40px_-12px_rgba(0,0,0,0.6)]">
            {children}
          </div>
        </div>
      }
    />
  );
}
