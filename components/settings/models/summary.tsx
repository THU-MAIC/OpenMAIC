'use client';

import { Lock } from 'lucide-react';

import type { ModelSettingsView, SlotView } from '@/lib/model-settings/client';
import { cn } from '@/lib/utils';

import { MS, SlotIcon, slotName } from './slot-meta';
import { lineText } from './station-text';

type T = (key: string, options?: Record<string, unknown>) => string;

function SummaryRow({ view, slot, t }: { view: ModelSettingsView; slot: SlotView; t: T }) {
  const text = lineText(view, slot, t);
  const nested = slot.parent !== null && slot.parent !== 'llm';
  return (
    <li
      className="flex items-center gap-3 px-3 py-2 text-sm"
      data-summary-slot={slot.slot}
      aria-label={`${slotName(t, slot.slot)}: ${text.value}`}
    >
      <span
        className={cn('flex min-w-0 flex-1 items-center gap-2', nested && 'pl-6')}
        aria-hidden="true"
      >
        <SlotIcon
          slot={slot.slot}
          capability={slot.capability}
          className="size-3.5 shrink-0 text-muted-foreground"
        />
        <span className="truncate">{slotName(t, slot.slot)}</span>
      </span>
      <span
        className={cn(
          'min-w-0 max-w-[55%] truncate text-right',
          text.tone === 'own' || text.tone === 'inherit' ? 'font-medium' : 'text-muted-foreground',
          text.tone === 'invalid' && 'text-destructive',
        )}
        aria-hidden="true"
      >
        {text.value}
      </span>
    </li>
  );
}

/**
 * Course Model Config when the administrator fixed every model: a read-only
 * summary of what each part uses (a model, off, or not configured), with
 * nothing to operate.
 */
export function ModelSummary({ view, t }: { view: ModelSettingsView; t: T }) {
  const shown = view.slots.filter((slot) => !slot.configOnly);
  const groups = [
    { key: 'chat', slots: shown.filter((slot) => slot.capability === 'chat') },
    { key: 'media', slots: shown.filter((slot) => slot.capability !== 'chat') },
  ];
  return (
    <div className="flex max-w-2xl flex-col gap-4 overflow-y-auto">
      <div className="flex items-start gap-3 rounded-xl border bg-muted/30 p-4">
        <Lock className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <div className="space-y-1">
          <h3 className="text-sm font-semibold">{t(`${MS}.summary.title`)}</h3>
          <p className="text-xs leading-relaxed text-muted-foreground">{t(`${MS}.summary.desc`)}</p>
        </div>
      </div>
      {groups.map((group) =>
        group.slots.length ? (
          <section key={group.key} aria-label={t(`${MS}.summary.${group.key}`)}>
            <h4 className="px-1 pb-1.5 text-xs font-medium text-muted-foreground">
              {t(`${MS}.summary.${group.key}`)}
            </h4>
            <ul className="divide-y rounded-xl border">
              {group.slots.map((slot) => (
                <SummaryRow key={slot.slot} view={view} slot={slot} t={t} />
              ))}
            </ul>
          </section>
        ) : null,
      )}
    </div>
  );
}
