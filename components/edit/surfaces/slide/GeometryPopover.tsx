'use client';

import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useI18n } from '@/lib/hooks/use-i18n';
import type { PPTElement } from '@/lib/types/slides';

interface GeometryPopoverProps {
  readonly element: PPTElement;
  readonly onPatch: (patch: Partial<PPTElement>) => void;
}

const FIELDS = [
  { key: 'left', labelKey: 'edit.geometry.x' },
  { key: 'top', labelKey: 'edit.geometry.y' },
  { key: 'width', labelKey: 'edit.geometry.width' },
  { key: 'height', labelKey: 'edit.geometry.height' },
  { key: 'rotate', labelKey: 'edit.geometry.rotate' },
] as const;

/**
 * Numeric x/y/w/h/rotate editor — the precise fallback to canvas
 * drag-resize. Each commit is one `element.update` op (one undo step),
 * applied through the surface session so it shares history with the
 * canvas gestures.
 */
export function GeometryPopover({ element, onPatch }: GeometryPopoverProps) {
  const { t } = useI18n();
  // The surface only mounts this for box-geometry elements (line elements
  // are gated out in useSlideSurfaceState), so left/top/width/height/rotate
  // are all present — this numeric view is safe by construction.
  const geom = element as unknown as Record<string, number>;

  return (
    <div className="grid grid-cols-2 gap-2">
      {FIELDS.map(({ key, labelKey }) => (
        <div key={key} className="flex flex-col gap-1">
          <Label htmlFor={`geom-${key}`} className="text-xs text-zinc-500 dark:text-zinc-400">
            {t(labelKey)}
          </Label>
          <Input
            id={`geom-${key}`}
            type="number"
            value={Math.round(geom[key] ?? 0)}
            onChange={(e) => {
              const value = Number(e.target.value);
              if (Number.isFinite(value)) onPatch({ [key]: value } as Partial<PPTElement>);
            }}
          />
        </div>
      ))}
    </div>
  );
}
