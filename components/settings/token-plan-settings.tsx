'use client';

import { useState, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Loader2, Eye, EyeOff, CheckCircle2, Circle, XCircle, Zap, Trash2 } from 'lucide-react';
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
import { applyTokenPlan, removeTokenPlan, type ApplyResult } from '@/lib/config/apply-token-plan';
import { modelInfoFromId } from './utils';

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

export function TokenPlanSettings() {
  const { t } = useI18n();
  const setProviderConfig = useSettingsStore((s) => s.setProviderConfig);
  const setImageProviderConfig = useSettingsStore((s) => s.setImageProviderConfig);
  const setVideoProviderConfig = useSettingsStore((s) => s.setVideoProviderConfig);
  const setTTSProviderConfig = useSettingsStore((s) => s.setTTSProviderConfig);
  const setWebSearchProviderConfig = useSettingsStore((s) => s.setWebSearchProviderConfig);
  // Read provider configs so the page can reflect already-persisted state
  // (other settings panels read the store directly; this page must too).
  const providersConfig = useSettingsStore((s) => s.providersConfig);

  const [selected, setSelected] = useState<TokenPlanPreset | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [applying, setApplying] = useState(false);
  const [results, setResults] = useState<ApplyResult[] | null>(null);
  const [llmModelCount, setLlmModelCount] = useState<number | null>(null);

  const grouped = PRESET_CATEGORY_ORDER.map((cat) => ({
    category: cat,
    presets: TOKEN_PLAN_PRESETS.filter((p) => p.category === cat),
  })).filter((g) => g.presets.length > 0);

  const resetResults = () => {
    setResults(null);
    setLlmModelCount(null);
  };

  // Whether a preset's LLM provider already has a saved key (= configured).
  const isPresetConfigured = (preset: TokenPlanPreset): boolean => {
    const llmId = preset.modalities.llm?.providerId;
    return !!(llmId && providersConfig[llmId as keyof typeof providersConfig]?.apiKey);
  };

  // Remove a token plan: clear key + disable across all its modalities.
  const handleRemove = (preset: TokenPlanPreset, e: React.MouseEvent) => {
    e.stopPropagation(); // don't also select the card
    removeTokenPlan(preset, {
      setProviderConfig,
      setImageProviderConfig,
      setVideoProviderConfig,
      setTTSProviderConfig,
      setWebSearchProviderConfig,
    });
    // If the removed plan was selected, reset the page state.
    if (selected?.id === preset.id) {
      setSelected(null);
      setApiKey('');
      resetResults();
    }
  };

  const selectPreset = (preset: TokenPlanPreset) => {
    setSelected(preset);
    // Reflect persisted state: prefill the saved key so the page isn't blank
    // on return (mirrors how other settings panels read the store).
    const llmId = preset.modalities.llm?.providerId;
    const savedKey = llmId
      ? providersConfig[llmId as keyof typeof providersConfig]?.apiKey
      : undefined;
    setApiKey(savedKey || '');
    resetResults();
  };

  const handleApply = useCallback(async () => {
    if (!selected || !apiKey) return;
    setApplying(true);
    setResults(null);
    setLlmModelCount(null);

    // 1. Fill every declared modality synchronously.
    const applied = applyTokenPlan(selected, apiKey, {
      setProviderConfig,
      setImageProviderConfig,
      setVideoProviderConfig,
      setTTSProviderConfig,
      setWebSearchProviderConfig,
    });
    setResults(applied);

    // 2. For the LLM modality, light up its models. Three cases:
    //  a) verifyModels — `defaultModels` are CANDIDATES; verify each via a
    //     minimal chat request and keep the ones that work (auto-prunes
    //     retired/tier-gated models). Falls back to the seeded list on failure.
    //  b) fixed `defaultModels` (no verify) — already seeded by applyTokenPlan.
    //  c) otherwise — probe the /models endpoint.
    const llm = selected.modalities.llm;
    if (llm?.verifyModels && llm.defaultModels?.length) {
      try {
        const res = await fetch('/api/provider/probe-chat-models', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            baseUrl: llm.baseUrl,
            apiKey,
            models: llm.defaultModels,
            apiFormat: llm.apiFormat,
          }),
        });
        const data = await res.json();
        if (res.ok && data.success) {
          const ids: string[] = (data.models || []).map((m: { id: string }) => m.id);
          if (ids.length > 0) {
            setProviderConfig(
              llm.providerId as never,
              { models: ids.map((id) => modelInfoFromId(id)) } as never,
            );
          }
          // If none verified (e.g. all timed out), keep the seeded fallback.
          setLlmModelCount(ids.length || llm.defaultModels.length);
        } else {
          setLlmModelCount(llm.defaultModels.length);
        }
      } catch {
        setLlmModelCount(llm.defaultModels.length);
      }
    } else if (llm?.defaultModels?.length) {
      setLlmModelCount(llm.defaultModels.length);
    } else if (llm) {
      try {
        const res = await fetch('/api/provider/probe-models', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            baseUrl: llm.baseUrl,
            apiKey,
            modelsUrl: llm.modelsUrl,
          }),
        });
        const data = await res.json();
        if (res.ok && data.success) {
          const ids: string[] = (data.models || []).map((m: { id: string }) => m.id);
          if (ids.length > 0) {
            setProviderConfig(
              llm.providerId as never,
              {
                models: ids.map((id) => modelInfoFromId(id)),
              } as never,
            );
          }
          setLlmModelCount(ids.length);
        } else {
          setLlmModelCount(0);
        }
      } catch {
        setLlmModelCount(0);
      }
    }

    setApplying(false);
  }, [
    selected,
    apiKey,
    setProviderConfig,
    setImageProviderConfig,
    setVideoProviderConfig,
    setTTSProviderConfig,
    setWebSearchProviderConfig,
  ]);

  // Modalities NOT declared by the selected plan → "not adapted yet".
  const notAdapted = selected ? MODALITY_ORDER.filter((m) => !selected.modalities[m]) : [];

  return (
    <div className="flex flex-col gap-6 max-w-3xl">
      <div>
        <h3 className="text-sm font-semibold mb-1">{t('settings.tokenPlan.title')}</h3>
        <p className="text-xs text-muted-foreground">{t('settings.tokenPlan.desc')}</p>
      </div>

      {/* Provider selection */}
      <div className="space-y-3">
        <Label className="text-sm">{t('settings.tokenPlan.selectPlan')}</Label>
        {grouped.map((group) => (
          <div key={group.category} className="space-y-2">
            <div className="text-xs font-medium text-muted-foreground">
              {t(CATEGORY_LABEL_KEYS[group.category])}
            </div>
            <div className="grid grid-cols-2 gap-2">
              {group.presets.map((preset) => (
                <button
                  key={preset.id}
                  onClick={() => selectPreset(preset)}
                  className={cn(
                    'flex items-center gap-2.5 p-3 rounded-lg border text-left text-sm transition-colors',
                    selected?.id === preset.id
                      ? 'bg-primary/5 border-primary/50'
                      : 'hover:bg-muted/50',
                  )}
                >
                  {preset.icon ? (
                    <img src={preset.icon} alt="" className="h-5 w-5 shrink-0" />
                  ) : (
                    <span className="h-5 w-5 shrink-0 rounded bg-muted" />
                  )}
                  <span className="flex flex-col min-w-0 flex-1">
                    <span className="truncate font-medium">{preset.name}</span>
                    <span className="truncate text-xs text-muted-foreground">
                      {MODALITY_ORDER.filter((m) => preset.modalities[m])
                        .map((m) => t(MODALITY_LABEL_KEYS[m]))
                        .join(' · ')}
                    </span>
                  </span>
                  {isPresetConfigured(preset) && (
                    <span className="flex items-center gap-2 shrink-0">
                      <span className="flex items-center gap-1 text-xs text-green-600">
                        <CheckCircle2 className="h-3.5 w-3.5" />
                        {t('settings.tokenPlan.configured')}
                      </span>
                      <span
                        role="button"
                        tabIndex={0}
                        title={t('settings.tokenPlan.remove')}
                        onClick={(e) => handleRemove(preset, e)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') handleRemove(preset, e as never);
                        }}
                        className="p-1 rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </span>
                    </span>
                  )}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* Key + apply */}
      {selected && (
        <div className="space-y-3 border-t pt-4">
          <Label className="text-sm">{t('settings.tokenPlan.apiKey')}</Label>
          <div className="flex gap-2">
            <div className="relative flex-1">
              <Input
                type={showKey ? 'text' : 'password'}
                autoComplete="new-password"
                placeholder="sk-..."
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
            <Button onClick={handleApply} disabled={applying || !apiKey} className="gap-1.5">
              {applying ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Zap className="h-3.5 w-3.5" />
              )}
              {t('settings.tokenPlan.apply')}
            </Button>
          </div>
        </div>
      )}

      {/* Apply results */}
      {results && (
        <div className="space-y-2 border-t pt-4">
          <div className="text-xs font-medium text-muted-foreground">
            {t('settings.tokenPlan.litUp')}
          </div>
          {results.map((r) => (
            <div key={r.modality} className="flex items-center gap-2 text-sm">
              {r.status === 'lit' ? (
                <CheckCircle2 className="h-4 w-4 text-green-600" />
              ) : (
                <XCircle className="h-4 w-4 text-red-600" />
              )}
              <span>{t(MODALITY_LABEL_KEYS[r.modality])}</span>
              {r.modality === 'llm' && llmModelCount != null && (
                <span className="text-xs text-muted-foreground">
                  ({t('settings.tokenPlan.modelsLit').replace('{n}', String(llmModelCount))})
                </span>
              )}
              {r.status === 'failed' && r.detail && (
                <span className="text-xs text-red-600">{r.detail}</span>
              )}
            </div>
          ))}
          {notAdapted.map((m) => (
            <div key={m} className="flex items-center gap-2 text-sm text-muted-foreground">
              <Circle className="h-4 w-4" />
              <span>{t(MODALITY_LABEL_KEYS[m])}</span>
              <span className="text-xs">({t('settings.tokenPlan.notAdapted')})</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
