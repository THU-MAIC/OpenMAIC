'use client';

import { useState, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Eye,
  EyeOff,
  CheckCircle2,
  Zap,
  MessageSquare,
  Image as ImageIcon,
  Video,
  Volume2,
  Search,
  type LucideIcon,
} from 'lucide-react';
import { useI18n } from '@/lib/hooks/use-i18n';
import { cn } from '@/lib/utils';
import { useSettingsStore } from '@/lib/store/settings';
import {
  TOKEN_PLAN_PRESETS,
  PRESET_CATEGORY_ORDER,
  MODALITY_ORDER,
  type TokenPlanPreset,
  type PresetCategory,
  type TokenPlanModality,
} from '@/lib/config/token-plan-presets';
import { applyTokenPlan, removeTokenPlan } from '@/lib/config/apply-token-plan';

const CATEGORY_LABEL_KEYS: Record<PresetCategory, string> = {
  token_plan: 'settings.presetCategory.tokenPlan',
  aggregator: 'settings.presetCategory.aggregator',
  third_party: 'settings.presetCategory.thirdParty',
  official: 'settings.presetCategory.official',
};

const MODALITY_LABEL_KEYS: Record<TokenPlanModality, string> = {
  llm: 'settings.providers',
  image: 'settings.imageSettings',
  video: 'settings.videoSettings',
  tts: 'settings.ttsSettings',
  webSearch: 'settings.webSearchSettings',
};

const MODALITY_ICONS: Record<TokenPlanModality, LucideIcon> = {
  llm: MessageSquare,
  image: ImageIcon,
  video: Video,
  tts: Volume2,
  webSearch: Search,
};

/** The models a preset declares for one modality (display-only, no probing). */
function modalityModels(preset: TokenPlanPreset, m: TokenPlanModality): string[] {
  const target = preset.modalities[m];
  if (!target) return [];
  if (target.defaultModels?.length) return target.defaultModels;
  if (target.defaultModelId) return [target.defaultModelId];
  return [target.providerId];
}

export function TokenPlanSettings() {
  const { t } = useI18n();
  const setProviderConfig = useSettingsStore((s) => s.setProviderConfig);
  const setImageProviderConfig = useSettingsStore((s) => s.setImageProviderConfig);
  const setVideoProviderConfig = useSettingsStore((s) => s.setVideoProviderConfig);
  const setTTSProviderConfig = useSettingsStore((s) => s.setTTSProviderConfig);
  const setWebSearchProviderConfig = useSettingsStore((s) => s.setWebSearchProviderConfig);
  const setImageProvider = useSettingsStore((s) => s.setImageProvider);
  const setImageModelId = useSettingsStore((s) => s.setImageModelId);
  const setVideoProvider = useSettingsStore((s) => s.setVideoProvider);
  const setVideoModelId = useSettingsStore((s) => s.setVideoModelId);
  // Read provider configs so the page can reflect already-persisted state
  // (other settings panels read the store directly; this page must too).
  const providersConfig = useSettingsStore((s) => s.providersConfig);

  const [selected, setSelected] = useState<TokenPlanPreset | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [activeTab, setActiveTab] = useState<TokenPlanModality>('llm');

  const grouped = PRESET_CATEGORY_ORDER.map((cat) => ({
    category: cat,
    presets: TOKEN_PLAN_PRESETS.filter((p) => p.category === cat),
  })).filter((g) => g.presets.length > 0);

  const presetSavedKey = (preset: TokenPlanPreset): string => {
    const llmId = preset.modalities.llm?.providerId;
    return llmId ? (providersConfig[llmId as keyof typeof providersConfig]?.apiKey ?? '') : '';
  };

  // Whether a preset's LLM provider already has a saved key (= enabled).
  const isPresetEnabled = (preset: TokenPlanPreset): boolean => !!presetSavedKey(preset);

  // The modalities a preset declares, in display order — drives the tab bar.
  const presetModalities = (preset: TokenPlanPreset): TokenPlanModality[] =>
    MODALITY_ORDER.filter((m) => preset.modalities[m]);

  const disablePreset = (preset: TokenPlanPreset) => {
    removeTokenPlan(preset, {
      setProviderConfig,
      setImageProviderConfig,
      setVideoProviderConfig,
      setTTSProviderConfig,
      setWebSearchProviderConfig,
    });
  };

  const selectPreset = (preset: TokenPlanPreset) => {
    setSelected(preset);
    setActiveTab(presetModalities(preset)[0] ?? 'llm');
    // Reflect persisted state: prefill the saved key so the page isn't blank
    // on return (mirrors how other settings panels read the store).
    setApiKey(presetSavedKey(preset));
  };

  // Apply is synchronous: seed every declared modality's config + select the
  // first image/video model, then we're done. No probing — the models a plan
  // offers are listed as-is, and the user picks/toggles on the generation bar.
  const handleApply = useCallback(() => {
    const trimmedKey = apiKey.trim();
    if (!selected || !trimmedKey) return;
    applyTokenPlan(selected, trimmedKey, {
      setProviderConfig,
      setImageProviderConfig,
      setVideoProviderConfig,
      setTTSProviderConfig,
      setWebSearchProviderConfig,
      setImageProvider,
      setImageModelId,
      setVideoProvider,
      setVideoModelId,
    });
  }, [
    selected,
    apiKey,
    setProviderConfig,
    setImageProviderConfig,
    setVideoProviderConfig,
    setTTSProviderConfig,
    setWebSearchProviderConfig,
    setImageProvider,
    setImageModelId,
    setVideoProvider,
    setVideoModelId,
  ]);

  return (
    <div className="flex max-w-4xl flex-col gap-6">
      <div>
        <h3 className="text-sm font-semibold mb-1">{t('settings.tokenPlan.title')}</h3>
        <p className="text-xs text-muted-foreground">{t('settings.tokenPlan.desc')}</p>
      </div>

      <div className="grid gap-6 lg:grid-cols-[280px_minmax(0,1fr)]">
        <div className="space-y-4">
          <Label className="text-sm">{t('settings.tokenPlan.selectPlan')}</Label>
          <div className="space-y-4">
            {grouped.map((group) => (
              <div key={group.category} className="space-y-1">
                <div className="px-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  {t(CATEGORY_LABEL_KEYS[group.category])}
                </div>
                <div className="space-y-0.5">
                  {group.presets.map((preset) => (
                    <button
                      key={preset.id}
                      onClick={() => selectPreset(preset)}
                      className={cn(
                        'flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm transition-colors',
                        selected?.id === preset.id
                          ? 'bg-muted text-foreground'
                          : 'hover:bg-muted/60',
                      )}
                    >
                      {preset.icon ? (
                        <img src={preset.icon} alt="" className="size-5 shrink-0 rounded" />
                      ) : (
                        <span className="size-5 shrink-0 rounded bg-muted" />
                      )}
                      <span className="min-w-0 flex-1 truncate font-medium">{preset.name}</span>
                      {isPresetEnabled(preset) && (
                        <CheckCircle2 className="size-3.5 shrink-0 text-muted-foreground" />
                      )}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="min-w-0 border-l pl-6">
          {!selected ? (
            <div className="py-8 text-sm text-muted-foreground">
              {t('settings.tokenPlan.selectPlan')}
            </div>
          ) : (
            <div className="space-y-5">
              <div className="flex items-center justify-between gap-4 border-b pb-3">
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold">{selected.name}</div>
                </div>
              </div>

              <div className="space-y-2">
                <Label className="text-sm">{t('settings.tokenPlan.apiKey')}</Label>
                <div className="flex gap-2">
                  <div className="relative flex-1">
                    <Input
                      type={showKey ? 'text' : 'password'}
                      autoComplete="new-password"
                      placeholder={selected.apiKeyPlaceholder ?? 'sk-...'}
                      value={apiKey}
                      onChange={(e) => setApiKey(e.target.value)}
                      className="h-8 pr-8"
                    />
                    <button
                      type="button"
                      onClick={() => setShowKey(!showKey)}
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    >
                      {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </div>
                  {(() => {
                    const enabled = isPresetEnabled(selected);
                    const savedKey = presetSavedKey(selected);
                    const trimmedKey = apiKey.trim();
                    const updatingKey = enabled && trimmedKey.length > 0 && trimmedKey !== savedKey;
                    return (
                      <div className="flex items-center gap-2">
                        {updatingKey && (
                          <Button onClick={handleApply} size="sm" className="h-8 gap-1.5">
                            <Zap className="h-3.5 w-3.5" />
                            {t('settings.tokenPlan.updateKey')}
                          </Button>
                        )}
                        <div className="flex h-8 items-center gap-2 rounded-md border px-2">
                          <span className="text-xs text-muted-foreground">
                            {t('settings.tokenPlan.enable')}
                          </span>
                          <Switch
                            checked={enabled}
                            disabled={!enabled && !trimmedKey}
                            onCheckedChange={(checked) => {
                              if (checked) {
                                handleApply();
                              } else {
                                disablePreset(selected);
                              }
                            }}
                            aria-label={t('settings.tokenPlan.enable')}
                          />
                        </div>
                      </div>
                    );
                  })()}
                </div>
              </div>

              {/* Capabilities: a display-only tab list of the models the plan
                  offers per modality. No status, no probing — selection and
                  enable/disable happen on the generation bar. */}
              <div className="space-y-3">
                <div className="text-sm font-medium">{t('settings.tokenPlan.capabilities')}</div>

                {/* Tab bar (segmented control) */}
                <div className="flex gap-0.5 rounded-lg bg-muted/60 p-0.5">
                  {presetModalities(selected).map((m) => {
                    const Icon = MODALITY_ICONS[m];
                    const isActive = activeTab === m;
                    return (
                      <button
                        key={m}
                        onClick={() => setActiveTab(m)}
                        className={cn(
                          'relative flex flex-1 items-center justify-center gap-1.5 rounded-md py-1.5 text-[11px] font-medium transition-all',
                          isActive
                            ? 'bg-background text-foreground shadow-sm'
                            : 'text-muted-foreground hover:text-foreground/80',
                        )}
                      >
                        <Icon className="size-3.5" />
                        <span className="hidden truncate sm:inline">
                          {t(MODALITY_LABEL_KEYS[m])}
                        </span>
                      </button>
                    );
                  })}
                </div>

                {/* Tab content: static model list for the active modality */}
                {(() => {
                  const models = modalityModels(selected, activeTab);
                  return (
                    <div className="space-y-2 rounded-md border p-3">
                      <div className="flex items-center justify-between gap-3 text-xs">
                        <span className="font-medium">{t(MODALITY_LABEL_KEYS[activeTab])}</span>
                        <span className="text-muted-foreground">
                          {t('settings.tokenPlan.modelsCount', { n: models.length })}
                        </span>
                      </div>
                      <ul className="space-y-1">
                        {models.map((id) => (
                          <li
                            key={id}
                            className="flex items-center gap-2 text-xs text-muted-foreground"
                          >
                            <span className="size-1 shrink-0 rounded-full bg-muted-foreground/40" />
                            <span className="truncate font-mono">{id}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  );
                })()}

                <p className="text-[11px] leading-relaxed text-muted-foreground">
                  {t('settings.tokenPlan.offeredNote')}
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
