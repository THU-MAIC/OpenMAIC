'use client';

import { cn } from '@/lib/utils';

/** Shared header for each report panel: title + optional subtitle. */
export function PanelHeader({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div className="flex flex-col gap-1">
      <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
      {subtitle && <p className="text-sm text-muted-foreground">{subtitle}</p>}
    </div>
  );
}

export interface Stat {
  label: string;
  value: string;
  hint?: string;
}

/** A single bordered stat card. */
export function StatTile({ tile }: { tile: Stat }) {
  return (
    <div
      className={cn(
        'flex flex-col gap-1 rounded-xl border bg-card p-4',
        'transition-colors hover:bg-accent/40',
      )}
    >
      <span className="text-xs text-muted-foreground">{tile.label}</span>
      <span className="text-2xl font-semibold tabular-nums">{tile.value}</span>
      {tile.hint && <span className="text-[11px] text-muted-foreground">{tile.hint}</span>}
    </div>
  );
}

/** A compact horizontal row of small stats — used above charts. */
export function StatStrip({ items }: { items: Stat[] }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
      {items.map((it) => (
        <div key={it.label} className="rounded-lg border bg-card/60 px-3 py-2">
          <div className="text-[11px] text-muted-foreground">{it.label}</div>
          <div className="text-lg font-semibold tabular-nums leading-tight">{it.value}</div>
          {it.hint && <div className="text-[11px] text-muted-foreground">{it.hint}</div>}
        </div>
      ))}
    </div>
  );
}
