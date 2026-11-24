'use client';

// The "Token Plan" section. On the left, the region's plans: the connected
// ones in priority order, each with what is left of its quota (or its
// balance) and a warning when its tier lacks a capability, then the ones not
// connected. On the right, the selected plan: its account (key, priority,
// vendor console), its quota as meters with reset times, what it gives the
// workspace as one card per capability, and its models and default routing
// folded away. A plan is a provider of the workspace's model settings on the
// server: saving its key adds that provider (or replaces its key) and applies
// the plan's recommended configuration to the slots. When that would replace
// models the workspace picked, the user is asked first: the plan's setup, or
// keep theirs and fill only the empty slots. Disconnecting removes the
// provider. A plan the server configures is shown as connected, read-only.

import { useState, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  ChevronDown,
  CircleAlert,
  ExternalLink,
  Eye,
  EyeOff,
  Globe,
  KeyRound,
  Layers,
  MoreHorizontal,
  Unlink,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { useI18n } from '@/lib/hooks/use-i18n';
import { cn } from '@/lib/utils';
import {
  TOKEN_PLAN_PRESETS,
  MODALITY_ORDER,
  tokenPlanInRegion,
  type TokenPlanPreset,
  type TokenPlanModality,
  type TokenPlanRegion,
} from '@/lib/config/token-plan-presets';
import { tokenPlanPresetId } from '@/lib/config/preset-ids';
import type {
  ApplyChange,
  ModelSettingsView,
  PresetView,
  ProviderView,
} from '@/lib/model-settings/client';
import { modelName, providerLabel, splitRef } from '@/lib/model-settings/edit';
import { planProvider } from '@/lib/model-settings/services';
import { tokenPlanListed } from '@/lib/model-settings/shape';
import {
  connectConflicts,
  connectTokenPlan,
  type PlanApplyMode,
  type PlanConflict,
} from '@/lib/model-settings/token-plan';
import {
  applyErrorText,
  CredentialStorageHint,
  reportApply,
  ServerOnlyNotice,
} from './server-settings';
import { MS, slotName } from './models/slot-meta';
import { CARD_CAPABILITIES, PlanCapabilities, planModels } from './plan-capabilities';
import { PlanQuotaCard, QuotaSummary, usePlanQuotas } from './plan-quota';

const REGIONS: readonly TokenPlanRegion[] = ['domestic', 'international'];

/** Display-name mapping: the volcengine-ark preset is shown as "Seed". */
function presetDisplayName(preset: TokenPlanPreset): string {
  if (preset.id === 'minimax') return 'MiniMax';
  if (preset.id === 'volcengine-ark') return 'Seed';
  return preset.name;
}

/** Balance-management link: `{vendor site}/credits`, preserving the query. */
function portalCreditsUrl(base: string): string {
  try {
    const url = new URL(base);
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/credits`;
    return url.toString();
  } catch {
    return base;
  }
}

/** Models & default routing rows: capability (· stage) → the plan's default model. */
interface ModelPlanItem {
  capability: TokenPlanModality;
  stageId?: string;
  model?: string;
}

const MODEL_PLAN_STAGE_LABEL_KEYS: Record<string, string> = {
  'scene-content:slide': 'settings.tokenPlan.stageSlide',
  'scene-content:interactive': 'settings.tokenPlan.stageInteractive',
};

const MODEL_PLAN_CAPABILITY_LABEL_KEYS: Record<TokenPlanModality, string> = {
  llm: 'settings.tokenPlan.capLlm',
  image: 'settings.tokenPlan.capImage',
  video: 'settings.tokenPlan.capVideo',
  tts: 'settings.tokenPlan.capTts',
  asr: 'settings.tokenPlan.capAsr',
  document: 'settings.tokenPlan.capDocument',
  webSearch: 'settings.tokenPlan.capWebSearch',
  webFetch: 'settings.tokenPlan.capWebFetch',
};

/** The slot capability a modality's provider serves. */
const MODALITY_CAPABILITY = {
  llm: 'chat',
  image: 'image',
  video: 'video',
  tts: 'tts',
  asr: 'asr',
  document: 'document',
  webSearch: 'webSearch',
  webFetch: 'webFetch',
} as const satisfies Record<TokenPlanModality, string>;

function modelPlanItems(
  preset: TokenPlanPreset,
  offered: (m: TokenPlanModality) => boolean,
): ModelPlanItem[] {
  const items: ModelPlanItem[] = [];
  const llm = offered('llm') ? preset.modalities.llm : undefined;
  if (llm) {
    items.push({ capability: 'llm', model: llm.defaultModelId ?? llm.defaultModels?.[0] });
    for (const [stageId, model] of Object.entries(llm.stageRoutes ?? {})) {
      items.push({ capability: 'llm', stageId, model });
    }
  }
  for (const capability of ['image', 'video', 'tts'] as const) {
    const target = offered(capability) ? preset.modalities[capability] : undefined;
    if (target) {
      items.push({
        capability,
        model: target.defaultModelId ?? target.defaultModels?.[0],
      });
    }
  }
  // Modalities with no model concept (e.g. web search) do not disclose a model.
  for (const capability of ['asr', 'document', 'webSearch', 'webFetch'] as const) {
    if (preset.modalities[capability] && offered(capability)) items.push({ capability });
  }
  return items;
}

/** Service logo container: TokenDance uses a filled black background, others white with size-6. */
function PresetLogo({ preset, size = 'md' }: { preset: TokenPlanPreset; size?: 'md' | 'lg' }) {
  const box = size === 'lg' ? 'size-10' : 'size-8';
  if (!preset.icon) return <span className={cn(box, 'shrink-0 rounded-lg bg-muted')} />;
  return (
    <span
      className={cn(
        box,
        'flex shrink-0 items-center justify-center overflow-hidden rounded-lg border',
        preset.id === 'tokendance' ? 'border-transparent bg-black' : 'bg-background',
      )}
    >
      {}
      <img
        src={preset.icon}
        alt=""
        className={cn('object-contain', preset.id === 'tokendance' ? 'size-full' : 'size-6')}
      />
    </span>
  );
}

const pill = 'inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium';

export function TokenPlanSettings({
  view,
  apply,
}: {
  view: ModelSettingsView;
  apply: ApplyChange;
}) {
  const { t, locale } = useI18n();
  const tp = 'settings.tokenPlan';

  // The page opens on the side matching the interface language; mainland
  // plans are for the Simplified Chinese interface.
  const [region, setRegion] = useState<TokenPlanRegion>(
    locale === 'zh-CN' ? 'domestic' : 'international',
  );

  /** The plan's preset as the server offers it to the workspace (absent: the workspace cannot add it). */
  const presetOf = (preset: TokenPlanPreset) =>
    view.presets.find((entry) => entry.id === tokenPlanPresetId(preset.id));
  /** The plan's provider in the settings: connected when there is one. */
  const providerOf = (preset: TokenPlanPreset) => planProvider(view, tokenPlanPresetId(preset.id));

  // A region's plans connecting can still change something with, and the
  // ones already connected (to manage or disconnect); see tokenPlanListed.
  // Connected plans come first, in priority order (the preset order).
  const plansIn = (side: TokenPlanRegion) => {
    const listed = TOKEN_PLAN_PRESETS.filter((plan) => {
      if (!tokenPlanInRegion(plan, side)) return false;
      const preset = presetOf(plan);
      return !!preset && tokenPlanListed(view, preset);
    });
    const connected = listed.filter((plan) => !!providerOf(plan));
    return { connected, available: listed.filter((plan) => !providerOf(plan)) };
  };
  const { connected, available } = plansIn(region);
  const plans = [...connected, ...available];
  const [selectedId, setSelectedId] = useState<string>(plans[0]?.id ?? '');
  const [apiKey, setApiKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [editingKey, setEditingKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [disconnectOpen, setDisconnectOpen] = useState(false);
  /** A connect waiting for the user to choose how to treat the slots it would replace. */
  const [pending, setPending] = useState<{
    plan: TokenPlanPreset;
    key: string;
    conflicts: PlanConflict[];
  } | null>(null);
  const tabRefs = useRef(new Map<string, HTMLButtonElement>());

  const selected = plans.find((p) => p.id === selectedId) ?? plans[0] ?? null;

  // The quota of each connected plan with a key of the workspace's own (the
  // deployment's are not the workspace's to ask about).
  const quotaIds = connected
    .map(providerOf)
    .filter(
      (provider): provider is ProviderView =>
        provider?.source === 'workspace' && !!provider.key?.set,
    )
    .map((provider) => provider.id);
  const quotas = usePlanQuotas(quotaIds);

  /** A connected plan's priority among the region's connected plans. */
  const rankOf = (plan: TokenPlanPreset) => connected.indexOf(plan) + 1;

  /** How a card names a service: a connected plan with its rank, else its provider. */
  const serviceName = (providerId: string): string => {
    const provider = view.providers.find((entry) => entry.id === providerId);
    const plan = provider
      ? TOKEN_PLAN_PRESETS.find((entry) => tokenPlanPresetId(entry.id) === provider.preset)
      : undefined;
    if (!plan) return providerLabel(view, providerId, t);
    const rank = connected.includes(plan) ? ` (#${rankOf(plan)})` : '';
    // Another connection of the plan shown: say whose it is.
    const whose =
      selected && plan.id === selected.id && provider
        ? ` · ${t(provider.source === 'deployment' ? `${tp}.deploymentConnection` : `${tp}.workspaceConnection`)}`
        : '';
    return `${presetDisplayName(plan)}${rank}${whose}`;
  };

  /** The capabilities a connected plan's account lacks, as card labels. */
  const missingLabels = (provider: ProviderView | undefined) =>
    CARD_CAPABILITIES.filter(({ capability }) =>
      provider?.unsupportedCapabilities?.includes(capability),
    ).map(({ label }) => t(label));

  const selectPreset = (preset: TokenPlanPreset) => {
    setSelectedId(preset.id);
    setApiKey('');
    setEditingKey(false);
    setDisconnectOpen(false);
  };

  // Switching sides selects that side's first plan.
  const selectRegion = (side: TokenPlanRegion) => {
    if (side === region) return;
    setRegion(side);
    const { connected: first, available: rest } = plansIn(side);
    const next = first[0] ?? rest[0];
    if (next) selectPreset(next);
  };

  // Disconnect = remove the plan's provider; the stages that used it follow
  // the ones above them again.
  const disconnect = async (preset: TokenPlanPreset) => {
    const provider = providerOf(preset);
    setDisconnectOpen(false);
    setApiKey('');
    setEditingKey(false);
    if (!provider || provider.source !== 'workspace') return;
    if (reportApply(await apply({ kind: 'remove-provider', id: provider.id }, view), t)) {
      toast.success(t('settings.tokenPlan.saved'));
    }
  };

  // Connect (or save a new key): add the plan's provider, or replace its key,
  // then apply the plan's recommended configuration to the slots.
  const connect = async (plan: TokenPlanPreset, key: string, mode: PlanApplyMode) => {
    const preset = presetOf(plan);
    if (!preset) return;
    setSaving(true);
    try {
      const result = await connectTokenPlan(apply, view, preset, key, mode);
      if (result.status === 'failed') {
        toast.error(applyErrorText(result, t));
        return;
      }
      if (result.status === 'partial' && result.message) {
        toast.warning(applyErrorText({ reason: result.reason ?? '', message: result.message }, t));
      }
      // The key was saved: the quota shown must be the new key's.
      if (quotaIds.includes(result.providerId)) quotas.refresh(result.providerId, true);
      setApiKey('');
      setEditingKey(false);
      toast.success(t('settings.tokenPlan.saved'));
    } finally {
      setSaving(false);
    }
  };

  // Save = connect. When the plan's recommendation would replace models the
  // workspace picked, ask first; otherwise apply it straight away.
  const handleApply = async (key: string) => {
    const trimmedKey = key.trim();
    if (!selected || !trimmedKey) return;
    const preset = presetOf(selected);
    if (!preset) return;
    const conflicts = connectConflicts(view, preset);
    if (conflicts.length) {
      setPending({ plan: selected, key: trimmedKey, conflicts });
      return;
    }
    await connect(selected, trimmedKey, 'overwrite');
  };

  const choose = (mode: PlanApplyMode) => {
    const chosen = pending;
    setPending(null);
    if (chosen) void connect(chosen.plan, chosen.key, mode);
  };

  /** How a slot's assignment reads in the confirmation: its model (and provider), or off. */
  const assignmentLabel = (
    conflict: PlanConflict,
    ref: string | null,
    preset: PresetView | undefined,
  ): string => {
    if (ref === null) return t(`${MS}.card.off`);
    const capability = conflict.slot.capability;
    const { providerId, modelId } = splitRef(ref);
    const known = view.providers.some((provider) => provider.id === providerId);
    const provider = known ? providerLabel(view, providerId, t) : (preset?.name ?? providerId);
    if (!modelId) return provider;
    const model = known
      ? modelName(view, capability, providerId, modelId)
      : (preset?.capabilities[capability]?.models.find((entry) => entry.id === modelId)?.name ??
        modelId);
    return `${model} · ${provider}`;
  };

  const planRow = (preset: TokenPlanPreset, index: number) => {
    const provider = providerOf(preset);
    const active = selected?.id === preset.id;
    const missing = missingLabels(provider);
    return (
      <button
        type="button"
        role="tab"
        key={preset.id}
        aria-selected={active}
        tabIndex={active ? 0 : -1}
        ref={(node) => {
          if (node) tabRefs.current.set(preset.id, node);
          else tabRefs.current.delete(preset.id);
        }}
        onClick={() => selectPreset(preset)}
        onKeyDown={(event) => {
          const delta =
            event.key === 'ArrowRight' || event.key === 'ArrowDown'
              ? 1
              : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
                ? -1
                : 0;
          if (!delta && event.key !== 'Home' && event.key !== 'End') return;
          event.preventDefault();
          const next =
            plans[
              event.key === 'Home'
                ? 0
                : event.key === 'End'
                  ? plans.length - 1
                  : (index + delta + plans.length) % plans.length
            ];
          selectPreset(next);
          tabRefs.current.get(next.id)?.focus();
        }}
        className={cn(
          'flex w-full min-w-0 flex-col gap-1 rounded-lg border px-3 py-2 text-left outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-ring',
          active ? 'border-border bg-background shadow-sm' : 'border-transparent hover:bg-muted/60',
        )}
      >
        <span className="flex w-full min-w-0 items-center gap-3">
          <PresetLogo preset={preset} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium leading-5">
              {presetDisplayName(preset)}
            </span>
            <span className="flex min-w-0 items-center gap-1.5 text-xs leading-5 text-muted-foreground">
              <span
                className={cn(
                  'size-1.5 shrink-0 rounded-full',
                  provider ? 'bg-emerald-500' : 'bg-muted-foreground/40',
                )}
                aria-hidden="true"
              />
              <span className="truncate">
                {t(provider ? `${tp}.statusConnected` : `${tp}.statusNotConnected`)}
              </span>
            </span>
          </span>
          <span className="flex shrink-0 flex-col items-end text-xs leading-5">
            {provider ? (
              <>
                <span className="text-[11px] text-muted-foreground">#{rankOf(preset)}</span>
                <span className="font-medium">
                  {provider.source === 'workspace' && provider.key?.set ? (
                    <QuotaSummary entry={quotas.entries[provider.id]} />
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </span>
              </>
            ) : (
              <span className="text-muted-foreground">{t(`${tp}.setUp`)}</span>
            )}
          </span>
        </span>
        {/* The tier lacks a capability: said under the whole row, not squeezed beside the quota. */}
        {missing.length > 0 && (
          <span className="flex items-start gap-1 pl-11 text-xs leading-4 text-amber-600 dark:text-amber-400">
            <CircleAlert className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
            <span>
              {t(`${tp}.missingCapability`, { name: missing.join(t(`${tp}.listSeparator`)) })}
            </span>
          </span>
        )}
      </button>
    );
  };

  return (
    <div className="flex flex-col gap-4">
      {/* Title and the region switch: each side lists the plans its accounts can use. */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold">{t(`${tp}.title`)}</h3>
          <p className="text-xs text-muted-foreground">{t(`${tp}.subtitle`)}</p>
        </div>
        <div className="flex items-center gap-2">
          <span
            id="token-plan-region-label"
            className="flex items-center gap-1 text-xs text-muted-foreground"
          >
            <Globe className="size-3.5" aria-hidden="true" />
            {t(`${tp}.region`)}
          </span>
          <div
            className="flex gap-0.5 rounded-lg bg-muted/60 p-0.5"
            role="group"
            aria-labelledby="token-plan-region-label"
          >
            {REGIONS.map((side) => (
              <button
                key={side}
                type="button"
                aria-pressed={region === side}
                onClick={() => selectRegion(side)}
                className={cn(
                  'rounded-md px-3 py-1 text-xs font-medium outline-none transition-all focus-visible:ring-2 focus-visible:ring-ring',
                  region === side
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground/80',
                )}
              >
                {t(`settings.providerLinks.${side}`)}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="grid gap-5 lg:grid-cols-[15rem_minmax(0,1fr)]">
        {/* Plans: connected in priority order, then the ones to set up. */}
        <div
          className="flex min-w-0 flex-col gap-4 rounded-xl bg-muted/30 p-2"
          role="tablist"
          aria-label={t(`${tp}.selectPlan`)}
          aria-orientation="vertical"
        >
          {connected.length > 0 && (
            <div className="space-y-1">
              <div className="flex items-center justify-between px-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                <span>{t(`${tp}.connectedCount`, { n: connected.length })}</span>
                <span className="normal-case tracking-normal">{t(`${tp}.priorityOrder`)}</span>
              </div>
              {connected.map((plan) => planRow(plan, plans.indexOf(plan)))}
            </div>
          )}
          {available.length > 0 && (
            <div className="space-y-1">
              <div className="px-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                {t(`${tp}.availableCount`, { n: available.length })}
              </div>
              {available.map((plan) => planRow(plan, plans.indexOf(plan)))}
            </div>
          )}
          <div className="mt-auto space-y-1 border-t px-2 pt-3 text-[11px] leading-4 text-muted-foreground">
            <p>
              {t(
                region === 'domestic'
                  ? `${tp}.regionHintDomestic`
                  : `${tp}.regionHintInternational`,
              )}
            </p>
            <p>{t(`${tp}.priorityNote`)}</p>
          </div>
        </div>

        {/* 右列：服务详情（头部一行制 + 密钥表单 + 能力区块） */}
        {selected && (
          <div
            className="min-w-0 space-y-5 sm:border-l sm:border-border/60 sm:pl-6"
            role="tabpanel"
          >
            {(() => {
              const enabled = isPresetEnabled(selected);
              const provider = providerOf(selected);
              // Only the workspace's own plan can have its key updated or be disconnected.
              const own = provider?.source === 'workspace';
              const canConnect = !provider && !!presetOf(selected);
              // A tab the plan no longer offers (its key's account lacks it) falls back to the first.
              const tabs = presetModalities(selected);
              const tab = tabs.includes(activeTab) ? activeTab : (tabs[0] ?? 'llm');
              return (
                <>
                  {/* 头部一行：身份 + 状态 + 服务级动作（更新密钥 / 管理账号 / 更多） */}
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h4 className="break-words text-sm font-semibold leading-5">
                        {presetDisplayName(selected)}
                      </h4>
                      <div className="flex flex-wrap items-center gap-x-2 text-xs leading-5 text-muted-foreground">
                        <span>
                          {t(enabled ? `${tp}.statusConnected` : `${tp}.statusNotConnected`)}
                        </span>
                        {provider?.source === 'deployment' && (
                          <span>{t('settings.serverConfig.planServer')}</span>
                        )}
                        {own && provider?.key?.mask && (
                          <span className="font-mono">{provider.key.mask}</span>
                        )}
                        {own && (
                          <button
                            type="button"
                            onClick={() => {
                              setEditingKey(!editingKey);
                              setApiKey('');
                            }}
                            className="rounded-sm underline-offset-2 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                          >
                            {t(editingKey ? `${tp}.cancelKeyUpdate` : `${tp}.updateKey`)}
                          </button>
                        )}
                      </div>
                    </div>
                    <div className="ml-auto flex shrink-0 items-center gap-2">
                      {/* Balance management lives on the TokenDance portal
                          (/credits); shown only when connected, styled like
                          "Manage account". */}
                      {selected.id === 'tokendance' && enabled && selected.websiteUrl && (
                        <a
                          href={portalCreditsUrl(selected.websiteUrl)}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 rounded-sm text-xs leading-5 text-muted-foreground underline-offset-2 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          {t(`${tp}.balanceManagement`)}
                          <ExternalLink className="size-3 shrink-0" aria-hidden="true" />
                        </a>
                      )}
                      {/* 有订阅入口（如 Kimi）的套餐：「管理账号」只是分组标签
                          （纯文本），跳转交给后面的国内/海外链接；无订阅入口
                          的套餐维持「管理账号」外链。 */}
                      {selected.subscribeUrls ? (
                        <span className="text-xs leading-5 text-muted-foreground">
                          {t(`${tp}.manageAccount`)}
                        </span>
                      ) : (
                        selected.websiteUrl && (
                          <a
                            href={selected.websiteUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 rounded-sm text-xs leading-5 text-muted-foreground underline-offset-2 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                          >
                            {t(`${tp}.manageAccount`)}
                            <ExternalLink className="size-3 shrink-0" aria-hidden="true" />{' '}
                          </a>
                        )
                      )}
                      {/* 订阅入口（如 Kimi Coding Plan）：紧跟「管理账号」，
                          国内/海外双链接（aff 跟随 preset 数据）。 */}
                      {selected.subscribeUrls &&
                        (
                          [
                            ['domestic', selected.subscribeUrls.domestic],
                            ['international', selected.subscribeUrls.international],
                          ] as const
                        ).map(([region, url]) => (
                          <a
                            key={region}
                            href={url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 rounded-sm text-xs leading-5 text-muted-foreground underline-offset-2 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                          >
                            {t(`settings.providerLinks.${region}`)}
                            <ExternalLink className="size-3 shrink-0" aria-hidden="true" />
                          </a>
                        ))}
                      {own && (
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="size-8"
                              aria-label={t(`${tp}.disconnect`)}
                            >
                              <MoreHorizontal className="size-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onSelect={() => setDisconnectOpen(true)}>
                              <Unlink className="size-4" />
                              {t(`${tp}.disconnect`)}
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      )}
                    </div>
                  </div>

                  {/* 密钥表单：未连接或更新密钥时显示；保存即连接 */}
                  {!enabled && !canConnect && <ServerOnlyNotice noUserKeys={!view.allowUserKeys} />}
                  {(canConnect || (own && editingKey)) && (
                    <form
                      className="space-y-2"
                      onSubmit={(event) => {
                        event.preventDefault();
                        void handleApply(apiKey);
                      }}
                    >
                      {/* Field and its commit share one row; the button never owns a line. */}
                      <div className="flex flex-wrap items-center gap-2">
                        <div className="relative min-w-0 flex-1 basis-40">
                          <Input
                            type={showKey ? 'text' : 'password'}
                            autoComplete="new-password"
                            spellCheck={false}
                            aria-label={t(`${tp}.apiKey`)}
                            placeholder={selected.apiKeyPlaceholder ?? 'sk-...'}
                            value={apiKey}
                            onChange={(e) => setApiKey(e.target.value)}
                            className="h-8 pr-8"
                          />
                          <button
                            type="button"
                            onClick={() => setShowKey(!showKey)}
                            aria-label={t(`${tp}.apiKey`)}
                            className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                          >
                            {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                          </button>
                        </div>
                        <Button
                          type="submit"
                          size="sm"
                          className="ml-auto shrink-0"
                          disabled={!apiKey.trim() || saving}
                        >
                          {t(editingKey ? `${tp}.updateKey` : `${tp}.saveKey`)}
                        </Button>
                      </div>
                      <CredentialStorageHint />
                      <p className="text-xs leading-5 text-muted-foreground">
                        {t(`${tp}.applyModelsNote`)}
                      </p>
                    </form>
                  )}

                  {/* View model plan: a capability · stage → plan default model
                      table; modalities with no model concept show "not disclosed". */}
                  <details className="group border-t border-border/60 pt-4">
                    <summary className="flex cursor-pointer list-none items-center justify-between gap-2 rounded-sm text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring">
                      {t(`${tp}.modelPlan`)}
                      <ChevronDown className="size-4 shrink-0 transition-transform motion-reduce:transition-none group-open:rotate-180" />
                    </summary>
                    <div className="mt-2 space-y-2 text-xs leading-5 text-muted-foreground">
                      <p>{t(`${tp}.planNoteEntitlement`)}</p>
                      <p>{t(`${tp}.planNoteEditable`)}</p>
                    </div>
                    <dl className="mt-2 space-y-2 text-xs leading-5">
                      {modelPlanItems(selected, offeredBy(selected)).map((item) => (
                        <div
                          key={`${item.capability}:${item.stageId ?? ''}`}
                          className="flex justify-between gap-4"
                        >
                          <dt className="text-muted-foreground">
                            {t(MODEL_PLAN_CAPABILITY_LABEL_KEYS[item.capability])}
                            {item.stageId
                              ? ` · ${
                                  MODEL_PLAN_STAGE_LABEL_KEYS[item.stageId]
                                    ? t(MODEL_PLAN_STAGE_LABEL_KEYS[item.stageId])
                                    : item.stageId
                                }`
                              : ''}
                          </dt>
                          <dd className="break-all text-right font-mono">
                            {item.model ?? t(`${tp}.planUnavailable`)}
                          </dd>
                        </div>
                      ))}
                    </dl>
                  </details>

                  {provider && own && provider.key?.set && (
                    <PlanQuota key={`${provider.id}:${keySaves}`} providerId={provider.id} />
                  )}

                  {/* Capabilities: a display-only tab list of the models the plan
                      offers per modality — less what the account behind a
                      connected key lacks. Selection and enable/disable happen
                      on the generation bar. */}
                  <div className="space-y-3">
                    <div className="text-sm font-medium">{t(`${tp}.capabilities`)}</div>

                    {/* Tab bar (segmented control) */}
                    <div className="flex gap-0.5 rounded-lg bg-muted/60 p-0.5">
                      {tabs.map((m) => {
                        const Icon = MODALITY_ICONS[m];
                        const isActive = tab === m;
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
                      const models = modalityModels(selected, tab);
                      return (
                        <div className="space-y-2 rounded-md border p-3">
                          <div className="flex items-center justify-between gap-3 text-xs">
                            <span className="font-medium">{t(MODALITY_LABEL_KEYS[tab])}</span>
                            <span className="text-muted-foreground">
                              {t(`${tp}.modelsCount`, { n: models.length })}
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
                      {t(`${tp}.offeredNote`)}
                    </p>
                  </div>

                  {/* This deployment's usage, every service together (the
                      usage log does not tell plans or workspaces apart). */}
                  {enabled && <DeploymentUsage />}
                </>
              );
            })()}
          </div>
        )}
      </div>

      {/* Connecting would replace models the workspace picked: ask first. */}
      {pending && (
        <AlertDialog
          open
          onOpenChange={(open) => {
            if (!open) setPending(null);
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{t(`${tp}.applyTitle`)}</AlertDialogTitle>
              <AlertDialogDescription>
                {t(`${tp}.applyBody`, { name: presetDisplayName(pending.plan) })}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <ul className="max-h-60 space-y-1.5 overflow-y-auto text-xs leading-5">
              {pending.conflicts.map((conflict) => {
                const preset = presetOf(pending.plan);
                const current =
                  conflict.current === null
                    ? null
                    : typeof conflict.current === 'string'
                      ? conflict.current
                      : conflict.current.model;
                return (
                  <li key={conflict.slot.slot} className="flex flex-wrap items-baseline gap-x-2">
                    <span className="font-medium">{slotName(t, conflict.slot.slot)}</span>
                    <span className="min-w-0 break-all text-muted-foreground">
                      {assignmentLabel(conflict, current, preset)}
                      {conflict.from === 'default' && ` (${t(`${MS}.source.default`)})`}
                      {' → '}
                      <span className="text-foreground">
                        {assignmentLabel(conflict, conflict.recommended, preset)}
                      </span>
                    </span>
                  </li>
                );
              })}
            </ul>
            <AlertDialogFooter>
              <AlertDialogAction variant="outline" onClick={() => choose('keep')}>
                {t(`${tp}.applyKeep`)}
              </AlertDialogAction>
              <AlertDialogAction onClick={() => choose('overwrite')}>
                {t(`${tp}.applyRecommended`)}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}

      {/* 解除连接确认 */}
      {selected && (
        <AlertDialog open={disconnectOpen} onOpenChange={setDisconnectOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{t(`${tp}.disconnectTitle`)}</AlertDialogTitle>
              <AlertDialogDescription>{t(`${tp}.disconnectBody`)}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
              <AlertDialogAction onClick={() => void disconnect(selected)}>
                {t(`${tp}.disconnect`)}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </div>
  );
}
