'use client';

import { useState, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Loader2, Eye, EyeOff, CheckCircle2, AlertCircle, Zap, Trash2 } from 'lucide-react';
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

const statusIcon = (status: ApplyResult['status'] | 'idle') => {
  if (status === 'pending') {
    return <Loader2 className="size-3 animate-spin motion-reduce:animate-none" />;
  }
  if (status === 'failed') return <AlertCircle className="size-3" />;
  if (status === 'lit') return <CheckCircle2 className="size-3" />;
  return null;
};

const SERIAL_VERIFY_STEP_MS = 380;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type ProbePatch = Partial<ApplyResult> & { modality: TokenPlanModality };

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

  // Patch one modality row. During serial apply, rows are added only when their
  // turn starts, so unreached capabilities stay idle instead of looking enabled.
  const patchResult = useCallback(
    (modality: TokenPlanModality, patch: Partial<ApplyResult>) => {
      setResults((prev) => {
        const providerId = selected?.modalities[modality]?.providerId;
        if (!providerId) return prev;
        const next: ApplyResult = {
          modality,
          providerId,
          status: patch.status ?? 'lit',
          detail: patch.detail,
        };
        if (!prev) return [next];
        return prev.some((r) => r.modality === modality)
          ? prev.map((r) => (r.modality === modality ? { ...r, ...patch } : r))
          : [...prev, next];
      });
    },
    [selected],
  );

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

    const llm = selected.modalities.llm;
    const llmProbes = !!llm && !(llm.defaultModels?.length && !llm.verifyModels);
    const mediaProbes = (['image', 'video'] as const).filter(
      (k) => selected.modalities[k]?.verifyModels && selected.modalities[k]?.defaultModels?.length,
    );
    const appliedByModality = new Map(applied.map((r) => [r.modality, r]));
    const revealModalities = MODALITY_ORDER.filter((m) => appliedByModality.has(m));
    setResults([]);

    // 2. LLM: verify/light up its models. Three cases:
    //  a) verifyModels — `defaultModels` are CANDIDATES; verify each via a
    //     minimal chat request and keep the ones that work (auto-prunes
    //     retired/tier-gated models). Falls back to the seeded list on failure.
    //  b) fixed `defaultModels` (no verify) — already seeded by applyTokenPlan.
    //  c) otherwise — probe the /models endpoint.
    const llmProbe = async (): Promise<ProbePatch | null> => {
      if (!llm) return null;
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
        return { modality: 'llm', status: 'lit' };
      } else if (llm.defaultModels?.length) {
        setLlmModelCount(llm.defaultModels.length);
        return { modality: 'llm', status: 'lit' };
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
        return { modality: 'llm', status: 'lit' };
      }
    };

    // 3. Media (image/video): probe whether this plan tier actually supports the
    // model. applyTokenPlan lit them up optimistically; here we prune to the
    // verified subset (and re-select a working model), or disable + mark the row
    // failed if none pass (e.g. video on a Small tier).
    const mediaProbe = async (kind: 'image' | 'video'): Promise<ProbePatch | null> => {
      const target = selected.modalities[kind];
      if (!target?.verifyModels || !target.defaultModels?.length) return null;
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
          return {
            modality: kind,
            status: 'failed',
            detail: t('settings.tokenPlan.tierUnsupported'),
          };
        } else {
          setCfg(
            target.providerId as never,
            {
              customModels: ids.map((id) => ({ id, name: id })),
            } as never,
          );
          setModelId(ids[0]);
          return { modality: kind, status: 'lit' };
        }
      } catch {
        // Network error — leave the optimistic 'lit' state from applyTokenPlan.
        return { modality: kind, status: 'lit' };
      }
    };

    const resolveModality = async (modality: TokenPlanModality): Promise<ProbePatch | null> => {
      const appliedPatch = appliedByModality.get(modality);
      if (!appliedPatch) return null;

      if (modality === 'llm' && llmProbes) {
        return llmProbe();
      }
      if ((modality === 'image' || modality === 'video') && mediaProbes.includes(modality)) {
        return mediaProbe(modality);
      }
      if (modality === 'llm' && llm?.defaultModels?.length) {
        setLlmModelCount(llm.defaultModels.length);
      }
      return appliedPatch;
    };

    // Verify and reveal one row at a time. Non-probed modalities such as TTS and
    // web search still pause briefly before they switch from Verifying to Enabled.
    for (const modality of revealModalities) {
      const stepStartedAt = Date.now();
      patchResult(modality, { status: 'pending', detail: undefined });
      const patch = await resolveModality(modality);
      const elapsed = Date.now() - stepStartedAt;
      if (elapsed < SERIAL_VERIFY_STEP_MS) {
        await wait(SERIAL_VERIFY_STEP_MS - elapsed);
      }
      if (!patch) continue;
      patchResult(modality, patch);
    }

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
    patchResult,
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
                      {isPresetConfigured(preset) && (
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
                {isPresetConfigured(selected) && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 gap-1.5 px-2 text-muted-foreground hover:text-destructive"
                    onClick={(e) => handleRemove(selected, e)}
                  >
                    <Trash2 className="size-3.5" />
                    {t('settings.tokenPlan.remove')}
                  </Button>
                )}
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
                  <Button onClick={handleApply} disabled={applying || !apiKey} className="gap-1.5">
                    <Zap className="h-3.5 w-3.5" />
                    {t('settings.tokenPlan.apply')}
                  </Button>
                </div>
              </div>

              <div className="space-y-2">
                {(() => {
                  const capabilities = MODALITY_ORDER.filter((m) => selected.modalities[m]);
                  const enabledCount = capabilities.filter(
                    (m) => chipStatus(selected, m) === 'lit',
                  ).length;

                  return (
                    <>
                      <div className="flex items-center justify-between gap-3">
                        <div className="text-sm font-medium">
                          {t('settings.tokenPlan.capabilities')}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {t('settings.tokenPlan.configuredSummary', {
                            enabled: enabledCount,
                            total: capabilities.length,
                          })}
                        </div>
                      </div>
                      <div className="border-y text-xs">
                        {capabilities.map((m) => {
                          const status = chipStatus(selected, m);
                          const result = results?.find((r) => r.modality === m);
                          const providerId = selected.modalities[m]?.providerId;
                          const statusLabel =
                            status === 'pending'
                              ? t('settings.tokenPlan.checking')
                              : status === 'failed'
                                ? t('settings.tokenPlan.unavailable')
                                : status === 'lit'
                                  ? t('settings.tokenPlan.enabled')
                                  : t('settings.tokenPlan.pending');
                          const detail =
                            status === 'failed' && result?.detail
                              ? result.detail
                              : status === 'lit' && m === 'llm' && llmModelCount != null
                                ? t('settings.tokenPlan.modelsCount', { n: llmModelCount })
                                : providerId;

                          return (
                            <div
                              key={m}
                              className="grid grid-cols-[minmax(0,1fr)_minmax(120px,0.8fr)_auto] items-center gap-3 border-b py-2.5 last:border-b-0"
                            >
                              <div className="min-w-0 font-medium">{t(MODALITY_LABEL_KEYS[m])}</div>
                              <div className="min-w-0 truncate text-muted-foreground">{detail}</div>
                              <div
                                className={cn(
                                  'inline-flex items-center gap-1.5 justify-self-end font-medium',
                                  status === 'pending' ? 'text-primary' : 'text-muted-foreground',
                                  status === 'lit' && 'text-foreground',
                                )}
                              >
                                {statusIcon(status)}
                                {statusLabel}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </>
                  );
                })()}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
