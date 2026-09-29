'use client';

import { forwardRef, useState } from 'react';
import { ChevronDown, Lock, Plug } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Switch } from '@/components/ui/switch';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type {
  ApplyResult,
  ModelSettingsChange,
  ModelSettingsView,
  SlotView,
} from '@/lib/model-settings/client';
import { stationLit, type PlacedStation, type StationLine } from '@/lib/model-settings/diagram';
import { switchOffChange, switchOnChange, type OffMemory } from '@/lib/model-settings/edit';
import { cn } from '@/lib/utils';

import { FirstRunSetup, type SetupOutcome } from './first-run-setup';
import { SlotPicker } from './slot-picker';
import { MS, SlotIcon, slotName } from './slot-meta';
import { lineText } from './station-text';

type T = (key: string, options?: Record<string, unknown>) => string;
type Apply = (change: ModelSettingsChange) => Promise<ApplyResult>;

/** Shared by every node: which picker is open, how to apply, where providers are managed. */
export interface NodeContext {
  view: ModelSettingsView;
  apply: Apply;
  t: T;
  openKey: string | null;
  setOpenKey: (key: string | null) => void;
  onManageProviders: () => void;
  /** What each switched-off slot held, to restore when it is switched on. */
  offMemory: OffMemory;
  /** Where a first-run setup that added its provider reports (outlives the card). */
  onSetupOutcome: (outcome: SetupOutcome) => void;
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
  const toggleable =
    !!line.toggle &&
    !slot.locked &&
    (slot.effective.status === 'assigned' ||
      (slot.effective.status === 'disabled' && slot.assignment === null));

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
      {!slot.locked && (
        <ChevronDown
          className={cn(
            'row-start-1 size-3.5 self-center text-muted-foreground/70 opacity-0 transition-opacity group-hover/line:opacity-100',
            open && 'opacity-100',
            key ? 'col-start-3' : 'col-start-2',
          )}
          aria-hidden="true"
        />
      )}
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
      {slot.locked ? (
        <div className={grid} title={`${text.value}${text.source ? ` · ${text.source}` : ''}`}>
          {content}
        </div>
      ) : (
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
          >
            <SlotPicker
              view={view}
              slot={slot}
              apply={apply}
              onDone={() => setOpenKey(null)}
              onManageProviders={() => {
                setOpenKey(null);
                ctx.onManageProviders();
              }}
              t={t}
            />
          </PopoverContent>
        </Popover>
      )}
      {toggleable && (
        <Switch
          checked={slot.effective.status === 'assigned'}
          disabled={switching}
          aria-label={t(`${MS}.card.toggle`, { name })}
          className="mr-1 h-4 w-7 [&>span]:size-3 [&>span]:data-[state=checked]:translate-x-3"
          onCheckedChange={async (on) => {
            const change = on
              ? switchOnChange(slot, ctx.offMemory)
              : switchOffChange(slot, ctx.offMemory);
            // Not known what it held before: let the user choose rather than guess.
            if (!change) {
              setOpenKey(slot.slot);
              return;
            }
            setSwitching(true);
            const result = await apply(change);
            setSwitching(false);
            if (on && result.ok) ctx.offMemory.delete(slot.slot);
            if (!result.ok) {
              toast.error(
                result.reason === 'conflict' ? t(`${MS}.picker.conflict`) : result.message,
              );
            }
          }}
        />
      )}
    </div>
  );
}

/** A card on the map: a station's title and one line per slot it holds. */
export const StationNode = forwardRef<
  HTMLDivElement,
  {
    station: PlacedStation;
    ctx: NodeContext;
    x: number;
    y: number;
    width: number;
    /** Root only: the first-run setup instead of an empty line. */
    setup?: 'offer' | 'blocked';
    /** Expandable stations: whether the children are drawn, and how to toggle it. */
    expanded?: boolean;
    onExpand?: () => void;
    followers?: number;
  }
>(function StationNode({ station, ctx, x, y, width, setup, expanded, onExpand, followers }, ref) {
  const { t } = ctx;
  const first = station.lines[0].view;
  const lit = stationLit(station);
  const locked = station.lines.some((line) => line.view.locked);
  const root = station.kind === 'root';
  const title = station.labelKey
    ? t(`${MS}.stations.${station.labelKey}`)
    : slotName(t, first.slot);
  const ownChildren = station.children.filter(
    (slot) => slot.assignment !== undefined || slot.locked,
  ).length;
  const setupKey = 'setup:llm';
  // While setup is offered and nothing offers chat, the empty line has nothing to pick from.
  const showLines =
    !root || setup !== 'offer' || ctx.view.providers.some((p) => p.capabilities.chat);

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
        {locked && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                className="shrink-0 text-muted-foreground/70"
                role="img"
                tabIndex={0}
                aria-label={t(`${MS}.card.locked`)}
              >
                <Lock className="size-3.5" />
              </span>
            </TooltipTrigger>
            <TooltipContent className="max-w-56 text-xs">
              {t(`${MS}.card.lockedHint`)}
            </TooltipContent>
          </Tooltip>
        )}
      </div>

      {showLines &&
        station.lines.map((line) => (
          <SlotLine
            key={line.slot}
            line={line}
            slot={line.view}
            ctx={ctx}
            size={root ? 'root' : 'station'}
          />
        ))}

      {root && setup === 'offer' && (
        <div className="flex flex-col items-start gap-2 px-1.5 pb-0.5 pt-2">
          <p className="text-xs leading-relaxed text-muted-foreground">{t(`${MS}.setup.prompt`)}</p>
          <Popover
            open={ctx.openKey === setupKey}
            onOpenChange={(next) => ctx.setOpenKey(next ? setupKey : null)}
          >
            <PopoverTrigger asChild>
              <Button size="sm">
                <Plug className="size-3.5" aria-hidden="true" />
                {t(`${MS}.setup.open`)}
              </Button>
            </PopoverTrigger>
            <PopoverContent
              align="start"
              sideOffset={6}
              collisionPadding={12}
              className="w-80 max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl p-0"
            >
              <FirstRunSetup
                view={ctx.view}
                apply={ctx.apply}
                onOutcome={(outcome) => {
                  ctx.setOpenKey(null);
                  ctx.onSetupOutcome(outcome);
                }}
                t={t}
              />
            </PopoverContent>
          </Popover>
          <button
            type="button"
            onClick={ctx.onManageProviders}
            className="text-xs font-medium text-primary underline-offset-2 hover:underline"
          >
            {t(`${MS}.setup.orProvider`)}
          </button>
        </div>
      )}
      {root && setup === 'blocked' && (
        <p className="px-1.5 pt-1 text-xs leading-relaxed text-muted-foreground">
          {t(`${MS}.setup.askAdmin`)}
        </p>
      )}

      {root && followers !== undefined && first.effective.status === 'assigned' && (
        <p className="px-1.5 pt-0.5 text-[11.5px] text-muted-foreground">
          {t(`${MS}.card.followers`, { count: followers })}
        </p>
      )}

      {onExpand && station.children.length > 0 && (
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
