'use client';

import { useState, useCallback, useMemo } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Loader2,
  Eye,
  EyeOff,
  Wallet,
  CheckCircle2,
  Circle,
  XCircle,
  Zap,
  Plus,
  Trash2,
} from 'lucide-react';
import { useI18n } from '@/lib/hooks/use-i18n';
import { cn } from '@/lib/utils';
import type { ProviderType } from '@/lib/types/provider';
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

interface BalanceInfo {
  supported: boolean;
  planName?: string;
  remaining?: number;
  total?: number;
  unit?: string;
  isValid?: boolean;
  invalidMessage?: string;
}

export function TokenPlanSettings() {
  const { t } = useI18n();
  const setProviderConfig = useSettingsStore((s) => s.setProviderConfig);
  const setImageProviderConfig = useSettingsStore((s) => s.setImageProviderConfig);
  const setVideoProviderConfig = useSettingsStore((s) => s.setVideoProviderConfig);
  const setTTSProviderConfig = useSettingsStore((s) => s.setTTSProviderConfig);
  const setWebSearchProviderConfig = useSettingsStore((s) => s.setWebSearchProviderConfig);
  const setProvidersConfig = useSettingsStore((s) => s.setProvidersConfig);
  // Read provider configs so the page can reflect already-persisted state
  // (other settings panels read the store directly; this page must too).
  const providersConfig = useSettingsStore((s) => s.providersConfig);

  const [selected, setSelected] = useState<TokenPlanPreset | null>(null);
  const [mode, setMode] = useState<'preset' | 'custom'>('preset');
  // Stable id for a custom token plan's LLM provider (generated when entering custom mode).
  const [customId, setCustomId] = useState('');
  const [customName, setCustomName] = useState('');
  const [customBaseUrl, setCustomBaseUrl] = useState('');
  const [customProtocol, setCustomProtocol] = useState<ProviderType>('openai');
  const [apiKey, setApiKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [applying, setApplying] = useState(false);
  const [results, setResults] = useState<ApplyResult[] | null>(null);
  const [llmModelCount, setLlmModelCount] = useState<number | null>(null);
  const [balanceStatus, setBalanceStatus] = useState<'idle' | 'loading' | 'done'>('idle');
  const [balance, setBalance] = useState<BalanceInfo | null>(null);

  const grouped = PRESET_CATEGORY_ORDER.map((cat) => ({
    category: cat,
    presets: TOKEN_PLAN_PRESETS.filter((p) => p.category === cat),
  })).filter((g) => g.presets.length > 0);

  // The plan that apply/balance act on: a chosen preset, or a custom LLM-only
  // plan built from the manual fields. null until enough is filled to apply.
  const effectivePreset: TokenPlanPreset | null = useMemo(() => {
    if (mode === 'custom') {
      const base = customBaseUrl.trim();
      if (!base || !customId) return null;
      return {
        id: customId,
        name: customName.trim() || 'Custom Token Plan',
        category: 'third_party',
        modalities: { llm: { providerId: customId, baseUrl: base, apiFormat: customProtocol } },
      };
    }
    return selected;
  }, [mode, customId, customName, customBaseUrl, customProtocol, selected]);

  const resetResults = () => {
    setResults(null);
    setLlmModelCount(null);
    setBalance(null);
    setBalanceStatus('idle');
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
      removeProvider: (id) => {
        const next = { ...providersConfig };
        delete next[id as keyof typeof next];
        setProvidersConfig(next);
      },
    });
    // If the removed plan was selected, reset the page state.
    if (selected?.id === preset.id) {
      setSelected(null);
      setApiKey('');
      resetResults();
    }
  };

  const selectPreset = (preset: TokenPlanPreset) => {
    setMode('preset');
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

  const enterCustomMode = () => {
    setMode('custom');
    setSelected(null);
    setApiKey('');
    // Generate a stable custom provider id once per entry.
    setCustomId(`custom-tokenplan-${Date.now()}`);
    resetResults();
  };

  const handleApply = useCallback(async () => {
    if (!effectivePreset || !apiKey) return;
    setApplying(true);
    setResults(null);
    setLlmModelCount(null);
    setBalance(null);
    setBalanceStatus('idle');

    // 1. Fill every declared modality synchronously.
    const applied = applyTokenPlan(effectivePreset, apiKey, {
      setProviderConfig,
      setImageProviderConfig,
      setVideoProviderConfig,
      setTTSProviderConfig,
      setWebSearchProviderConfig,
    });
    setResults(applied);

    // 2. For the LLM modality, probe the model list and light models up.
    const llm = effectivePreset.modalities.llm;
    if (llm) {
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
    effectivePreset,
    apiKey,
    setProviderConfig,
    setImageProviderConfig,
    setVideoProviderConfig,
    setTTSProviderConfig,
    setWebSearchProviderConfig,
  ]);

  const handleCheckBalance = useCallback(async () => {
    const llm = effectivePreset?.modalities.llm;
    if (!llm || !apiKey) return;
    setBalanceStatus('loading');
    setBalance(null);
    try {
      const res = await fetch('/api/provider/balance', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ baseUrl: llm.baseUrl, apiKey }),
      });
      const data = await res.json();
      setBalance(data.balance ?? { supported: false });
    } catch {
      setBalance({ supported: false });
    } finally {
      setBalanceStatus('done');
    }
  }, [effectivePreset, apiKey]);

  // Modalities NOT declared by the effective plan → "not adapted yet".
  const notAdapted = effectivePreset
    ? MODALITY_ORDER.filter((m) => !effectivePreset.modalities[m])
    : [];

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
                    mode === 'preset' && selected?.id === preset.id
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

        {/* Custom token plan */}
        <div className="space-y-2">
          <div className="text-xs font-medium text-muted-foreground">
            {t('settings.tokenPlan.customGroup')}
          </div>
          <button
            onClick={enterCustomMode}
            className={cn(
              'flex items-center gap-2.5 p-3 rounded-lg border text-left text-sm transition-colors w-full',
              mode === 'custom' ? 'bg-primary/5 border-primary/50' : 'hover:bg-muted/50',
            )}
          >
            <Plus className="h-5 w-5 shrink-0 text-muted-foreground" />
            <span className="flex flex-col min-w-0">
              <span className="truncate font-medium">{t('settings.tokenPlan.customName')}</span>
              <span className="truncate text-xs text-muted-foreground">
                {t('settings.tokenPlan.customHint')}
              </span>
            </span>
          </button>
        </div>
      </div>

      {/* Custom-mode manual fields */}
      {mode === 'custom' && (
        <div className="space-y-3 border-t pt-4">
          <div className="space-y-2">
            <Label className="text-sm">{t('settings.providerName')}</Label>
            <Input
              placeholder={t('settings.providerNamePlaceholder')}
              value={customName}
              onChange={(e) => setCustomName(e.target.value)}
              className="h-8"
            />
          </div>
          <div className="space-y-2">
            <Label className="text-sm">{t('settings.providerApiMode')}</Label>
            <div className="grid grid-cols-3 gap-2">
              {(['openai', 'anthropic', 'google'] as const).map((p) => (
                <button
                  key={p}
                  onClick={() => setCustomProtocol(p)}
                  className={cn(
                    'p-2 rounded-lg border text-left text-sm transition-colors',
                    customProtocol === p
                      ? 'bg-primary/5 border-primary/50'
                      : 'hover:bg-muted/50 border-transparent',
                  )}
                >
                  {t(
                    p === 'openai'
                      ? 'settings.apiModeOpenAI'
                      : p === 'anthropic'
                        ? 'settings.apiModeAnthropic'
                        : 'settings.apiModeGoogle',
                  )}
                </button>
              ))}
            </div>
          </div>
          <div className="space-y-2">
            <Label className="text-sm">{t('settings.defaultBaseUrl')}</Label>
            <Input
              type="url"
              placeholder="https://api.example.com/v1"
              value={customBaseUrl}
              onChange={(e) => setCustomBaseUrl(e.target.value)}
              className="h-8"
            />
          </div>
        </div>
      )}

      {/* Key + apply */}
      {effectivePreset && (
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
            {effectivePreset.modalities.llm && (
              <Button
                variant="outline"
                onClick={handleCheckBalance}
                disabled={balanceStatus === 'loading' || !apiKey}
                className="gap-1.5"
              >
                {balanceStatus === 'loading' ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Wallet className="h-3.5 w-3.5" />
                )}
                {t('settings.checkBalance')}
              </Button>
            )}
          </div>

          {/* Balance bar */}
          {balance && balanceStatus === 'done' && (
            <div className="text-sm">
              {balance.supported && balance.isValid !== false ? (
                <span>
                  {balance.planName ? `${balance.planName} · ` : ''}
                  {t('settings.balanceRemaining')}:{' '}
                  <span className="font-medium">
                    {balance.remaining?.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                    {balance.total != null
                      ? ` / ${balance.total.toLocaleString(undefined, { maximumFractionDigits: 2 })}`
                      : ''}{' '}
                    {balance.unit || ''}
                  </span>
                </span>
              ) : balance.supported ? (
                <span className="text-red-600">
                  {balance.invalidMessage || t('settings.balanceInvalid')}
                </span>
              ) : (
                <span className="text-muted-foreground">{t('settings.balanceUnsupported')}</span>
              )}
            </div>
          )}
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
