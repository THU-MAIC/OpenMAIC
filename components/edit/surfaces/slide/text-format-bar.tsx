'use client';

import { useCallback } from 'react';
import { Bold, Italic, Underline, AlignLeft, AlignCenter, AlignRight, List } from 'lucide-react';
import type { TextAttrs } from '@/lib/prosemirror/utils';
import {
  runActiveTextCommand,
  type TextCommandPayload,
} from '@/lib/prosemirror/active-editor-registry';
import { useCanvasStore } from '@/lib/store/canvas';
import { useI18n } from '@/lib/hooks/use-i18n';

interface TextFormatBarProps {
  readonly elementId: string;
  readonly attrs: TextAttrs;
}

interface ToggleButtonProps {
  readonly label: string;
  readonly active: boolean;
  readonly payload: TextCommandPayload;
  readonly run: (payload: TextCommandPayload) => void;
  readonly children: React.ReactNode;
}

// preventDefault on mousedown keeps ProseMirror focused/selected so the command applies to the
// live selection (the <select>/<input type=color> intentionally omit this — they need native focus).
function BarButton({
  label,
  onClick,
  className,
  children,
}: {
  readonly label: string;
  readonly onClick: () => void;
  readonly className?: string;
  readonly children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={className}
    >
      {children}
    </button>
  );
}

function ToggleButton({ label, active, payload, run, children }: ToggleButtonProps) {
  return (
    <BarButton
      label={label}
      onClick={() => run(payload)}
      className={`flex h-8 w-8 items-center justify-center rounded-md text-sm ${active ? 'bg-zinc-200 dark:bg-zinc-700' : 'hover:bg-zinc-100 dark:hover:bg-zinc-800'}`}
    >
      {children}
    </BarButton>
  );
}

export function TextFormatBar({ elementId, attrs }: TextFormatBarProps) {
  const { t } = useI18n();
  const run = useCallback(
    (payload: TextCommandPayload) => runActiveTextCommand(elementId, payload),
    [elementId],
  );

  return (
    <div className="flex items-center gap-1">
      <select
        aria-label={t('edit.text.font')}
        value={attrs.fontname}
        onChange={(e) => run({ command: 'fontname', value: e.target.value })}
        className="h-8 rounded-md border border-zinc-200 bg-transparent px-2 text-xs dark:border-zinc-700"
      >
        <option value="">{t('edit.text.fontDefault')}</option>
        <option value="Inter">Inter</option>
        <option value="SimSun">宋体</option>
        <option value="SimHei">黑体</option>
      </select>
      <div className="flex items-center rounded-md border border-zinc-200 dark:border-zinc-700">
        <BarButton
          label={t('edit.text.sizeDown')}
          onClick={() => run({ command: 'fontsize', value: stepFontSize(attrs.fontsize, -2) })}
          className="px-2 text-sm"
        >
          −
        </BarButton>
        <span className="min-w-8 text-center text-xs">{parseInt(attrs.fontsize, 10) || 16}</span>
        <BarButton
          label={t('edit.text.sizeUp')}
          onClick={() => run({ command: 'fontsize', value: stepFontSize(attrs.fontsize, 2) })}
          className="px-2 text-sm"
        >
          +
        </BarButton>
      </div>
      <div className="mx-1 h-5 w-px bg-zinc-200 dark:bg-zinc-700" />
      <ToggleButton
        label={t('edit.text.bold')}
        active={attrs.bold}
        payload={{ command: 'bold' }}
        run={run}
      >
        <Bold className="h-4 w-4" />
      </ToggleButton>
      <ToggleButton
        label={t('edit.text.italic')}
        active={attrs.em}
        payload={{ command: 'em' }}
        run={run}
      >
        <Italic className="h-4 w-4" />
      </ToggleButton>
      <ToggleButton
        label={t('edit.text.underline')}
        active={attrs.underline}
        payload={{ command: 'underline' }}
        run={run}
      >
        <Underline className="h-4 w-4" />
      </ToggleButton>
      <label
        aria-label={t('edit.text.color')}
        className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-md hover:bg-zinc-100 dark:hover:bg-zinc-800"
      >
        <span
          className="text-sm font-semibold"
          style={{ borderBottom: `3px solid ${attrs.color}` }}
        >
          A
        </span>
        <input
          type="color"
          value={attrs.color}
          className="sr-only"
          onChange={(e) => run({ command: 'forecolor', value: e.target.value })}
        />
      </label>
      <div className="mx-1 h-5 w-px bg-zinc-200 dark:bg-zinc-700" />
      <ToggleButton
        label={t('edit.text.alignLeft')}
        active={attrs.align === 'left'}
        payload={{ command: 'align-left' }}
        run={run}
      >
        <AlignLeft className="h-4 w-4" />
      </ToggleButton>
      <ToggleButton
        label={t('edit.text.alignCenter')}
        active={attrs.align === 'center'}
        payload={{ command: 'align-center' }}
        run={run}
      >
        <AlignCenter className="h-4 w-4" />
      </ToggleButton>
      <ToggleButton
        label={t('edit.text.alignRight')}
        active={attrs.align === 'right'}
        payload={{ command: 'align-right' }}
        run={run}
      >
        <AlignRight className="h-4 w-4" />
      </ToggleButton>
      <ToggleButton
        label={t('edit.text.bullet')}
        active={attrs.bulletList}
        payload={{ command: 'bulletList' }}
        run={run}
      >
        <List className="h-4 w-4" />
      </ToggleButton>
    </div>
  );
}

/**
 * Connected variant — subscribes to live richTextAttrs from the canvas store.
 * Keep separate from TextFormatBar so the pure component stays unit-testable.
 */
export function ConnectedTextFormatBar({ elementId }: { readonly elementId: string }) {
  const attrs = useCanvasStore.use.richTextAttrs();
  return <TextFormatBar elementId={elementId} attrs={attrs} />;
}

export function stepFontSize(current: string, delta: number): string {
  const n = parseInt(current, 10) || 16;
  return `${Math.max(8, Math.min(96, n + delta))}px`;
}
