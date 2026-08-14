'use client';

import { LINE_LIST, type LinePoolItem } from '@/configs/lines';

interface LinePresetPickerProps {
  readonly onPick: (preset: LinePoolItem) => void;
}

function getPresetLabel(preset: LinePoolItem) {
  if (preset.isCubic) return '三次曲线';
  if (preset.isCurve) return '曲线';
  if (preset.isBroken2) return '双折线';
  if (preset.isBroken) return '折线';
  if (preset.points[1] === 'arrow') return '箭头直线';
  if (preset.points[1] === 'dot') return '圆点直线';
  return preset.style === 'dashed' ? '虚线' : '直线';
}

/** Renderer-editor insert palette for the existing DSL line presets. */
export function LinePresetPicker({ onPick }: LinePresetPickerProps) {
  return (
    <div className="grid grid-cols-5 gap-2" role="group" aria-label="线条预设">
      {LINE_LIST.flatMap((group) => group.children).map((preset, index) => {
        const label = getPresetLabel(preset);
        return (
          <button
            key={`${preset.path}-${index}`}
            type="button"
            aria-label={label}
            className="flex aspect-square items-center justify-center rounded-md border border-transparent p-2 text-zinc-600 hover:border-violet-300 hover:bg-violet-50 hover:text-violet-700 dark:text-zinc-300 dark:hover:border-violet-500/50 dark:hover:bg-violet-500/10"
            onClick={() => onPick(preset)}
          >
            <svg viewBox="0 0 20 20" className="h-7 w-7" aria-hidden="true">
              <path
                d={preset.path}
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeDasharray={preset.style === 'dashed' ? '5 2.5' : undefined}
              />
            </svg>
          </button>
        );
      })}
    </div>
  );
}
