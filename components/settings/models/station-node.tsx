'use client';

import { forwardRef, useState } from 'react';
import { ChevronDown, Lock } from 'lucide-react';
import { toast } from 'sonner';

import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Switch } from '@/components/ui/switch';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { ModelSettingsView, SlotView, ApplyChange } from '@/lib/model-settings/client';
import { stationLit, type PlacedStation, type StationLine } from '@/lib/model-settings/diagram';
import { providersFor, setOnSlot, type OffMemory } from '@/lib/model-settings/edit';
import { flipSwitch, switchChecked } from '@/lib/model-settings/services';
import { slotEditable } from '@/lib/model-settings/shape';
import { cn } from '@/lib/utils';

import { SlotPicker } from './slot-picker';
import { MS, SlotIcon, applyErrorText, slotName } from './slot-meta';
import { lineText } from './station-text';

type T = (key: string, options?: Record<string, unknown>) => string;
type Apply = ApplyChange;

/** Shared by every node: which picker is open, how to apply, where services are managed. */
export interface NodeContext {
  view: ModelSettingsView;
  apply: Apply;
  t: T;
  openKey: string | null;
  setOpenKey: (key: string | null) => void;
  /** Open Model Services, where the services the slots use are set up; absent when it is not shown. */
  onManageProviders?: () => void;
  /** What each switched-off slot held, to restore when it is switched on. */
  offMemory: OffMemory;
}

/**
 * A slot the administrator fixed: one read-only line with its value and a
 * lock, nothing to open or switch.
 */
function LockedLine({ slot, ctx, label }: { slot: SlotView; ctx: NodeContext; label?: string }) {
  const { view, t } = ctx;
  const text = lineText(view, slot, t);
  const fixed = t(`${MS}.source.locked`);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          className={cn(
            'grid min-w-0 items-baseline gap-x-1.5 rounded-md px-1.5 py-1 text-left',
            label ? 'grid-cols-[auto_minmax(0,1fr)]' : 'grid-cols-[minmax(0,1fr)]',
          )}
          data-locked-slot={slot.slot}
          tabIndex={0}
          aria-label={`${slotName(t, slot.slot)}: ${text.value} · ${fixed}`}
        >
          {label && (
            <span className="row-span-2 min-w-6 self-center text-[11px] text-muted-foreground/80">
              {label}
            </span>
          )}
          <span
            className={cn(
              'min-w-0 truncate text-[12.5px]',
              text.tone === 'own' ? 'font-semibold' : 'text-muted-foreground/70',
            )}
          >
            {text.value}
          </span>
          <span className="flex min-w-0 items-center gap-1 text-[11px] text-muted-foreground/80">
            <Lock className="size-3 shrink-0" aria-hidden="true" />
            <span className="truncate">{fixed}</span>
          </span>
        </div>
      </TooltipTrigger>
      <TooltipContent className="max-w-56 text-xs">{t(`${MS}.card.lockedHint`)}</TooltipContent>
    </Tooltip>
  );
}

function SlotLine({
  line,
  slot,
  ctx,
  size,
}: {
  line: StationLine;
  slot: SlotView;
  ctx: NodeContext;
  size: 'root' | 'station';
}) {
  const { view, apply, t, openKey, setOpenKey } = ctx;
  const text = lineText(view, slot, t);
  const name = slotName(t, slot.slot);
  const key = line.labelKey ? t(`${MS}.stations.lines.${line.labelKey}`) : undefined;
  const open = openKey === slot.slot;
  const [switching, setSwitching] = useState(false);
  // A switch wherever there is something to turn on or off: a slot that runs
  // (speech input runs in the browser while it is unset), one switched off,
  // or one some service could serve.
  const toggleable =
    !!line.toggle &&
    (slot.effective.status === 'assigned' ||
      (slot.effective.status === 'disabled' && slot.assignment === null) ||
      (slot.effective.status === 'unassigned' &&
        (slot.capability === 'asr' || providersFor(view, slot.capability).length > 0)));

  const content = (
    <>
      {key && (
        <span className="row-span-2 min-w-6 self-center text-[11px] text-muted-foreground/80">
          {key}
        </span>
      )}
      <span
        className={cn(
          'min-w-0 truncate',
          size === 'root' ? 'text-[15px] tracking-tight' : 'text-[12.5px]',
          text.tone === 'own' && 'font-semibold',
          text.tone === 'inherit' && 'text-muted-foreground',
          (text.tone === 'off' || text.tone === 'none') && 'text-muted-foreground/70',
          text.tone === 'none' && !slot.parent && 'text-amber-600 dark:text-amber-400',
          text.tone === 'invalid' && 'text-destructive',
        )}
      >
        {text.value}
      </span>
      <ChevronDown
        className={cn(
          'row-start-1 size-3.5 self-center text-muted-foreground/70 opacity-0 transition-opacity group-hover/line:opacity-100',
          open && 'opacity-100',
          key ? 'col-start-3' : 'col-start-2',
        )}
        aria-hidden="true"
      />
      {text.source && (
        <span
          className={cn(
            'min-w-0 truncate text-[11px] text-muted-foreground/80',
            key ? 'col-start-2' : 'col-start-1',
          )}
        >
          {text.source}
        </span>
      )}
    </>
  );
  const grid = cn(
    'group/line grid min-w-0 flex-1 items-baseline gap-x-1.5 rounded-md px-1.5 py-1 text-left',
    key ? 'grid-cols-[auto_minmax(0,1fr)_auto]' : 'grid-cols-[minmax(0,1fr)_auto]',
  );

  return (
    <div className="flex items-center gap-1.5">
      <Popover open={open} onOpenChange={(next) => setOpenKey(next ? slot.slot : null)}>
        <PopoverTrigger asChild>
          <button
            type="button"
            data-slot-id={slot.slot}
            aria-label={t(`${MS}.card.edit`, { name, value: text.value })}
            className={cn(
              grid,
              'cursor-pointer transition-colors hover:bg-muted/70 focus-visible:outline-2 focus-visible:outline-primary',
              open && 'bg-muted/70',
            )}
          >
            {content}
          </button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          side="bottom"
          sideOffset={6}
          collisionPadding={12}
          className="w-[272px] max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl p-0"
          onWheelCapture={(event) => event.stopPropagation()}
          // Open on the picker's Tab stop: the current choice, else the first row.
          onOpenAutoFocus={(event) => {
            const row = (event.currentTarget as HTMLElement | null)?.querySelector<HTMLElement>(
              '[data-picker-row][tabindex="0"]',
            );
            if (!row) return;
            event.preventDefault();
            row.focus();
          }}
        >
          <SlotPicker
            view={view}
            slot={slot}
            apply={apply}
            onDone={() => setOpenKey(null)}
            onManageProviders={
              ctx.onManageProviders &&
              (() => {
                setOpenKey(null);
                ctx.onManageProviders?.();
              })
            }
            t={t}
          />
        </PopoverContent>
      </Popover>
      {toggleable && (
        <Switch
          checked={switchChecked(slot)}
          disabled={switching}
          aria-label={t(`${MS}.card.toggle`, { name })}
          className="mr-1 h-4 w-7 [&>span]:size-3 [&>span]:data-[state=checked]:translate-x-3"
          onCheckedChange={async (on) => {
            setSwitching(true);
            try {
              const result = await flipSwitch(apply, view, slot, on, ctx.offMemory);
              // Nothing known to restore and nothing to serve it: let the user choose.
              if (result === 'needs-service') setOpenKey(slot.slot);
              else if (!result.ok) toast.error(applyErrorText(result, t));
            } finally {
              setSwitching(false);
            }
          }}
        />
      )}
    </div>
  );
}

/**
 * A card on the map: a station's title and one line per slot it holds. A slot
 * the administrator fixed is one read-only line.
 */
export const StationNode = forwardRef<
  HTMLDivElement,
  {
    station: PlacedStation;
    ctx: NodeContext;
    x: number;
    y: number;
    width: number;
    /** Root only: nothing offers a language model yet (set one up in Model Services). */
    empty?: 'workspace' | 'server';
    /** Expandable stations: whether the children are drawn, and how to toggle it. */
    expanded?: boolean;
    onExpand?: () => void;
    followers?: number;
  }
>(function StationNode({ station, ctx, x, y, width, empty, expanded, onExpand, followers }, ref) {
  const { t } = ctx;
  const first = station.lines[0].view;
  const lit = stationLit(station);
  const root = station.kind === 'root';
  const title = station.labelKey
    ? t(`${MS}.stations.${station.labelKey}`)
    : slotName(t, first.slot);
  const ownChildren = station.children.filter(setOnSlot).length;
  // Children that are all fixed (with their parent, say) have nothing to open.
  const childrenEditable = station.children.some(slotEditable);
  // With nothing that offers a language model, the root's line has nothing to pick from.
  const showLines = !root || !empty;

  return (
    <div
      ref={ref}
      data-station={station.id}
      className={cn(
        'absolute rounded-[10px] border bg-card text-card-foreground transition-[border-color,background-color,opacity] duration-500',
        root ? 'px-2.5 pb-2.5 pt-3' : 'px-2 pb-2 pt-2.5',
        lit
          ? cn(
              'border-border shadow-[0_1px_2px_rgb(0_0_0/0.05),0_4px_12px_-2px_rgb(0_0_0/0.06)]',
              root && 'border-primary/40',
            )
          : 'border-dashed border-border bg-card/60',
      )}
      style={{ left: x, top: y, width }}
    >
      <div className="flex items-center gap-2 px-1 pb-1">
        <span
          className={cn(
            'flex size-6 shrink-0 items-center justify-center rounded-[7px]',
            lit ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground/70',
          )}
          aria-hidden="true"
        >
          <SlotIcon slot={first.slot} capability={first.capability} className="size-3.5" />
        </span>
        <span
          className={cn(
            'min-w-0 flex-1 truncate font-semibold',
            root ? 'text-[13.5px]' : 'text-[13px]',
            !lit && 'text-muted-foreground',
          )}
        >
          {title}
        </span>
      </div>

      {showLines &&
        station.lines.map((line) =>
          line.view.locked ? (
            <LockedLine
              key={line.slot}
              slot={line.view}
              ctx={ctx}
              label={line.labelKey ? t(`${MS}.stations.lines.${line.labelKey}`) : undefined}
            />
          ) : (
            <SlotLine
              key={line.slot}
              line={line}
              slot={line.view}
              ctx={ctx}
              size={root ? 'root' : 'station'}
            />
          ),
        )}

      {root && empty === 'workspace' && (
        <div className="flex flex-col items-start gap-2 px-1.5 pb-0.5 pt-2">
          <p className="text-xs leading-relaxed text-muted-foreground">{t(`${MS}.empty.prompt`)}</p>
          <button
            type="button"
            onClick={() => ctx.onManageProviders?.()}
            className="text-xs font-medium text-primary underline-offset-2 hover:underline"
          >
            {t(`${MS}.empty.open`)}
          </button>
        </div>
      )}
      {root && empty === 'server' && (
        <p className="px-1.5 pt-1 text-xs leading-relaxed text-muted-foreground">
          {t(`${MS}.empty.askAdmin`)}
        </p>
      )}

      {root &&
        followers !== undefined &&
        !first.locked &&
        first.effective.status === 'assigned' && (
          <p className="px-1.5 pt-0.5 text-[11.5px] text-muted-foreground">
            {t(`${MS}.card.followers`, { count: followers })}
          </p>
        )}

      {onExpand && childrenEditable && (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={onExpand}
          className="mx-1 mt-1 flex w-[calc(100%-0.5rem)] items-center gap-1.5 rounded-b-md border-t px-1.5 pb-0.5 pt-1.5 text-left text-[11.5px] text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
        >
          {ownChildren
            ? t(`${MS}.card.childrenOwn`, { count: ownChildren })
            : t(`${MS}.card.childrenFollow`)}
          <ChevronDown
            className={cn(
              'ml-auto size-3.5 transition-transform duration-300',
              expanded && 'rotate-180',
            )}
            aria-hidden="true"
          />
        </button>
      )}
    </div>
  );
});
