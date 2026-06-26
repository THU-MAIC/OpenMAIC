'use client';

import { useState, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Loader2,
  Eye,
  EyeOff,
  CheckCircle2,
  Zap,
  Trash2,
  Brain,
  Image as ImageIcon,
  Video,
  AudioLines,
  Globe,
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

// Each modality carries its own identity icon in the result tiles, so a row is
// recognizable at a glance rather than reading as an anonymous status dot.
const MODALITY_ICONS: Record<TokenPlanModality, LucideIcon> = {
  llm: Brain,
  image: ImageIcon,
  video: Video,
  tts: AudioLines,
  webSearch: Globe,
};

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
  const imageProvidersConfig = useSettingsStore((s) => s.imageProvidersConfig);
  const videoProvidersConfig = useSettingsStore((s) => s.videoProvidersConfig);
  const ttsProvidersConfig = useSettingsStore((s) => s.ttsProvidersConfig);
  const webSearchProvidersConfig = useSettingsStore((s) => s.webSearchProvidersConfig);

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

  // Patch a single modality's result row by modality key (probes resolve
  // independently and out of order, so each updates only its own row).
  const patchResult = (modality: TokenPlanModality, patch: Partial<ApplyResult>) => {
    setResults(
      (prev) => prev?.map((r) => (r.modality === modality ? { ...r, ...patch } : r)) ?? prev,
    );
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
      setImageProvider,
      setImageModelId,
      setVideoProvider,
      setVideoModelId,
    });

    // Which modalities run a live probe (and so start in a 'pending' spinner
    // state, resolving to lit/failed on their own). Everything else is just
    // "configured" and shows lit immediately. The panel renders right away so
    // the rows + spinners give live progress instead of dead air.
    const llm = selected.modalities.llm;
    // An LLM probe runs unless the preset ships a fixed model list with no
    // verification (case b) — that path makes no request, so no spinner.
    const llmProbes = !!llm && !(llm.defaultModels?.length && !llm.verifyModels);
    const mediaProbes = (['image', 'video'] as const).filter(
      (k) => selected.modalities[k]?.verifyModels && selected.modalities[k]?.defaultModels?.length,
    );
    const pendingModalities = new Set<TokenPlanModality>([
      ...(llmProbes ? (['llm'] as const) : []),
      ...mediaProbes,
    ]);
    setResults(
      applied.map((r) => (pendingModalities.has(r.modality) ? { ...r, status: 'pending' } : r)),
    );

    // 2. LLM: light up its models. Three cases:
    //  a) verifyModels — `defaultModels` are CANDIDATES; verify each via a
    //     minimal chat request and keep the ones that work (auto-prunes
    //     retired/tier-gated models). Falls back to the seeded list on failure.
    //  b) fixed `defaultModels` (no verify) — already seeded by applyTokenPlan.
    //  c) otherwise — probe the /models endpoint.
    const llmProbe = async () => {
      if (!llm) return;
      if (llm.verifyModels && llm.defaultModels?.length) {
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
                { models: ids.map((id) => modelInfoFromId(id, llm.providerId)) } as never,
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
        patchResult('llm', { status: 'lit' });
      } else if (llm.defaultModels?.length) {
        setLlmModelCount(llm.defaultModels.length);
        patchResult('llm', { status: 'lit' });
      } else {
        try {
          const res = await fetch('/api/provider/probe-models', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ baseUrl: llm.baseUrl, apiKey, modelsUrl: llm.modelsUrl }),
          });
          const data = await res.json();
          if (res.ok && data.success) {
            const ids: string[] = (data.models || []).map((m: { id: string }) => m.id);
            if (ids.length > 0) {
              setProviderConfig(
                llm.providerId as never,
                { models: ids.map((id) => modelInfoFromId(id, llm.providerId)) } as never,
              );
            }
            setLlmModelCount(ids.length);
          } else {
            setLlmModelCount(0);
          }
        } catch {
          setLlmModelCount(0);
        }
        patchResult('llm', { status: 'lit' });
      }
    };

    // 3. Media (image/video): probe whether this plan tier actually supports the
    // model. applyTokenPlan lit them up optimistically; here we prune to the
    // verified subset (and re-select a working model), or disable + mark the row
    // failed if none pass (e.g. video on a Small tier).
    const mediaProbe = async (kind: 'image' | 'video') => {
      const target = selected.modalities[kind];
      if (!target?.verifyModels || !target.defaultModels?.length) return;
      try {
        const res = await fetch('/api/provider/probe-chat-models', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            baseUrl: target.baseUrl,
            apiKey,
            models: target.defaultModels,
            kind,
          }),
        });
        const data = await res.json();
        const ids: string[] =
          res.ok && data.success ? (data.models || []).map((m: { id: string }) => m.id) : [];
        const setCfg = kind === 'image' ? setImageProviderConfig : setVideoProviderConfig;
        const setModelId = kind === 'image' ? setImageModelId : setVideoModelId;
        if (ids.length === 0) {
          setCfg(target.providerId as never, { enabled: false } as never);
          patchResult(kind, { status: 'failed', detail: t('settings.tokenPlan.tierUnsupported') });
        } else {
          setCfg(
            target.providerId as never,
            {
              customModels: ids.map((id) => ({ id, name: id })),
            } as never,
          );
          setModelId(ids[0]);
          patchResult(kind, { status: 'lit' });
        }
      } catch {
        // Network error — leave the optimistic 'lit' state from applyTokenPlan.
        patchResult(kind, { status: 'lit' });
      }
    };

    // Run every probe in parallel; each row resolves on its own.
    await Promise.all([llmProbe(), ...mediaProbes.map((k) => mediaProbe(k))]);

    setApplying(false);
  }, [
    selected,
    apiKey,
    t,
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

  // Live status for one of a preset's capability chips. Only the selected preset
  // mid/post-apply has probe results; every other chip stays 'idle' (neutral).
  // Whether a modality's provider is persisted as configured + enabled in the
  // store (survives navigating away and reopening — the store is persisted, the
  // transient `results` state is not). A modality probed as unavailable was
  // disabled on apply, so it reads as not-configured here.
  const isModalityConfigured = (preset: TokenPlanPreset, m: TokenPlanModality): boolean => {
    const id = preset.modalities[m]?.providerId;
    if (!id) return false;
    const enabledAndKeyed = (c?: { apiKey?: string; enabled?: boolean }) =>
      !!c?.apiKey && c.enabled !== false;
    switch (m) {
      case 'llm':
        return !!providersConfig[id as keyof typeof providersConfig]?.apiKey;
      case 'image':
        return enabledAndKeyed(imageProvidersConfig[id as keyof typeof imageProvidersConfig]);
      case 'video':
        return enabledAndKeyed(videoProvidersConfig[id as keyof typeof videoProvidersConfig]);
      case 'tts':
        return enabledAndKeyed(ttsProvidersConfig[id as keyof typeof ttsProvidersConfig]);
      case 'webSearch':
        return enabledAndKeyed(
          webSearchProvidersConfig[id as keyof typeof webSearchProvidersConfig],
        );
      default:
        return false;
    }
  };

  // Live status for one of a preset's capability chips. The selected preset's
  // in-flight probe results win (pending/lit/failed this session); otherwise we
  // fall back to the persisted store config so a previously-lit plan stays lit
  // after navigating away and back.
  const chipStatus = (
    preset: TokenPlanPreset,
    m: TokenPlanModality,
  ): ApplyResult['status'] | 'idle' => {
    if (selected?.id === preset.id && results) {
      return results.find((r) => r.modality === m)?.status ?? 'idle';
    }
    return isModalityConfigured(preset, m) ? 'lit' : 'idle';
  };

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
                  <span className="flex flex-col min-w-0 flex-1 gap-1">
                    <span className="truncate font-medium">{preset.name}</span>
                    <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                      {MODALITY_ORDER.filter((m) => preset.modalities[m]).map((m) => {
                        const st = chipStatus(preset, m);
                        const ChipIcon = MODALITY_ICONS[m];
                        const showCount =
                          st === 'lit' && m === 'llm' && llmModelCount != null
                            ? ` ${llmModelCount}`
                            : '';
                        return (
                          <span
                            key={m}
                            className={cn(
                              'inline-flex items-center gap-1 text-xs transition-colors',
                              st === 'lit'
                                ? 'text-green-600 dark:text-green-500'
                                : st === 'failed'
                                  ? 'text-muted-foreground/40 line-through'
                                  : st === 'pending'
                                    ? 'text-foreground'
                                    : 'text-muted-foreground',
                            )}
                          >
                            {st === 'pending' ? (
                              <Loader2 className="size-3 shrink-0 animate-spin motion-reduce:animate-none" />
                            ) : st === 'lit' ? (
                              <CheckCircle2 className="size-3 shrink-0" />
                            ) : (
                              <ChipIcon className="size-3 shrink-0" />
                            )}
                            {t(MODALITY_LABEL_KEYS[m])}
                            {showCount}
                          </span>
                        );
                      })}
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
    </div>
  );
}
