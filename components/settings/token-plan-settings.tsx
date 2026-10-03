'use client';

// The "Token Plan" section: a two-column panel with a service tablist on the
// left (logo, display-name mapping, status row, keyboard navigation) and a
// one-line header on the right (status / update key / manage-account link / ⋯
// menu disconnect). A plan is a provider of the workspace's model settings on
// the server: saving its key adds that provider (or replaces its key) and
// applies the plan's recommended configuration to the slots. When that would
// replace models the workspace picked, the user is asked first: the plan's
// setup, or keep theirs and fill only the empty slots. Disconnecting removes
// the provider. A plan the server configures is shown as connected, read-only.

import { useState, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Eye,
  EyeOff,
  Check,
  ChevronDown,
  ExternalLink,
  MoreHorizontal,
  Unlink,
  MessageSquare,
  Image as ImageIcon,
  Video,
  Volume2,
  Search,
  type LucideIcon,
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
  type TokenPlanPreset,
  type TokenPlanModality,
} from '@/lib/config/token-plan-presets';
import { tokenPlanPresetId } from '@/lib/config/preset-ids';
import type { ApplyChange, ModelSettingsView, PresetView } from '@/lib/model-settings/client';
import { modelName, providerLabel, splitRef } from '@/lib/model-settings/edit';
import { planProvider } from '@/lib/model-settings/services';
import { tokenPlanCanChange } from '@/lib/model-settings/shape';
import {
  connectConflicts,
  connectTokenPlan,
  type PlanApplyMode,
  type PlanConflict,
} from '@/lib/model-settings/token-plan';
import { applyErrorText, reportApply, ServerOnlyNotice } from './server-settings';
import { MS, slotName } from './models/slot-meta';

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

/** 「查看模型方案」行：能力（· 环节）→ 套餐默认模型；无模型概念的模态不披露。 */
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
  webSearch: 'settings.tokenPlan.capWebSearch',
};

function modelPlanItems(preset: TokenPlanPreset): ModelPlanItem[] {
  const items: ModelPlanItem[] = [];
  const llm = preset.modalities.llm;
  if (llm) {
    items.push({ capability: 'llm', model: llm.defaultModelId ?? llm.defaultModels?.[0] });
    for (const [stageId, model] of Object.entries(llm.stageRoutes ?? {})) {
      items.push({ capability: 'llm', stageId, model });
    }
  }
  for (const capability of ['image', 'video', 'tts'] as const) {
    const target = preset.modalities[capability];
    if (target) {
      items.push({
        capability,
        model: target.defaultModelId ?? target.defaultModels?.[0],
      });
    }
  }
  // Modalities with no model concept (e.g. web search) do not disclose a model.
  if (preset.modalities.webSearch) items.push({ capability: 'webSearch' });
  return items;
}

/** Service logo container: TokenDance uses a filled black background, others white with size-6. */
function PresetLogo({ preset }: { preset: TokenPlanPreset }) {
  if (!preset.icon) return <span className="size-8 shrink-0 rounded-lg bg-muted" />;
  return (
    <span
      className={cn(
        'flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-lg',
        preset.id === 'tokendance' ? 'bg-black' : 'bg-background',
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

/** The models a preset declares for one modality (display-only, no probing). */
function modalityModels(preset: TokenPlanPreset, m: TokenPlanModality): string[] {
  const target = preset.modalities[m];
  if (!target) return [];
  if (target.defaultModels?.length) return target.defaultModels;
  if (target.defaultModelId) return [target.defaultModelId];
  return [target.providerId];
}

export function TokenPlanSettings({
  view,
  apply,
}: {
  view: ModelSettingsView;
  apply: ApplyChange;
}) {
  const { t } = useI18n();

  // Only the plans whose connecting can still fill a slot (see tokenPlanCanChange).
  const plans = TOKEN_PLAN_PRESETS.filter((plan) => {
    const preset = view.presets.find((entry) => entry.id === tokenPlanPresetId(plan.id));
    return !!preset && tokenPlanCanChange(view, preset);
  });
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
  const [activeTab, setActiveTab] = useState<TokenPlanModality>('llm');
  const tabRefs = useRef(new Map<string, HTMLButtonElement>());

  const selected = plans.find((p) => p.id === selectedId) ?? plans[0] ?? null;

  /** The plan's preset as the server offers it to the workspace (absent: the workspace cannot add it). */
  const presetOf = (preset: TokenPlanPreset) =>
    view.presets.find((entry) => entry.id === tokenPlanPresetId(preset.id));
  /** The plan's provider in the workspace's settings: connected when there is one. */
  const providerOf = (preset: TokenPlanPreset) => planProvider(view, tokenPlanPresetId(preset.id));
  const isPresetEnabled = (preset: TokenPlanPreset): boolean => !!providerOf(preset);

  // The modalities a preset declares, in display order — drives the tab bar.
  const presetModalities = (preset: TokenPlanPreset): TokenPlanModality[] =>
    MODALITY_ORDER.filter((m) => preset.modalities[m]);

  const selectPreset = (preset: TokenPlanPreset) => {
    setSelectedId(preset.id);
    setActiveTab(presetModalities(preset)[0] ?? 'llm');
    setApiKey('');
    setEditingKey(false);
    setDisconnectOpen(false);
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
    const provider = known ? providerLabel(view, providerId) : (preset?.name ?? providerId);
    if (!modelId) return provider;
    const model = known
      ? modelName(view, capability, providerId, modelId)
      : (preset?.capabilities[capability]?.models.find((entry) => entry.id === modelId)?.name ??
        modelId);
    return `${model} · ${provider}`;
  };

  const tp = 'settings.tokenPlan';

  return (
    <div className="flex max-w-4xl flex-col gap-6">
      <div>
        <h3 className="text-sm font-semibold mb-1">{t(`${tp}.title`)}</h3>
        <p className="text-xs text-muted-foreground">{t(`${tp}.desc`)}</p>
      </div>

      {/* 1:2 比例分割：服务商列表不需要太宽，右侧密钥/能力详情是主体 */}
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
        {/* Left column: service tablist (collapses to a 3-column grid on small screens) */}
        <div
          className="grid grid-cols-3 content-start gap-1 rounded-xl bg-muted/40 p-1 sm:grid-cols-1 sm:gap-1 sm:bg-transparent sm:p-0"
          role="tablist"
          aria-label={t(`${tp}.selectPlan`)}
        >
          {plans.map((preset, index) => {
            const enabled = isPresetEnabled(preset);
            const active = selected?.id === preset.id;
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
                  'flex min-w-0 flex-col items-center gap-2 rounded-lg px-2 py-3 text-center outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 sm:flex-row sm:gap-3 sm:px-3 sm:py-2 sm:text-left',
                  active
                    ? 'bg-background text-foreground shadow-sm sm:bg-accent/70 sm:shadow-none'
                    : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
                )}
              >
                <PresetLogo preset={preset} />
                <span className="min-w-0">
                  <span className="block break-words text-sm font-medium leading-5">
                    {presetDisplayName(preset)}
                  </span>
                  <span className="flex items-center justify-center gap-1 text-xs leading-5 text-muted-foreground sm:justify-start">
                    {enabled && <Check className="size-3 shrink-0" />}
                    {t(enabled ? `${tp}.statusConnected` : `${tp}.statusNotConnected`)}
                  </span>
                </span>
              </button>
            );
          })}
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
                      <p className="text-xs leading-5 text-muted-foreground">
                        {t(`${tp}.keyStorage`)}
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
                      {modelPlanItems(selected).map((item) => (
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

                  {/* Capabilities: a display-only tab list of the models the plan
                      offers per modality. No status, no probing — selection and
                      enable/disable happen on the generation bar. */}
                  <div className="space-y-3">
                    <div className="text-sm font-medium">{t(`${tp}.capabilities`)}</div>

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
