'use client';

import { AlertTriangle, Camera, CheckCircle2, Lock, Sparkles } from 'lucide-react';

import { useI18n } from '@/lib/hooks/use-i18n';
import type { ApplyChange, ModelSettingsView } from '@/lib/model-settings/client';
import { settingsSections } from '@/lib/model-settings/shape';
import { getCameraTutorCapabilities } from '@/lib/live-tutor/model-capabilities';

import { ModelMap } from './model-map';
import { MS } from './slot-meta';

/**
 * The body of Course Model Config: the course model map (which model each
 * part of the product uses, edited on its card) with its legend. The models
 * come from the services set up in Model Services and Token Plan; the map
 * links there when Model Services is shown. When nothing can be changed (the
 * administrator fixed every model), every card is read-only and one line
 * above the map says so.
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
  const sections = settingsSections(view);
  const anyLocked = view.slots.some((slot) => slot.locked && !slot.configOnly);
  const cameraCaps = getCameraTutorCapabilities(view);
  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {sections.shape === 'admin' ? (
          <p className="inline-flex items-center gap-1.5" data-admin-notice="">
            <Lock className="size-3.5" aria-hidden="true" />
            {t(`${MS}.adminNotice`)}
          </p>
        ) : (
          <span />
        )}
        <div
          className="flex flex-wrap items-center justify-end gap-x-4 gap-y-1"
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
          {anyLocked && (
            <span className="inline-flex items-center gap-1.5">
              <Lock className="size-3" aria-hidden="true" />
              {t(`${MS}.legend.locked`)}
            </span>
          )}
        </div>
      </div>
      <ModelMap
        view={view}
        apply={apply}
        t={t}
        onManageProviders={sections.modelServices.length ? onManageProviders : undefined}
      />

      {/* Camera & Live Tutor capability summary (follows Classroom slot) */}
      <div
        data-testid="settings-camera-tutor-status"
        className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border/70 bg-muted/30 px-3.5 py-2.5 text-xs"
      >
        <div className="flex items-center gap-2 min-w-0">
          <div className="size-7 rounded-lg bg-violet-100 dark:bg-violet-900/40 text-violet-600 dark:text-violet-300 flex items-center justify-center shrink-0">
            <Camera className="size-3.5" />
          </div>
          <div className="min-w-0">
            <div className="font-semibold text-foreground">{t('liveTutor.settingsCardTitle')}</div>
            <p className="text-[11px] text-muted-foreground leading-snug">
              {cameraCaps.supportsLiveStreaming
                ? t('liveTutor.settingsLiveActiveDesc')
                : t('liveTutor.settingsSnapshotFallbackDesc')}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5 shrink-0">
          <span
            className={
              cameraCaps.supportsLiveStreaming
                ? 'inline-flex items-center gap-1 rounded-full bg-emerald-100 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-300 px-2.5 py-0.5 text-[11px] font-medium'
                : 'inline-flex items-center gap-1 rounded-full bg-slate-200/80 dark:bg-slate-800 text-slate-700 dark:text-slate-300 px-2.5 py-0.5 text-[11px] font-medium'
            }
          >
            <Sparkles className="size-3" />
            {cameraCaps.supportsLiveStreaming
              ? t('liveTutor.settingsBadgeLive')
              : t('liveTutor.settingsBadgeSnapshot')}
          </span>
          {!cameraCaps.supportsVision ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 dark:bg-amber-950/60 text-amber-800 dark:text-amber-300 px-2.5 py-0.5 text-[11px] font-medium">
              <AlertTriangle className="size-3" />
              {t('liveTutor.settingsBadgeNoVision')}
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 rounded-full bg-violet-100 dark:bg-violet-950/60 text-violet-700 dark:text-violet-300 px-2.5 py-0.5 text-[11px] font-medium">
              <CheckCircle2 className="size-3" />
              {t('liveTutor.settingsBadgeVisionReady')}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
