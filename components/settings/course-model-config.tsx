'use client';

// 「课程模型配置」分区：把课程生成管线画成流程图（卡片站点 + 自绘 SVG 轨道），
// 每个环节显示实际使用的模型。LLM 环节默认「跟随主线」（settings store 的
// providerId/modelId），单独指定写入用户级 stage 路由（llmStageRoutes，经
// x-model-routes 头下发，服务端优先级低于 operator MODEL_ROUTES）；媒体环节
// 直接读写各模态的真实开关与 provider/model 字段。

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  CornerDownRight,
  Eye,
  FileStack,
  Images,
  Info,
  ListTree,
  MessageSquareText,
  MessagesSquare,
  Presentation,
  Search,
  Users,
  Volume2,
  X,
} from 'lucide-react';
import { Switch } from '@/components/ui/switch';
import { toast } from 'sonner';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useSettingsStore } from '@/lib/store/settings';
import { findModelById } from '@/lib/ai/model-aliases';
import { getThinkingConfigKey } from '@/lib/ai/thinking-config';
import type { ProviderId } from '@/lib/ai/providers';
import type { ThinkingConfig } from '@/lib/types/provider';
import { PDF_PROVIDERS } from '@/lib/pdf/constants';
import type { PDFProviderId } from '@/lib/pdf/types';
import { ASR_PROVIDERS, TTS_PROVIDERS } from '@/lib/audio/constants';
import type {
  ASRProviderId,
  BuiltInASRProviderId,
  BuiltInTTSProviderId,
  TTSProviderId,
} from '@/lib/audio/types';
import { IMAGE_PROVIDERS } from '@/lib/media/image-providers';
import { VIDEO_PROVIDERS } from '@/lib/media/video-providers';
import {
  IMAGE_PROVIDER_NAMES,
  VIDEO_PROVIDER_NAMES,
} from '@/components/settings/media-provider-names';
import {
  WEB_SEARCH_PROVIDERS,
  getWebSearchProviderDisplayName,
  isWebSearchProviderConfigured,
} from '@/lib/web-search/constants';
import type { WebSearchProviderId } from '@/lib/web-search/types';
import { ModelPicker, type ModelPickerGroup } from './model-picker';
import { useLLMPickerGroups } from './use-llm-picker-groups';
import { STATION_STAGE_KEYS } from '@/lib/config/station-stage-keys';

// ── 设计稿坐标系（固定蛇形布局，整体按容器缩放） ──────────────
const DESIGN_W = 835;
const DESIGN_H = 398;
const CARD_W = 190;
const CARD_MIN_H = 72;
const CANVAS_PAD = 28;

const STATION_POS: Record<string, { x: number; y: number }> = {
  'doc-parse': { x: 215, y: 0 },
  'web-research': { x: 430, y: 0 },
  outline: { x: 645, y: 0 },
  agents: { x: 645, y: 150 },
  'scene-content': { x: 430, y: 150 },
  'scene-actions': { x: 215, y: 150 },
  tts: { x: 0, y: 150 },
  interaction: { x: 0, y: 300 },
  media: { x: 215, y: 300 },
};

const RAILS: Array<{ pts: Array<[number, number]>; dashed?: boolean }> = [
  // First row: document parsing → web research → outline planning
  {
    pts: [
      [405, 36],
      [430, 36],
    ],
  },
  {
    pts: [
      [620, 36],
      [645, 36],
    ],
  },
  // 大纲规划 ↓ 角色生成（第二行从右往左）
  {
    pts: [
      [740, 72],
      [740, 150],
    ],
  },
  // 第二行：角色生成 → 场景内容 → 场景动作 → 语音合成
  {
    pts: [
      [645, 186],
      [620, 186],
    ],
  },
  {
    pts: [
      [430, 186],
      [405, 186],
    ],
  },
  {
    pts: [
      [215, 186],
      [190, 186],
    ],
  },
  // 语音合成 ↓ 课堂互动
  {
    pts: [
      [95, 222],
      [95, 300],
    ],
  },
  // 场景内容 ⇢ 媒体生成（并行，虚线）
  {
    pts: [
      [525, 222],
      [525, 260],
      [310, 260],
      [310, 300],
    ],
    dashed: true,
  },
  // 媒体生成 → 课堂互动
  {
    pts: [
      [215, 336],
      [190, 336],
    ],
  },
];

/** 内置 TTS/ASR 注册表只覆盖 built-in id（custom-** 不在其中），安全取值 */
function ttsBuiltIn(id: string) {
  return TTS_PROVIDERS[id as BuiltInTTSProviderId];
}
function asrBuiltIn(id: string) {
  return ASR_PROVIDERS[id as BuiltInASRProviderId];
}

/** 圆角折线 path：每个中间点用二次曲线切角 */
function roundedPath(pts: Array<[number, number]>, r = 16): string {
  if (pts.length < 2) return '';
  let d = `M ${pts[0][0]} ${pts[0][1]}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const [px, py] = pts[i - 1];
    const [cx, cy] = pts[i];
    const [nx, ny] = pts[i + 1];
    const d1 = Math.hypot(cx - px, cy - py) || 1;
    const d2 = Math.hypot(nx - cx, ny - cy) || 1;
    const r1 = Math.min(r, d1 / 2);
    const r2 = Math.min(r, d2 / 2);
    const p1: [number, number] = [cx - ((cx - px) / d1) * r1, cy - ((cy - py) / d1) * r1];
    const p2: [number, number] = [cx + ((nx - cx) / d2) * r2, cy + ((ny - cy) / d2) * r2];
    d += ` L ${p1[0]} ${p1[1]} Q ${cx} ${cy} ${p2[0]} ${p2[1]}`;
  }
  const last = pts[pts.length - 1];
  d += ` L ${last[0]} ${last[1]}`;
  return d;
}

// ── 管线站点定义 ────────────────────────────────────────────
interface StationDef {
  id: keyof typeof STATION_POS & string;
  labelKey: string;
  kind: 'llm' | 'media';
  /**
   * 该站点控制的运行时 stage 键（契约见 lib/config/station-stage-keys.ts）。
   * 多键站点（课堂互动）覆盖时整组一起写、跟随时整组一起清；展示与读取
   * 用第一個键作主键。
   */
  stages?: readonly string[];
  subSlots?: Array<{ key: string; labelKey: string }>;
  vision?: boolean;
  tag?: 'loop' | 'parallel';
}

const STATIONS: StationDef[] = [
  {
    id: 'doc-parse',
    labelKey: 'settings.courseModels.stations.docParse',
    kind: 'media',
  },
  {
    id: 'web-research',
    labelKey: 'settings.courseModels.stations.webResearch',
    kind: 'llm',
    stages: STATION_STAGE_KEYS['web-research'],
  },
  {
    id: 'outline',
    labelKey: 'settings.courseModels.stations.outline',
    kind: 'llm',
    stages: STATION_STAGE_KEYS.outline,
    vision: true,
  },
  {
    id: 'agents',
    labelKey: 'settings.courseModels.stations.agents',
    kind: 'llm',
    stages: STATION_STAGE_KEYS.agents,
  },
  {
    id: 'scene-content',
    labelKey: 'settings.courseModels.stations.sceneContent',
    kind: 'llm',
    stages: STATION_STAGE_KEYS['scene-content'],
    vision: true,
    tag: 'loop',
    subSlots: [
      { key: 'scene-content:slide', labelKey: 'settings.courseModels.subStages.slide' },
      { key: 'scene-content:quiz', labelKey: 'settings.courseModels.subStages.quiz' },
      { key: 'scene-content:interactive', labelKey: 'settings.courseModels.subStages.interactive' },
      { key: 'scene-content:pbl', labelKey: 'settings.courseModels.subStages.pbl' },
    ],
  },
  {
    id: 'scene-actions',
    labelKey: 'settings.courseModels.stations.sceneActions',
    kind: 'llm',
    stages: STATION_STAGE_KEYS['scene-actions'],
    tag: 'loop',
  },
  {
    id: 'tts',
    labelKey: 'settings.courseModels.stations.tts',
    kind: 'media',
    tag: 'loop',
  },
  {
    id: 'media',
    labelKey: 'settings.courseModels.stations.media',
    kind: 'media',
    tag: 'parallel',
  },
  {
    id: 'interaction',
    labelKey: 'settings.courseModels.stations.interaction',
    kind: 'llm',
    // 一个旋钮控制整组运行时 stage：对话/测验批分/PBL 运行时（含复合子键
    // 的父级回溯）。不再细分展示，统一跟随本环节的模型配置。
    stages: STATION_STAGE_KEYS.interaction,
  },
];

const STATION_ICONS: Record<string, typeof FileStack> = {
  'doc-parse': FileStack,
  'web-research': Search,
  outline: ListTree,
  agents: Users,
  'scene-content': Presentation,
  'scene-actions': MessageSquareText,
  tts: Volume2,
  media: Images,
  interaction: MessagesSquare,
};

// ── 站点卡片 ────────────────────────────────────────────────
function Station({
  def,
  label,
  following,
  overrideName,
  resolvedName,
  mediaLines,
  allOff,
  selected,
  onSelect,
  t,
}: {
  def: StationDef;
  label: string;
  following: boolean;
  overrideName?: string;
  resolvedName?: string;
  mediaLines: string[];
  allOff: boolean;
  selected: boolean;
  onSelect: () => void;
  t: (key: string) => string;
}) {
  const Icon = STATION_ICONS[def.id];
  const pos = STATION_POS[def.id];
  const lit = def.kind === 'llm' ? true : mediaLines.length > 0;
  const dim = def.kind === 'media' && allOff;

  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        onSelect();
      }}
      aria-pressed={selected}
      className={cn(
        'absolute cursor-pointer rounded-xl border bg-card px-3 py-2.5 text-left shadow-xs transition-colors duration-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary',
        lit &&
          !dim &&
          'border-violet-200/70 bg-violet-50/40 dark:border-violet-800/50 dark:bg-violet-950/20',
        !lit && !dim && 'border-border/70 hover:border-primary/40',
        dim && 'border-dashed border-border/60 opacity-60',
        selected && 'border-primary/50 ring-2 ring-primary/60 ring-offset-2 ring-offset-background',
      )}
      style={{ left: pos.x, top: pos.y, width: CARD_W, minHeight: CARD_MIN_H }}
    >
      <div className="flex items-center gap-2">
        <span
          className={cn(
            'flex size-7 shrink-0 items-center justify-center rounded-lg transition-colors duration-200',
            lit && !dim ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground/50',
          )}
        >
          <Icon className="size-3.5" />
        </span>
        <span className="min-w-0 flex-1 truncate text-xs font-medium leading-none">{label}</span>
        {def.vision && (
          <Eye
            className="size-3 shrink-0 text-muted-foreground/45"
            aria-label={t('settings.courseModels.visionSupported')}
          />
        )}
        {def.tag && (
          <span className="shrink-0 rounded-full border border-border/70 px-1.5 py-px text-[9px] leading-tight text-muted-foreground">
            {def.tag === 'loop'
              ? t('settings.courseModels.loop')
              : t('settings.courseModels.parallel')}
          </span>
        )}
      </div>

      {/* 模型行：LLM 行（跟随/独立）与服务行可叠加 */}
      <div className="mt-1.5 flex min-h-4 flex-col gap-0.5">
        {dim ? (
          <span className="text-[10px] leading-none text-muted-foreground">
            {t('settings.courseModels.stopped')}
          </span>
        ) : (
          <>
            {def.stages &&
              (following ? (
                <span className="flex items-center gap-1 text-[10px] leading-none">
                  <CornerDownRight className="size-3 shrink-0 text-primary" />
                  <span className="shrink-0 text-muted-foreground">
                    {t('settings.courseModels.followMainline')}：
                  </span>
                  <span className="truncate font-mono text-foreground/80" title={resolvedName}>
                    {resolvedName}
                  </span>
                </span>
              ) : (
                <span className="flex items-center gap-1.5 text-[10px] leading-none">
                  <span className="size-1.5 shrink-0 rounded-full bg-violet-500" />
                  <span
                    className="truncate font-mono font-medium text-violet-600 dark:text-violet-300"
                    title={overrideName}
                  >
                    {overrideName}
                  </span>
                </span>
              ))}
            {mediaLines.map((line) => (
              <span
                key={line}
                className="max-w-full truncate font-mono text-[10px] leading-none text-foreground/75"
                title={line}
              >
                {line}
              </span>
            ))}
          </>
        )}
      </div>
    </button>
  );
}

// ── 主面板 ──────────────────────────────────────────────────
export function CourseModelConfigPanel({}) {
  const { t } = useI18n();

  // ── 主线模型 & LLM 路由 ──
  const providerId = useSettingsStore((s) => s.providerId);
  const modelId = useSettingsStore((s) => s.modelId);
  const providersConfig = useSettingsStore((s) => s.providersConfig);
  const setModel = useSettingsStore((s) => s.setModel);
  const thinkingConfigs = useSettingsStore((s) => s.thinkingConfigs);
  const setThinkingConfig = useSettingsStore((s) => s.setThinkingConfig);
  const llmStageRoutes = useSettingsStore((s) => s.llmStageRoutes);
  const setStageRoute = useSettingsStore((s) => s.setStageRoute);

  // ── 媒体模态 ──
  const webSearchEnabled = useSettingsStore((s) => s.webSearchEnabled);
  const setWebSearchEnabled = useSettingsStore((s) => s.setWebSearchEnabled);
  const webSearchProviderId = useSettingsStore((s) => s.webSearchProviderId);
  const webSearchProvidersConfig = useSettingsStore((s) => s.webSearchProvidersConfig);
  const setWebSearchProvider = useSettingsStore((s) => s.setWebSearchProvider);

  const ttsEnabled = useSettingsStore((s) => s.ttsEnabled);
  const setTTSEnabled = useSettingsStore((s) => s.setTTSEnabled);
  const ttsProviderId = useSettingsStore((s) => s.ttsProviderId);
  const ttsProvidersConfig = useSettingsStore((s) => s.ttsProvidersConfig);
  const setTTSProvider = useSettingsStore((s) => s.setTTSProvider);
  const setTTSProviderConfig = useSettingsStore((s) => s.setTTSProviderConfig);

  const asrEnabled = useSettingsStore((s) => s.asrEnabled);
  const setASREnabled = useSettingsStore((s) => s.setASREnabled);
  const asrProviderId = useSettingsStore((s) => s.asrProviderId);
  const asrProvidersConfig = useSettingsStore((s) => s.asrProvidersConfig);
  const setASRProvider = useSettingsStore((s) => s.setASRProvider);
  const setASRProviderConfig = useSettingsStore((s) => s.setASRProviderConfig);

  const pdfProviderId = useSettingsStore((s) => s.pdfProviderId);
  const pdfProvidersConfig = useSettingsStore((s) => s.pdfProvidersConfig);
  const setPDFProvider = useSettingsStore((s) => s.setPDFProvider);

  const imageGenerationEnabled = useSettingsStore((s) => s.imageGenerationEnabled);
  const setImageGenerationEnabled = useSettingsStore((s) => s.setImageGenerationEnabled);
  const imageProviderId = useSettingsStore((s) => s.imageProviderId);
  const imageModelId = useSettingsStore((s) => s.imageModelId);
  const imageProvidersConfig = useSettingsStore((s) => s.imageProvidersConfig);
  const setImageProvider = useSettingsStore((s) => s.setImageProvider);
  const setImageModelId = useSettingsStore((s) => s.setImageModelId);

  const videoGenerationEnabled = useSettingsStore((s) => s.videoGenerationEnabled);
  const setVideoGenerationEnabled = useSettingsStore((s) => s.setVideoGenerationEnabled);
  const videoProviderId = useSettingsStore((s) => s.videoProviderId);
  const videoModelId = useSettingsStore((s) => s.videoModelId);
  const videoProvidersConfig = useSettingsStore((s) => s.videoProvidersConfig);
  const setVideoProvider = useSettingsStore((s) => s.setVideoProvider);
  const setVideoModelId = useSettingsStore((s) => s.setVideoModelId);

  const [selected, setSelected] = useState<string | null>(null);
  const selectedDef = STATIONS.find((s) => s.id === selected) ?? null;

  // ── 可用 LLM 选项与模型组（过滤/套餐置顶/推荐序的口径与首页工具栏共享） ──
  const { groups: llmPickerGroups, providers: llmProviders } = useLLMPickerGroups();

  const mainThinkingConfig = thinkingConfigs[getThinkingConfigKey(providerId, modelId)];

  const mainModelName = useMemo(() => {
    const provider = llmProviders.find((p) => p.id === providerId);
    const resolved = findModelById(
      providerId,
      provider?.models ?? providersConfig?.[providerId]?.models,
      modelId,
    )?.name;
    // 主线空（唯一 provider 被禁用等）时给占位文案，「跟随主线：」后不再空白。
    if (!resolved && !modelId) return t('settings.courseModels.mainlineUnset');
    return resolved ?? modelId;
  }, [llmProviders, providersConfig, providerId, modelId, t]);

  const stageOverrideName = (stage: string) => {
    const route = llmStageRoutes[stage];
    if (!route) return undefined;
    const provider = providersConfig?.[route.providerId];
    return findModelById(route.providerId, provider?.models, route.modelId)?.name ?? route.modelId;
  };

  // ── 媒体展示辅助 ──
  const pdfProvider = PDF_PROVIDERS[pdfProviderId];
  const webSearchDisplayName = webSearchProviderId
    ? getWebSearchProviderDisplayName(webSearchProviderId, t)
    : '';

  const ttsModels = useMemo(() => {
    const config = ttsProvidersConfig[ttsProviderId];
    const builtIn = ttsBuiltIn(ttsProviderId);
    const custom = config?.customModels ?? [];
    return builtIn ? [...builtIn.models, ...custom] : custom;
  }, [ttsProvidersConfig, ttsProviderId]);
  const ttsModelName = useMemo(() => {
    const config = ttsProvidersConfig[ttsProviderId];
    const id = config?.modelId || ttsBuiltIn(ttsProviderId)?.defaultModelId || '';
    return ttsModels.find((m) => m.id === id)?.name ?? id;
  }, [ttsProvidersConfig, ttsProviderId, ttsModels]);

  const asrModelName = useMemo(() => {
    const config = asrProvidersConfig[asrProviderId];
    const builtIn = asrBuiltIn(asrProviderId);
    const models = builtIn
      ? [...builtIn.models, ...(config?.customModels ?? [])]
      : (config?.customModels ?? []);
    const id = config?.modelId || builtIn?.defaultModelId || '';
    return models.find((m) => m.id === id)?.name ?? id;
  }, [asrProvidersConfig, asrProviderId]);

  const imageModelName = useMemo(() => {
    const builtIn = IMAGE_PROVIDERS[imageProviderId];
    const config = imageProvidersConfig[imageProviderId];
    const models = config?.replaceBuiltInModels
      ? (config.customModels ?? [])
      : [...(builtIn?.models ?? []), ...(config?.customModels ?? [])];
    return models.find((m) => m.id === imageModelId)?.name ?? imageModelId;
  }, [imageProvidersConfig, imageProviderId, imageModelId]);

  // 与 store 的开启守卫同口径（API Key / 服务端配置 + 授权开关，Token Plan
  // 播种亦走 apiKey）：媒体生成节点开启图像/视频前用于提示，避免「点了没反应」。
  const hasUsableImageProvider = Object.values(imageProvidersConfig ?? {}).some(
    (c) => (c.isServerConfigured || c.apiKey) && c.enabled !== false,
  );
  const hasUsableVideoProvider = Object.values(videoProvidersConfig ?? {}).some(
    (c) => (c.isServerConfigured || c.apiKey) && c.enabled !== false,
  );

  const videoModelName = useMemo(() => {
    const builtIn = VIDEO_PROVIDERS[videoProviderId];
    const config = videoProvidersConfig[videoProviderId];
    const models = config?.replaceBuiltInModels
      ? (config.customModels ?? [])
      : [...(builtIn?.models ?? []), ...(config?.customModels ?? [])];
    return models.find((m) => m.id === videoModelId)?.name ?? videoModelId;
  }, [videoProvidersConfig, videoProviderId, videoModelId]);

  // ── 站点状态 ──
  const stationState = (def: StationDef) => {
    switch (def.id) {
      case 'doc-parse':
        return {
          following: true,
          mediaLines: [pdfProvider?.name ?? pdfProviderId, asrEnabled ? asrModelName : null].filter(
            (v): v is string => !!v,
          ),
          allOff: false,
        };
      case 'web-research':
        return {
          following: !llmStageRoutes['web-search-query-rewrite'],
          mediaLines: webSearchEnabled ? [webSearchDisplayName] : [],
          allOff: !webSearchEnabled,
        };
      case 'tts':
        return {
          following: true,
          mediaLines: ttsEnabled ? [ttsModelName] : [],
          allOff: !ttsEnabled,
        };
      case 'media': {
        const lines = [
          imageGenerationEnabled ? imageModelName : null,
          videoGenerationEnabled ? videoModelName : null,
        ].filter((v): v is string => !!v);
        return { following: true, mediaLines: lines, allOff: lines.length === 0 };
      }
      default: {
        // 多键站点（课堂互动）整组一起写，读主键即可判断跟随/覆盖态。
        const stage = def.stages?.[0];
        const route = stage ? llmStageRoutes[stage] : undefined;
        return { following: !route, mediaLines: [], allOff: false };
      }
    }
  };

  // ── 画布缩放 ──
  const wrapRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const update = () =>
      setScale(
        Math.max(
          0.3,
          Math.min(
            1.15,
            (el.clientWidth - CANVAS_PAD * 2) / DESIGN_W,
            (el.clientHeight - CANVAS_PAD * 2) / DESIGN_H,
          ),
        ),
      );
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const cm = 'settings.courseModels';

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      {/* 主线模型条 */}
      <div className="flex shrink-0 items-center gap-3 px-1">
        <span className="shrink-0 text-xs font-medium">{t(`${cm}.mainModel`)}</span>
        <div className="w-56 shrink-0">
          {llmProviders.length > 0 ? (
            <ModelPicker
              groups={llmPickerGroups}
              value={{ providerId, modelId }}
              onSelect={(pid, mid) => setModel(pid as ProviderId, mid)}
              thinkingConfig={mainThinkingConfig}
              onThinkingChange={(config) => setThinkingConfig(providerId, modelId, config)}
              placeholder={t(`${cm}.noProviderHint`)}
              size="md"
              t={t}
            />
          ) : (
            <span className="text-[11px] text-muted-foreground">{t(`${cm}.noProviderHint`)}</span>
          )}
        </div>
        <p className="hidden min-w-0 flex-1 text-[11px] leading-snug text-muted-foreground lg:block">
          {t(`${cm}.mainModelHint`)}
        </p>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              aria-label={t(`${cm}.mainModel`)}
              className="ml-auto shrink-0 rounded-full p-1 text-muted-foreground/60 transition-colors hover:bg-muted hover:text-foreground"
            >
              <Info className="size-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="max-w-64 text-xs leading-relaxed">
            {t(`${cm}.mainModelTooltip`)}
          </TooltipContent>
        </Tooltip>
      </div>

      {/* 管线图 + 检查器 */}
      <div
        className="relative min-h-0 flex-1 overflow-hidden rounded-xl border border-border/50 bg-card"
        style={{
          backgroundImage:
            'radial-gradient(circle, color-mix(in oklab, var(--foreground) 7%, transparent) 1px, transparent 1px)',
          backgroundSize: '20px 20px',
        }}
        onClick={() => setSelected(null)}
      >
        <div
          ref={wrapRef}
          className="flex h-full w-full items-center justify-center overflow-hidden"
        >
          <div
            className="relative shrink-0"
            style={{ width: DESIGN_W * scale, height: DESIGN_H * scale }}
          >
            <div
              className="absolute left-0 top-0"
              style={{
                width: DESIGN_W,
                height: DESIGN_H,
                transform: `scale(${scale})`,
                transformOrigin: 'top left',
              }}
            >
              <svg
                width={DESIGN_W}
                height={DESIGN_H}
                className="pointer-events-none absolute inset-0 overflow-visible"
              >
                <defs>
                  <marker
                    id="course-arrow"
                    viewBox="0 0 8 8"
                    refX="6.5"
                    refY="4"
                    markerWidth="7"
                    markerHeight="7"
                    orient="auto-start-reverse"
                  >
                    <path d="M0.5,0.8 L7,4 L0.5,7.2 Z" fill="currentColor" />
                  </marker>
                </defs>
                {RAILS.map((r, i) => (
                  <path
                    key={i}
                    d={roundedPath(r.pts)}
                    className="fill-none text-foreground/35 stroke-foreground/[0.18]"
                    strokeWidth={1.5}
                    strokeLinecap="round"
                    strokeDasharray={r.dashed ? '0.5 6' : undefined}
                    markerEnd="url(#course-arrow)"
                  />
                ))}
              </svg>

              <span
                className="absolute rounded-full border border-border/60 bg-card px-1.5 py-px text-[9px] text-muted-foreground"
                style={{ left: 385, top: 249 }}
              >
                {t(`${cm}.parallel`)}
              </span>

              {STATIONS.map((def) => {
                const state = stationState(def);
                return (
                  <Station
                    key={def.id}
                    def={def}
                    label={t(def.labelKey)}
                    following={state.following}
                    overrideName={
                      state.following ? undefined : stageOverrideName(def.stages?.[0] ?? '')
                    }
                    resolvedName={mainModelName}
                    mediaLines={state.mediaLines}
                    allOff={state.allOff}
                    selected={selected === def.id}
                    onSelect={() => setSelected(def.id)}
                    t={t}
                  />
                );
              })}
            </div>
          </div>
        </div>

        {selectedDef && (
          <Inspector
            def={selectedDef}
            t={t}
            llmPickerGroups={llmPickerGroups}
            mainModelName={mainModelName}
            llmStageRoutes={llmStageRoutes}
            setStageRoute={setStageRoute}
            onClose={() => setSelected(null)}
            // 媒体模态真实接线
            webSearch={{
              enabled: webSearchEnabled,
              setEnabled: setWebSearchEnabled,
              providerId: webSearchProviderId,
              setProvider: (id) => setWebSearchProvider(id as WebSearchProviderId),
              providersConfig: webSearchProvidersConfig,
            }}
            tts={{
              enabled: ttsEnabled,
              setEnabled: setTTSEnabled,
              providerId: ttsProviderId,
              setProvider: (id) => setTTSProvider(id as TTSProviderId),
              setProviderConfig: (id, config) => setTTSProviderConfig(id as TTSProviderId, config),
              providersConfig: ttsProvidersConfig,
            }}
            asr={{
              enabled: asrEnabled,
              setEnabled: setASREnabled,
              providerId: asrProviderId,
              setProvider: (id) => setASRProvider(id as ASRProviderId),
              setProviderConfig: (id, config) => setASRProviderConfig(id as ASRProviderId, config),
              providersConfig: asrProvidersConfig,
            }}
            pdf={{
              providerId: pdfProviderId,
              setProvider: setPDFProvider,
              providersConfig: pdfProvidersConfig,
            }}
            image={{
              enabled: imageGenerationEnabled,
              setEnabled: setImageGenerationEnabled,
              hasUsableProvider: hasUsableImageProvider,
              providerId: imageProviderId,
              modelId: imageModelId,
              setProvider: (id) => setImageProvider(id as typeof imageProviderId),
              setModelId: setImageModelId,
              providersConfig: imageProvidersConfig,
            }}
            video={{
              enabled: videoGenerationEnabled,
              setEnabled: setVideoGenerationEnabled,
              hasUsableProvider: hasUsableVideoProvider,
              providerId: videoProviderId,
              modelId: videoModelId,
              setProvider: (id) => setVideoProvider(id as typeof videoProviderId),
              setModelId: setVideoModelId,
              providersConfig: videoProvidersConfig,
            }}
          />
        )}
      </div>
    </div>
  );
}

// ── 检查器 ──────────────────────────────────────────────────
interface MediaSlotPropsBase {
  providerId: string;
}

function Inspector(props: {
  def: StationDef;
  t: (key: string) => string;
  llmPickerGroups: ModelPickerGroup[];
  mainModelName: string;
  llmStageRoutes: Record<
    string,
    { providerId: ProviderId; modelId: string; thinking?: ThinkingConfig }
  >;
  setStageRoute: (
    stage: string,
    route: { providerId: ProviderId; modelId: string; thinking?: ThinkingConfig } | null,
  ) => void;
  onClose: () => void;
  webSearch: MediaSlotPropsBase & {
    enabled: boolean;
    setEnabled: (v: boolean) => void;
    setProvider: (id: string) => void;
    providersConfig: Record<
      string,
      {
        apiKey?: string;
        baseUrl?: string;
        enabled?: boolean;
        isServerConfigured?: boolean;
        serverDisabled?: boolean;
      }
    >;
  };
  tts: MediaSlotPropsBase & {
    enabled: boolean;
    setEnabled: (v: boolean) => void;
    setProvider: (id: string) => void;
    setProviderConfig: (id: string, config: { modelId?: string }) => void;
    providersConfig: Record<
      string,
      {
        modelId?: string;
        customModels?: Array<{ id: string; name: string }>;
        isServerConfigured?: boolean;
      }
    >;
  };
  asr: MediaSlotPropsBase & {
    enabled: boolean;
    setEnabled: (v: boolean) => void;
    setProvider: (id: string) => void;
    setProviderConfig: (id: string, config: { modelId?: string }) => void;
    providersConfig: Record<
      string,
      {
        modelId?: string;
        customModels?: Array<{ id: string; name: string }>;
        isServerConfigured?: boolean;
      }
    >;
  };
  pdf: MediaSlotPropsBase & {
    setProvider: (id: PDFProviderId) => void;
    providersConfig: Record<
      string,
      {
        apiKey?: string;
        accessKeyId?: string;
        accessKeySecret?: string;
        enabled?: boolean;
        isServerConfigured?: boolean;
      }
    >;
  };
  image: MediaSlotPropsBase & {
    enabled: boolean;
    setEnabled: (v: boolean) => void;
    /** 无任何可用凭证（API Key / 服务端配置）时开启会被提示并拒绝 */
    hasUsableProvider: boolean;
    modelId: string;
    providerId: string;
    setProvider: (id: string) => void;
    setModelId: (id: string) => void;
    providersConfig: Record<
      string,
      {
        customModels?: Array<{ id: string; name: string }>;
        replaceBuiltInModels?: boolean;
        enabled?: boolean;
        isServerConfigured?: boolean;
      }
    >;
  };
  video: MediaSlotPropsBase & {
    enabled: boolean;
    setEnabled: (v: boolean) => void;
    hasUsableProvider: boolean;
    modelId: string;
    setProvider: (id: string) => void;
    setModelId: (id: string) => void;
    providersConfig: Record<
      string,
      {
        customModels?: Array<{ id: string; name: string }>;
        replaceBuiltInModels?: boolean;
        enabled?: boolean;
        isServerConfigured?: boolean;
      }
    >;
  };
}) {
  const { t, def, llmPickerGroups, mainModelName, llmStageRoutes, setStageRoute } = props;
  const cm = 'settings.courseModels';

  // stage 选择器。站点级调用传整组键（多键站点覆盖时一起写、跟随时一起清，
  // 见 lib/config/station-stage-keys.ts）；细分环节仍传单键。
  const stageRouteSelect = (
    stageKeys: string | readonly string[],
    followLabel: string,
    followNote: string,
  ) => {
    const keys = typeof stageKeys === 'string' ? [stageKeys] : stageKeys;
    const primary = keys[0];
    const route = primary ? (llmStageRoutes[primary] ?? null) : null;
    const writeAll = (
      routeValue: { providerId: ProviderId; modelId: string; thinking?: ThinkingConfig } | null,
    ) => {
      for (const key of keys) setStageRoute(key, routeValue);
    };
    return (
      <div className="space-y-1">
        <ModelPicker
          groups={llmPickerGroups}
          value={route ? { providerId: route.providerId, modelId: route.modelId } : null}
          followLabel={followLabel}
          followNote={followNote}
          onFollow={() => writeAll(null)}
          onSelect={(pid, mid) => writeAll({ providerId: pid as ProviderId, modelId: mid })}
          thinkingConfig={route?.thinking}
          onThinkingChange={
            route
              ? (config) =>
                  writeAll({
                    providerId: route.providerId,
                    modelId: route.modelId,
                    thinking: config,
                  })
              : undefined
          }
          t={t}
        />
        {route && (
          <button
            onClick={() => writeAll(null)}
            className="text-[11px] text-primary transition-colors hover:underline"
          >
            {t(`${cm}.restoreFollow`)}
          </button>
        )}
      </div>
    );
  };

  return (
    <aside
      onClick={(e) => e.stopPropagation()}
      className="absolute inset-y-0 right-0 z-10 flex w-80 flex-col overflow-hidden border-l border-border/60 bg-card/95 backdrop-blur"
    >
      <div className="flex items-start justify-between gap-2 border-b border-border/60 px-4 py-3">
        <div className="min-w-0">
          <p className="text-sm font-medium leading-tight">{t(def.labelKey)}</p>
          {def.stages ? (
            <p className="mt-1 truncate rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
              {def.stages.join(' · ')}
            </p>
          ) : (
            def.kind === 'media' && (
              <p className="mt-1 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                {t(`${cm}.servicesAndModels`)}
              </p>
            )
          )}
        </div>
        <button
          onClick={props.onClose}
          aria-label={t('settings.close')}
          className="shrink-0 rounded-md p-1 text-muted-foreground/60 transition-colors hover:bg-muted hover:text-foreground"
        >
          <X className="size-3.5" />
        </button>
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4 pb-5">
        <p className="text-xs leading-relaxed text-muted-foreground">
          {t(`${cm}.stations.desc.${def.id}`)}
        </p>

        {def.stages && (
          <div className="space-y-1.5">
            <p className="text-xs font-medium">{t(`${cm}.modelSource`)}</p>
            {llmPickerGroups.length > 0 ? (
              stageRouteSelect(def.stages, t(`${cm}.followMainline`), mainModelName)
            ) : (
              <p className="text-[11px] text-muted-foreground">{t(`${cm}.noProviderHint`)}</p>
            )}
          </div>
        )}

        {def.subSlots && def.subSlots.length > 0 && llmPickerGroups.length > 0 && (
          <div className="space-y-2">
            <p className="text-xs font-medium">{t(`${cm}.subStagesTitle`)}</p>
            {def.subSlots.map((sub) => (
              <div key={sub.key} className="space-y-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[11px]">{t(sub.labelKey)}</span>
                  <span className="truncate font-mono text-[9px] text-muted-foreground/70">
                    {sub.key.split(':').pop()}
                  </span>
                </div>
                {stageRouteSelect(sub.key, t(`${cm}.followParent`), mainModelName)}
              </div>
            ))}
          </div>
        )}

        {/* 联网调研：搜索服务 */}
        {def.id === 'web-research' && (
          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] font-medium">{t(`${cm}.searchService`)}</span>
              <Switch
                checked={props.webSearch.enabled}
                onCheckedChange={props.webSearch.setEnabled}
                aria-label={t(`${cm}.searchService`)}
                className="scale-90"
              />
            </div>
            <Select
              value={props.webSearch.providerId}
              onValueChange={(v) => props.webSearch.setProvider(v)}
            >
              <SelectTrigger size="sm" className="h-7 w-full text-[11px]">
                <SelectValue placeholder={t(`${cm}.pickProvider`)} />
              </SelectTrigger>
              <SelectContent align="start">
                {Object.values(WEB_SEARCH_PROVIDERS)
                  .filter((provider) => {
                    const cfg = props.webSearch.providersConfig[provider.id];
                    const usable =
                      isWebSearchProviderConfigured(provider, cfg) && cfg?.enabled !== false;
                    return (
                      usable ||
                      // 当前失效的选中项保留为一行灰提示，避免 SelectValue 空白。
                      provider.id === props.webSearch.providerId
                    );
                  })
                  .map((provider) => {
                    const cfg = props.webSearch.providersConfig[provider.id];
                    const usable =
                      isWebSearchProviderConfigured(provider, cfg) && cfg?.enabled !== false;
                    return (
                      <SelectItem
                        key={provider.id}
                        value={provider.id}
                        disabled={!usable}
                        className="text-[11px]"
                      >
                        {usable
                          ? getWebSearchProviderDisplayName(provider.id, t)
                          : `${getWebSearchProviderDisplayName(provider.id, t)} · ${t(`${cm}.optionInvalid`)}`}
                      </SelectItem>
                    );
                  })}
              </SelectContent>
            </Select>
          </div>
        )}

        {/* 语音合成 */}
        {def.id === 'tts' && (
          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] font-medium">{t('settings.ttsSettings')}</span>
              <Switch
                checked={props.tts.enabled}
                onCheckedChange={props.tts.setEnabled}
                aria-label={t('settings.enableTTS')}
                className="scale-90"
              />
            </div>
            <ModelPicker
              groups={[
                {
                  id: props.tts.providerId,
                  name: ttsBuiltIn(props.tts.providerId)?.name ?? props.tts.providerId,
                  models: (() => {
                    const builtIn = ttsBuiltIn(props.tts.providerId);
                    const config = props.tts.providersConfig[props.tts.providerId];
                    return builtIn
                      ? [...builtIn.models, ...(config?.customModels ?? [])]
                      : (config?.customModels ?? []);
                  })(),
                },
              ]}
              value={{
                providerId: props.tts.providerId,
                modelId:
                  props.tts.providersConfig[props.tts.providerId]?.modelId ||
                  ttsBuiltIn(props.tts.providerId)?.defaultModelId ||
                  '',
              }}
              onSelect={(_, mid) =>
                props.tts.setProviderConfig(props.tts.providerId, { modelId: mid })
              }
              disabled={!props.tts.enabled}
              t={t}
            />
          </div>
        )}

        {/* 文档解析：解析服务 + 语音转写 */}
        {def.id === 'doc-parse' && (
          <div className="space-y-3">
            <div className="space-y-1.5">
              <span className="text-[11px] font-medium">{t(`${cm}.parseService`)}</span>
              <Select
                value={props.pdf.providerId}
                onValueChange={(v) => props.pdf.setProvider(v as PDFProviderId)}
              >
                <SelectTrigger size="sm" className="h-7 w-full text-[11px]">
                  <SelectValue placeholder={t(`${cm}.pickProvider`)} />
                </SelectTrigger>
                <SelectContent align="start">
                  {Object.values(PDF_PROVIDERS)
                    .filter((provider) => {
                      const cfg = props.pdf.providersConfig[provider.id];
                      const hasCredentials =
                        !!cfg?.apiKey || (!!cfg?.accessKeyId && !!cfg?.accessKeySecret);
                      const available =
                        !provider.requiresApiKey || hasCredentials || !!cfg?.isServerConfigured;
                      const usable = available && cfg?.enabled !== false;
                      return (
                        usable ||
                        // 当前失效的选中项保留为一行灰提示，避免 SelectValue 空白。
                        provider.id === props.pdf.providerId
                      );
                    })
                    .map((provider) => {
                      const cfg = props.pdf.providersConfig[provider.id];
                      const hasCredentials =
                        !!cfg?.apiKey || (!!cfg?.accessKeyId && !!cfg?.accessKeySecret);
                      const available =
                        !provider.requiresApiKey || hasCredentials || !!cfg?.isServerConfigured;
                      const usable = available && cfg?.enabled !== false;
                      return (
                        <SelectItem
                          key={provider.id}
                          value={provider.id}
                          disabled={!usable}
                          className="text-[11px]"
                        >
                          {usable
                            ? provider.name
                            : `${provider.name} · ${t(`${cm}.optionInvalid`)}`}
                        </SelectItem>
                      );
                    })}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[11px] font-medium">{t(`${cm}.asrTranscribe`)}</span>
                <Switch
                  checked={props.asr.enabled}
                  onCheckedChange={props.asr.setEnabled}
                  aria-label={t('settings.enableASR')}
                  className="scale-90"
                />
              </div>
              <ModelPicker
                groups={[
                  {
                    id: props.asr.providerId,
                    name: asrBuiltIn(props.asr.providerId)?.name ?? props.asr.providerId,
                    models: (() => {
                      const builtIn = asrBuiltIn(props.asr.providerId);
                      const config = props.asr.providersConfig[props.asr.providerId];
                      return builtIn
                        ? [...builtIn.models, ...(config?.customModels ?? [])]
                        : (config?.customModels ?? []);
                    })(),
                  },
                ]}
                value={{
                  providerId: props.asr.providerId,
                  modelId:
                    props.asr.providersConfig[props.asr.providerId]?.modelId ||
                    asrBuiltIn(props.asr.providerId)?.defaultModelId ||
                    '',
                }}
                onSelect={(_, mid) =>
                  props.asr.setProviderConfig(props.asr.providerId, { modelId: mid })
                }
                disabled={!props.asr.enabled}
                t={t}
              />
            </div>
          </div>
        )}

        {/* 媒体生成：配图 + 视频 */}
        {def.id === 'media' &&
          [
            {
              key: 'image' as const,
              label: t(`${cm}.aiIllustration`),
              enabled: props.image.enabled,
              setEnabled: props.image.setEnabled,
              hasUsableProvider: props.image.hasUsableProvider,
              providerId: props.image.providerId,
              modelId: props.image.modelId,
              registry: IMAGE_PROVIDERS as Record<
                string,
                { name?: string; models: Array<{ id: string; name: string }> }
              >,
              config: props.image.providersConfig,
              setProvider: props.image.setProvider,
              setModelId: props.image.setModelId,
              aria: t('settings.enableImageGeneration'),
            },
            {
              key: 'video' as const,
              label: t(`${cm}.aiVideo`),
              enabled: props.video.enabled,
              setEnabled: props.video.setEnabled,
              hasUsableProvider: props.video.hasUsableProvider,
              providerId: props.video.providerId,
              modelId: props.video.modelId,
              registry: VIDEO_PROVIDERS as Record<
                string,
                { name?: string; models: Array<{ id: string; name: string }> }
              >,
              config: props.video.providersConfig,
              setProvider: props.video.setProvider,
              setModelId: props.video.setModelId,
              aria: t('settings.enableVideoGeneration'),
            },
          ].map((slot) => {
            const nameKeys =
              slot.key === 'image'
                ? (IMAGE_PROVIDER_NAMES as Record<string, string>)
                : (VIDEO_PROVIDER_NAMES as Record<string, string>);
            // 组列表 = 已授权且持有凭证的 provider（与联网搜索/文档解析口径一致）。
            const groupIds = Object.keys(slot.registry).filter((pid) => {
              const cfg = slot.config[pid] as
                | { apiKey?: string; isServerConfigured?: boolean; enabled?: boolean }
                | undefined;
              return cfg?.enabled !== false && !!(cfg?.apiKey || cfg?.isServerConfigured);
            });
            // 当前选择失效（provider 被禁用/删除、或从未设置）时传 null，
            // 让触发器显示占位而不是渲染成一个空白胶囊。
            const selectionValid =
              !!slot.providerId && groupIds.includes(slot.providerId) && !!slot.modelId;
            return (
              <div key={slot.key} className="space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[11px] font-medium">{slot.label}</span>
                  <Switch
                    checked={slot.enabled}
                    onCheckedChange={(checked) => {
                      // store 的开启守卫会静默拒绝无凭证开启；这里先提示，
                      // 避免用户以为开关坏了。
                      if (checked && !slot.hasUsableProvider) {
                        toast.error(t(`${cm}.mediaEnableNeedsSetup`));
                        return;
                      }
                      slot.setEnabled(checked);
                    }}
                    aria-label={slot.aria}
                    className="scale-90"
                  />
                </div>
                <ModelPicker
                  groups={groupIds.map((pid) => {
                    const cfg = slot.config[pid];
                    const provider = slot.registry[pid];
                    const list = cfg?.replaceBuiltInModels
                      ? (cfg.customModels ?? [])
                      : [...(provider?.models ?? []), ...(cfg?.customModels ?? [])];
                    return {
                      id: pid,
                      name: t(`settings.${nameKeys[pid]}`) || provider?.name || pid,
                      models: list,
                    };
                  })}
                  value={
                    selectionValid ? { providerId: slot.providerId, modelId: slot.modelId } : null
                  }
                  placeholder={t(`${cm}.pickModel`)}
                  onSelect={(pid, mid) => {
                    // 先切 provider（其内部会重置模型选择），再显式选模型
                    if (pid !== slot.providerId) slot.setProvider(pid);
                    slot.setModelId(mid);
                  }}
                  disabled={!slot.enabled}
                  t={t}
                />
              </div>
            );
          })}
      </div>
    </aside>
  );
}
