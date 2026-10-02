'use client';

// The home toolbar's model picker: it sets the default model (the `llm`
// root), so it says so, and says when some stages use a model of their own
// (set in Course Model Config). When every stage a course is generated with
// has its own model, picking a default would change nothing for the course:
// the pill then summarises the per-stage setup and opens Course Model Config.

import type { ComponentProps } from 'react';
import { Layers } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import type { ModelSettingsView } from '@/lib/model-settings/client';
import { modelName } from '@/lib/model-settings/edit';
import {
  courseStagesAllOverridden,
  courseStagesPlanName,
  defaultModelOverrides,
  type OverriddenStage,
} from '@/lib/model-settings/overrides';
import { ModelPicker } from './model-picker';
import { slotName } from './models/slot-meta';

type Translate = (key: string, options?: Record<string, unknown>) => string;

/** One line per stage set separately: its name as the map shows it, and its model (or off). */
export function overrideLines(
  view: ModelSettingsView,
  overrides: OverriddenStage[],
  t: Translate,
): { slot: string; stage: string; model: string }[] {
  return overrides.map((entry) => {
    // A page type is named with the content station it belongs to.
    const stage =
      entry.parent && entry.parent !== 'llm'
        ? `${slotName(t, entry.parent)} · ${slotName(t, entry.slot)}`
        : slotName(t, entry.slot);
    const model =
      entry.target.kind === 'off'
        ? t('toolbar.off')
        : modelName(view, 'chat', entry.target.providerId, entry.target.modelId ?? '') ||
          entry.target.providerId;
    return { slot: entry.slot, stage, model };
  });
}

function OverrideList({
  view,
  overrides,
  heading,
  t,
}: {
  view: ModelSettingsView;
  overrides: OverriddenStage[];
  heading: string;
  t: Translate;
}) {
  return (
    <div className="max-w-[280px] space-y-1 py-0.5 text-xs">
      <p className="font-medium">{heading}</p>
      <ul className="space-y-0.5">
        {overrideLines(view, overrides, t).map((line) => (
          <li key={line.slot} className="flex items-baseline gap-2">
            <span className="shrink-0 opacity-80">{line.stage}</span>
            <span className="min-w-0 truncate font-mono">{line.model}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function HomeModelPicker({
  view,
  onOpenCourseModels,
  className,
  t,
  ...picker
}: Omit<ComponentProps<typeof ModelPicker>, 'valuePrefix' | 'note' | 't'> & {
  view: ModelSettingsView | null;
  /** Open Settings on Course Model Config; without it no hint or summary is offered. */
  onOpenCourseModels?: () => void;
  t: Translate;
}) {
  const overrides = defaultModelOverrides(view);
  const hasDefault = !!picker.value;

  if (view && hasDefault && onOpenCourseModels && courseStagesAllOverridden(view)) {
    const plan = courseStagesPlanName(view);
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={onOpenCourseModels}
            aria-label={t('toolbar.perStageSetup')}
            className={cn(
              'inline-flex min-w-0 items-center gap-1.5 border border-border/60 bg-background font-medium transition-colors',
              'hover:bg-muted/60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary',
              className,
            )}
          >
            <Layers className="size-3.5 shrink-0 text-violet-500" aria-hidden="true" />
            <span className="shrink-0">{t('toolbar.perStageSetup')}</span>
            {plan && (
              <span className="min-w-0 truncate text-muted-foreground">
                <span aria-hidden="true">· </span>
                {plan}
              </span>
            )}
          </button>
        </TooltipTrigger>
        <TooltipContent>
          <OverrideList
            view={view}
            overrides={overrides}
            heading={t('toolbar.perStageSetupHint')}
            t={t}
          />
        </TooltipContent>
      </Tooltip>
    );
  }

  return (
    <>
      <ModelPicker
        {...picker}
        className={className}
        valuePrefix={hasDefault ? t('toolbar.defaultModel') : undefined}
        note={t('toolbar.defaultModelNote')}
        t={t}
      />
      {view && onOpenCourseModels && overrides.length > 0 && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={onOpenCourseModels}
              className="inline-flex shrink-0 items-center whitespace-nowrap rounded-full px-1.5 py-1 text-[11px] text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
            >
              {t('toolbar.stagesSetSeparately', { count: overrides.length })}
            </button>
          </TooltipTrigger>
          <TooltipContent>
            <OverrideList
              view={view}
              overrides={overrides}
              heading={t('toolbar.stagesSetSeparatelyHint')}
              t={t}
            />
          </TooltipContent>
        </Tooltip>
      )}
    </>
  );
}
