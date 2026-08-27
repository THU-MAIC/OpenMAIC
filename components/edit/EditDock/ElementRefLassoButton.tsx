'use client';

/**
 * The lasso — one button, no panel.
 *
 * Press it and the canvas enters picking; click an element and it lands in the
 * composer's reference row; keep clicking to add more. Press it again (or Esc)
 * and picking ends. That is the whole tool: the staged references live in the
 * element-refs store, which the composer already renders as removable pills, so a
 * second list inside the bench would be the same objects shown twice, one copy of
 * which the user cannot send from.
 *
 * The count rides on the button because the button is where the mode is: it
 * answers "did that click register" without asking the eye to travel to the
 * conversation. It is read through the OWNER-FENCED selector, so a chat that does
 * not own the draft can never show another conversation's tally.
 *
 * It is NOT gated on the agent owning the course. It used to be, and that was
 * wrong in the one case the feature exists for: `agentOwnsPaneCourse` releases
 * ownership the moment a run reaches a terminal status, so the lasso vanished
 * exactly when the user sat down to edit the deck the agent had just finished
 * (and it never appeared at all for a course reached through read-only tools,
 * which do not mark a stage as touched). Picking elements is a HUMAN authoring
 * gesture — it stages pills in the composer, it writes nothing — and the runner
 * does not check that a ref's stage is the session's own: refs carry their own
 * `stageId`, and cross-user access is refused by the owner-bound store. So the
 * only condition left is the one that makes the gesture meaningful: a slide to
 * point at, and a conversation to hand the references to.
 *
 * "A conversation" means the composer that owns the reference draft, NOT merely a
 * session id sitting in the workbench store. Those two come apart: the store is
 * only ever attached inside `/workspace`, but it survives a client-side navigation
 * out of it, so opening a course from the discover feed (`router.push`
 * `/classroom/<id>`) leaves the id behind while `WorkbenchChat` — the only caller
 * of `useElementRefsOwnerLifecycle` — unmounts and releases ownership. The button
 * used to render on the id alone and refuse to act on the missing owner, which on
 * that route is a permanent dead button rather than the one pre-attach frame the
 * refusal was written for. So the owner fence IS the render condition: if pressing
 * it cannot arm, it is not painted. `armed` keeps it mounted regardless, because
 * the promise "press again to leave" (and the Esc handler below) must outlive any
 * ownership change that happens while picking.
 */
import { Lasso } from 'lucide-react';
import { useCallback, useEffect } from 'react';
import { cn } from '@/lib/utils/cn';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useCanvasStore } from '@/lib/store/canvas';
import { useElementRefsForSession, useElementRefsStore } from '@/lib/store/element-refs';
import { useStageStore } from '@/lib/store/stage';
import { useWorkbenchStore } from '@/lib/workbench/session-store';
import { MAX_ELEMENT_REFS } from '@/lib/workbench/element-refs';
import { clearCuePreview } from '@/components/edit/ActionsBar/cue-preview';

export function ElementRefLassoButton({ sceneId }: { readonly sceneId: string }) {
  const { t } = useI18n();
  const sessionId = useWorkbenchStore((s) => s.sessionId);
  const refs = useElementRefsForSession(sessionId);
  const pickTarget = useCanvasStore.use.pickTarget();
  const stageId = useStageStore((s) => s.stage?.id ?? null);
  const ownerSessionId = useElementRefsStore((s) => s.ownerSessionId);

  // Armed for THIS page of THIS course on behalf of THIS chat. Anything else is
  // someone else's pick mode and must not light this button up.
  const armed =
    pickTarget?.purpose === 'element-ref' &&
    pickTarget.sceneId === sceneId &&
    pickTarget.stageId === stageId &&
    pickTarget.ownerSessionId === sessionId;

  // Everything a press needs, in one value: a slide, a chat, and that chat holding
  // the draft the pills would land in. Non-null here IS "pressing this works", so
  // the press below needs no guard of its own and cannot silently do nothing.
  const armTarget =
    stageId !== null && sessionId !== null && ownerSessionId === sessionId
      ? { stageId, sessionId }
      : null;

  const disarm = useCallback(() => {
    const canvas = useCanvasStore.getState();
    if (canvas.pickTarget?.purpose === 'element-ref') canvas.setPickTarget(null);
  }, []);

  /**
   * Esc leaves picking. The canvas pick layer binds the same key, and that is
   * deliberate rather than redundant: the promise "Esc gets you out" belongs to
   * the button that got you in, and must hold even where no pick layer is mounted
   * to keep it. Both paths null the same target, so whichever runs first wins and
   * the second is a no-op.
   */
  useEffect(() => {
    if (!armed) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') disarm();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [armed, disarm]);

  const toggle = () => {
    if (armed) {
      disarm();
      return;
    }
    if (!armTarget) return;
    // Taking the canvas away from a cue pick: its hover preview (spotlight /
    // laser) is a live effect painted on the slide, and it must not outlive the
    // mode that painted it.
    clearCuePreview();
    useCanvasStore.getState().setPickTarget({
      purpose: 'element-ref',
      stageId: armTarget.stageId,
      sceneId,
      ownerSessionId: armTarget.sessionId,
    });
  };

  // Nothing to press: no slide, no conversation, or a conversation that does not
  // hold the reference draft (no composer mounted to render the pills in). Only
  // `armed` keeps it on screen through such a change, so that picking always has
  // its way out.
  if (!armTarget && !armed) return null;

  return (
    <button
      type="button"
      data-testid="element-ref-arm"
      onClick={toggle}
      aria-pressed={armed}
      title={t('edit.dock.elementRefHint')}
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded-full border px-2.5 py-0.5 text-[11px] font-medium transition-colors',
        armed
          ? 'border-violet-400 bg-violet-500 text-white hover:bg-violet-600'
          : 'border-primary/25 bg-primary/10 text-primary hover:bg-primary/15',
      )}
    >
      <Lasso className="size-3" />
      {armed ? t('edit.elementRef.exitPicking') : t('edit.elementRef.startPicking')}
      {refs.length > 0 && (
        <span
          data-testid="element-ref-count"
          title={t('edit.elementRef.counts', { count: refs.length, max: MAX_ELEMENT_REFS })}
          className={cn(
            'grid size-4 place-items-center rounded-full font-mono text-[9px] font-semibold leading-none tabular-nums',
            armed ? 'bg-white/25 text-white' : 'bg-primary/20 text-primary',
          )}
        >
          {refs.length}
        </span>
      )}
    </button>
  );
}
