'use client';

/**
 * ActionPicker — portal popover listing the cue types insertable at a given
 * timeline slot (旁白/聚光/激光/讨论). Shared by the header "add" pill and the
 * inline "+" affordance (wired in Task 5); this component only renders the
 * list and reports the chosen type back via `onSelect`.
 *
 * Mirrors `CueTooltip`'s `createPortal` pattern in ActionsBar.tsx: a small
 * card anchored to a DOMRect, clamped to the viewport, dismissed by a
 * backdrop click or Esc.
 */
import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import type { Action } from '@/lib/types/action';
import type { SceneType } from '@/lib/types/stage';
import { useI18n } from '@/lib/hooks/use-i18n';
import { cn } from '@/lib/utils/cn';
import { cueLabel, cueMeta } from './cue-meta';
import { pickerOptions, type PickerType } from './picker-options';

const DESC_KEY: Record<PickerType, string> = {
  speech: 'edit.picker.speechDesc',
  spotlight: 'edit.picker.spotlightDesc',
  laser: 'edit.picker.laserDesc',
  discussion: 'edit.picker.discussionDesc',
};

export function ActionPicker({
  anchor,
  sceneType,
  actions,
  onSelect,
  onClose,
}: {
  anchor: DOMRect;
  sceneType: SceneType;
  actions: Action[];
  onSelect: (type: PickerType) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (typeof document === 'undefined') return null;

  const W = 240;
  const left = Math.min(Math.max(8, anchor.left), window.innerWidth - W - 8);
  const below = anchor.bottom + 8;
  const opensUp = below + 220 > window.innerHeight;
  const options = pickerOptions(sceneType, actions);

  return createPortal(
    <>
      <div className="fixed inset-0 z-[70]" onClick={onClose} />
      <div
        role="menu"
        style={{
          position: 'fixed',
          left,
          top: opensUp ? undefined : below,
          bottom: opensUp ? window.innerHeight - anchor.top + 8 : undefined,
          width: W,
          zIndex: 71,
        }}
        className="overflow-hidden rounded-xl border border-border/80 bg-popover p-1.5 text-popover-foreground shadow-2xl shadow-black/20"
      >
        <div className="px-2 pb-1.5 pt-1 text-[11px] font-medium tracking-wide text-muted-foreground">
          {t('edit.picker.title')}
        </div>
        {options.map((opt, i) => {
          const meta = cueMeta(opt.type);
          const Icon = meta.icon;
          return (
            <div key={opt.type}>
              {opt.type === 'discussion' && i > 0 && <div className="my-1 h-px bg-border/70" />}
              <button
                type="button"
                role="menuitem"
                disabled={opt.disabled}
                title={opt.disabled ? t('edit.timeline.addDiscussionExists') : undefined}
                onClick={() => {
                  onSelect(opt.type);
                  onClose();
                }}
                className={cn(
                  'flex w-full items-start gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors',
                  opt.disabled
                    ? 'cursor-not-allowed opacity-40'
                    : 'hover:bg-muted/70 active:bg-muted',
                )}
              >
                <span
                  className={cn(
                    'mt-0.5 grid size-[30px] shrink-0 place-items-center rounded-lg',
                    meta.glyph,
                  )}
                >
                  <Icon className="size-4" />
                </span>
                <span className="min-w-0">
                  <span className="block text-[12.5px] font-medium text-foreground">
                    {cueLabel(opt.type, t)}
                  </span>
                  <span className="block text-[11px] leading-snug text-muted-foreground">
                    {t(DESC_KEY[opt.type])}
                  </span>
                </span>
              </button>
            </div>
          );
        })}
      </div>
    </>,
    document.body,
  );
}
