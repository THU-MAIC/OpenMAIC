'use client';

import { Lock } from 'lucide-react';

import { useI18n } from '@/lib/hooks/use-i18n';
import type { ApplyChange, ModelSettingsView } from '@/lib/model-settings/client';

import { ModelMap } from './model-map';
import { MS } from './slot-meta';

/**
 * The body of Course Model Config: the course model map (which model each
 * part of the product uses, edited on its card) with its legend. The models
 * come from the services set up in Model Services and Token Plan; the map
 * links there when it needs one.
 */
export function CourseModelMap({
  view,
  apply,
  onManageProviders,
}: {
  view: ModelSettingsView;
  apply: ApplyChange;
  /** Open Model Services. */
  onManageProviders: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div
        className="flex flex-wrap items-center justify-end gap-x-4 gap-y-1 text-xs text-muted-foreground"
        aria-label={t(`${MS}.legend.label`)}
      >
        <span className="inline-flex items-center gap-1.5">
          <span className="w-5 border-t-[1.5px] border-primary/50" aria-hidden="true" />
          {t(`${MS}.legend.follows`)}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span
            className="w-5 border-t-[1.5px] border-dashed border-muted-foreground/50"
            aria-hidden="true"
          />
          {t(`${MS}.legend.own`)}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <Lock className="size-3" aria-hidden="true" />
          {t(`${MS}.legend.locked`)}
        </span>
      </div>
      <ModelMap view={view} apply={apply} t={t} onManageProviders={onManageProviders} />
    </div>
  );
}
