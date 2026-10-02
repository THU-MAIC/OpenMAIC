'use client';

// 「课程模型配置」分区：把课程生成管线画成流程图（卡片站点 + 自绘 SVG 轨道），
// 每个环节显示实际使用的模型。模型来自工作区在服务端的模型设置
// （/api/model-config）：主线模型是 `llm` 槽位，每个 LLM 环节是它自己的槽位
// （跟随主线 = 不设，继承 `llm`）；媒体环节的开关与服务/模型是各模态的根槽位
// （关 = null）。服务端配置锁定的槽位只读展示。

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  CornerDownRight,
  Eye,
  FileStack,
  Images,
  Info,
  ListTree,
  Lock,
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
import type { SlotCapability, SlotId } from '@/lib/config/model-slots';
import {
  findSlot,
  type ApplyChange,
  type ModelSettingsChange,
  type ModelSettingsView,
  type SlotView,
} from '@/lib/model-settings/client';
import {
  assignmentRefs,
  modelChange,
  modelName,
  modelRef,
  switchOffChange,
  switchOnChange,
  type OffMemory,
} from '@/lib/model-settings/edit';
import {
  ROOT_SLOT,
  effectiveRef,
  serviceEntries,
  slotOn,
  slotThinking,
  thinkingChange,
  type ServiceEntry,
} from '@/lib/model-settings/services';
import type { ThinkingConfig } from '@/lib/types/provider';
import { ModelPicker, type ModelPickerGroup } from './model-picker';
import { useLLMPickerGroups } from './use-llm-picker-groups';
import { REGISTRY_INFO, entryName, isEntryConfigured } from './model-services';
import { applyErrorText, type T } from './server-settings';

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
  /** The language model slot this station sets (its stages resolve through it). */
  slot?: SlotId;
  subSlots?: Array<{ key: SlotId; labelKey: string }>;
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
    slot: 'course.research',
  },
  {
    id: 'outline',
    labelKey: 'settings.courseModels.stations.outline',
    kind: 'llm',
    slot: 'course.outline',
    vision: true,
  },
  {
    id: 'agents',
    labelKey: 'settings.courseModels.stations.agents',
    kind: 'llm',
    slot: 'course.agents',
  },
  {
    id: 'scene-content',
    labelKey: 'settings.courseModels.stations.sceneContent',
    kind: 'llm',
    slot: 'course.content',
    vision: true,
    tag: 'loop',
    subSlots: [
      { key: 'course.content.slide', labelKey: 'settings.courseModels.subStages.slide' },
      { key: 'course.content.quiz', labelKey: 'settings.courseModels.subStages.quiz' },
      {
        key: 'course.content.interactive',
        labelKey: 'settings.courseModels.subStages.interactive',
      },
      { key: 'course.content.pbl', labelKey: 'settings.courseModels.subStages.pbl' },
    ],
  },
  {
    id: 'scene-actions',
    labelKey: 'settings.courseModels.stations.sceneActions',
    kind: 'llm',
    slot: 'course.actions',
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
    // One slot for the classroom runtime: chat, quiz grading and the PBL runtime.
    slot: 'classroom',
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
  locked,
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
  /** Set by the server: shown, not editable. */
  locked: boolean;
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
        {locked && (
          <Lock
            className="size-3 shrink-0 text-muted-foreground/60"
            aria-label={t('settings.serverConfig.setByServer')}
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
            {def.slot &&
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

// ── 服务端设置的读写 ─────────────────────────────────────────

/**
 * What each media switch held before it was turned off here, so turning it on
 * restores that (kept for the page, across the dialog opening and closing).
 */
const OFF_MEMORY: OffMemory = new Map();

/** The services a media slot can use: the configured ones, and those that need no key. */
function usableEntries(view: ModelSettingsView, capability: SlotCapability): ServiceEntry[] {
  return serviceEntries(view, capability, REGISTRY_INFO[capability].ids).filter(
    (entry) =>
      entry.state === 'deployment' ||
      entry.state === 'workspace' ||
      (entry.state === 'available' && isEntryConfigured(entry, capability)),
  );
}

interface Editor {
  view: ModelSettingsView;
  t: T;
  /** Apply a change worked out from the view; reports a refusal. */
  change: (change: ModelSettingsChange | undefined) => Promise<ModelSettingsView | null>;
  /**
   * Set a slot to a service's model, adding the service first when it is one
   * that needs no key and is not saved yet.
   */
  assign: (slotId: SlotId, entry: ServiceEntry, modelId?: string) => Promise<void>;
}

function useEditor(view: ModelSettingsView, apply: ApplyChange, t: T): Editor {
  return useMemo(() => {
    const change: Editor['change'] = async (next) => {
      if (!next) return null;
      const result = await apply(next, view);
      if (!result.ok) {
        toast.error(applyErrorText(result, t));
        return null;
      }
      return result.view;
    };
    const assign: Editor['assign'] = async (slotId, entry, modelId) => {
      let current: ModelSettingsView | null = view;
      if (!entry.provider) {
        const preset = entry.preset?.id;
        if (!preset) return;
        const added = await apply({ kind: 'provider', id: entry.id, preset }, view);
        if (!added.ok) {
          toast.error(applyErrorText(added, t));
          return;
        }
        current = added.view;
      }
      const slot = findSlot(current, slotId);
      if (!slot) return;
      const result = await apply(modelChange(slot, modelRef(entry.id, modelId)), current);
      if (!result.ok) toast.error(applyErrorText(result, t));
    };
    return { view, t, change, assign };
  }, [view, apply, t]);
}

/** A model's name as its provider lists it (else its id); a provider alone is its service's name. */
function refName(
  view: ModelSettingsView,
  capability: SlotCapability,
  ref: { providerId: string; modelId?: string } | null,
  t: T,
): string | undefined {
  if (!ref) return undefined;
  if (ref.modelId) return modelName(view, capability, ref.providerId, ref.modelId);
  const entry = serviceEntries(view, capability, []).find((item) => item.id === ref.providerId);
  return entry ? entryName(entry, capability, t) : ref.providerId;
}

// ── 主面板 ──────────────────────────────────────────────────
export function CourseModelConfigPanel({
  view,
  apply,
  onOpenServices,
}: {
  view: ModelSettingsView;
  apply: ApplyChange;
  /** Open Model Services (where services are configured). */
  onOpenServices?: () => void;
}) {
  const { t } = useI18n();
  const editor = useEditor(view, apply, t);
  const slot = (id: SlotId) => findSlot(view, id);

  const [selected, setSelected] = useState<string | null>(null);
  const selectedDef = STATIONS.find((s) => s.id === selected) ?? null;

  // ── 可用 LLM 选项与模型组（套餐置顶/推荐序的口径与首页工具栏共享） ──
  const llmPickerGroups = useLLMPickerGroups(view);
  const llmSlot = slot('llm');
  const mainRef = effectiveRef(llmSlot);
  const mainModelName =
    refName(view, 'chat', mainRef, t) ?? t('settings.courseModels.mainlineUnset');

  // ── 站点状态 ──
  const lineFor = (capability: SlotCapability) =>
    refName(view, capability, effectiveRef(slot(ROOT_SLOT[capability])), t);
  const stationState = (def: StationDef) => {
    switch (def.id) {
      case 'doc-parse': {
        const asr = slot('asr');
        return {
          following: true,
          mediaLines: [lineFor('document') ?? 'unpdf', slotOn(asr) ? lineFor('asr') : null].filter(
            (v): v is string => !!v,
          ),
          allOff: false,
          locked: !!slot('document')?.locked,
        };
      }
      case 'tts':
        return {
          following: true,
          mediaLines: slotOn(slot('tts')) ? [lineFor('tts')!] : [],
          allOff: !slotOn(slot('tts')),
          locked: !!slot('tts')?.locked,
        };
      case 'media': {
        const lines = [
          slotOn(slot('image')) ? lineFor('image') : null,
          slotOn(slot('video')) ? lineFor('video') : null,
        ].filter((v): v is string => !!v);
        return {
          following: true,
          mediaLines: lines,
          allOff: lines.length === 0,
          locked: !!slot('image')?.locked && !!slot('video')?.locked,
        };
      }
      default: {
        const own = def.slot ? slot(def.slot) : undefined;
        const search = def.id === 'web-research' ? slot('webSearch') : undefined;
        return {
          // Follows the main model: nothing of its own, nothing locked.
          following: !!own && own.assignment === undefined && !own.locked,
          mediaLines: search && slotOn(search) ? [lineFor('webSearch')!] : [],
          allOff:
            def.id === 'web-research'
              ? !slotOn(search) && !slotOn(own)
              : !slotOn(own) && own?.effective.status === 'disabled',
          locked: !!own?.locked,
        };
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
  const mainLocked = !!llmSlot?.locked;

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      {/* 主线模型条 */}
      <div className="flex shrink-0 items-center gap-3 px-1">
        <span className="shrink-0 text-xs font-medium">{t(`${cm}.mainModel`)}</span>
        <div className="w-56 shrink-0">
          {llmPickerGroups.length > 0 || mainRef ? (
            <ModelPicker
              groups={llmPickerGroups}
              value={
                mainRef?.modelId
                  ? { providerId: mainRef.providerId, modelId: mainRef.modelId }
                  : null
              }
              onSelect={(pid, mid) =>
                llmSlot && void editor.change(modelChange(llmSlot, modelRef(pid, mid)))
              }
              thinkingConfig={slotThinking(llmSlot)}
              onThinkingChange={
                llmSlot && assignmentRefs(llmSlot.assignment).model && !mainLocked
                  ? (config) => void editor.change(thinkingChange(llmSlot, config))
                  : undefined
              }
              disabled={mainLocked}
              placeholder={t(`${cm}.noProviderHint`)}
              ariaLabel={t(`${cm}.mainModel`)}
              size="md"
              t={t}
            />
          ) : (
            <button
              type="button"
              onClick={onOpenServices}
              className="text-left text-[11px] text-muted-foreground hover:text-foreground hover:underline"
            >
              {t(`${cm}.noProviderHint`)}
            </button>
          )}
        </div>
        <p className="hidden min-w-0 flex-1 text-[11px] leading-snug text-muted-foreground lg:block">
          {mainLocked ? t('settings.serverConfig.lockedHint') : t(`${cm}.mainModelHint`)}
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
                const own = def.slot ? slot(def.slot) : undefined;
                return (
                  <Station
                    key={def.id}
                    def={def}
                    label={t(def.labelKey)}
                    following={state.following}
                    overrideName={
                      state.following ? undefined : refName(view, 'chat', effectiveRef(own), t)
                    }
                    resolvedName={mainModelName}
                    mediaLines={state.mediaLines}
                    allOff={state.allOff}
                    locked={state.locked}
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
            editor={editor}
            llmPickerGroups={llmPickerGroups}
            mainModelName={mainModelName}
            onClose={() => setSelected(null)}
          />
        )}
      </div>
    </div>
  );
}

// ── 检查器 ──────────────────────────────────────────────────

/** What a slot's line says when the server sets it. */
function LockedNote({ slot, t }: { slot: SlotView | undefined; t: T }) {
  if (!slot?.locked) return null;
  return (
    <p className="flex items-center gap-1 text-[10px] text-muted-foreground">
      <Lock className="size-3" aria-hidden="true" />
      {t('settings.serverConfig.setByServer')}
    </p>
  );
}

/** A language model slot: follow its parent, or a model of its own (with its thinking settings). */
function ChatSlotPicker({
  slot,
  editor,
  groups,
  followLabel,
  followNote,
}: {
  slot: SlotView;
  editor: Editor;
  groups: ModelPickerGroup[];
  followLabel: string;
  followNote: string;
}) {
  const { t } = editor;
  const own = assignmentRefs(slot.assignment).model;
  const ownRef = own ? effectiveRef(slot) : null;
  // A slot the server sets shows its model; the workspace's own shows its choice.
  const value = slot.locked ? effectiveRef(slot) : ownRef;
  return (
    <div className="space-y-1">
      <ModelPicker
        groups={groups}
        value={value?.modelId ? { providerId: value.providerId, modelId: value.modelId } : null}
        followLabel={followLabel}
        followNote={followNote}
        onFollow={() => void editor.change({ kind: 'slots', clear: [slot.slot] })}
        onSelect={(pid, mid) => void editor.change(modelChange(slot, modelRef(pid, mid)))}
        thinkingConfig={slotThinking(slot)}
        onThinkingChange={
          own && !slot.locked
            ? (config: ThinkingConfig | undefined) =>
                void editor.change(thinkingChange(slot, config))
            : undefined
        }
        disabled={slot.locked}
        t={t}
      />
      <LockedNote slot={slot} t={t} />
      {own && !slot.locked && (
        <button
          onClick={() => void editor.change({ kind: 'slots', clear: [slot.slot] })}
          className="text-[11px] text-primary transition-colors hover:underline"
        >
          {t('settings.courseModels.restoreFollow')}
        </button>
      )}
    </div>
  );
}

/** A media slot's switch: off sets it to null; on restores what it held, or its first service. */
function MediaSwitch({
  capability,
  slot,
  editor,
  label,
}: {
  capability: SlotCapability;
  slot: SlotView;
  editor: Editor;
  label: string;
}) {
  const { t, view } = editor;
  // Speech input runs in the browser while nothing is set: only null turns it off.
  const checked = capability === 'asr' ? slot.effective.status !== 'disabled' : slotOn(slot);
  const toggle = async (next: boolean) => {
    if (!next) {
      void editor.change(switchOffChange(slot, OFF_MEMORY));
      return;
    }
    const restore = switchOnChange(slot, OFF_MEMORY);
    if (restore) {
      OFF_MEMORY.delete(slot.slot);
      void editor.change(restore);
      return;
    }
    // Turned off elsewhere: back on with the first service that can serve it.
    if (slot.assignment === null && capability === 'asr') {
      void editor.change({ kind: 'slots', clear: [slot.slot] });
      return;
    }
    const first = usableEntries(view, capability)[0];
    if (!first) {
      toast.error(t('settings.courseModels.mediaEnableNeedsSetup'));
      return;
    }
    const models =
      first.provider?.capabilities[capability]?.models ??
      first.preset?.capabilities[capability]?.models ??
      [];
    await editor.assign(slot.slot, first, models[0]?.id);
  };
  return (
    <Switch
      checked={checked}
      disabled={slot.locked}
      onCheckedChange={(next) => void toggle(next)}
      aria-label={label}
      className="scale-90"
    />
  );
}

/** A media slot's service and model: the services that can serve it, grouped with their models. */
function MediaModelPicker({
  capability,
  slot,
  editor,
}: {
  capability: SlotCapability;
  slot: SlotView;
  editor: Editor;
}) {
  const { t, view } = editor;
  const entries = usableEntries(view, capability);
  const groups: ModelPickerGroup[] = entries.map((entry) => {
    const models =
      entry.provider?.capabilities[capability]?.models ??
      entry.preset?.capabilities[capability]?.models ??
      [];
    return {
      id: entry.id,
      name: entryName(entry, capability, t),
      // A service without models to pick runs its default.
      models: models.length
        ? models.map((model) => ({ id: model.id, name: model.name }))
        : [{ id: '', name: t('settings.serverConfig.defaultModel') }],
    };
  });
  const ref = effectiveRef(slot);
  return (
    <ModelPicker
      groups={groups}
      value={ref ? { providerId: ref.providerId, modelId: ref.modelId ?? '' } : null}
      placeholder={t('settings.courseModels.pickModel')}
      onSelect={(pid, mid) => {
        const entry = entries.find((item) => item.id === pid);
        if (entry) void editor.assign(slot.slot, entry, mid || undefined);
      }}
      disabled={slot.locked || !slotOn(slot)}
      t={t}
    />
  );
}

/** A media slot whose services have no models to pick (search, documents): a service select. */
function MediaServiceSelect({
  capability,
  slot,
  editor,
}: {
  capability: SlotCapability;
  slot: SlotView;
  editor: Editor;
}) {
  const { t, view } = editor;
  const entries = usableEntries(view, capability);
  const current = effectiveRef(slot)?.providerId;
  return (
    <Select
      value={current ?? ''}
      disabled={slot.locked || slot.effective.status === 'disabled'}
      onValueChange={(v) => {
        const entry = entries.find((item) => item.id === v);
        if (entry) void editor.assign(slot.slot, entry);
      }}
    >
      <SelectTrigger size="sm" className="h-7 w-full text-[11px]">
        <SelectValue placeholder={t('settings.courseModels.pickProvider')} />
      </SelectTrigger>
      <SelectContent align="start">
        {entries.map((entry) => (
          <SelectItem key={entry.id} value={entry.id} className="text-[11px]">
            {entryName(entry, capability, t)}
          </SelectItem>
        ))}
        {current && !entries.some((entry) => entry.id === current) && (
          <SelectItem value={current} disabled className="text-[11px]">
            {`${current} · ${t('settings.courseModels.optionInvalid')}`}
          </SelectItem>
        )}
      </SelectContent>
    </Select>
  );
}

function Inspector({
  def,
  editor,
  llmPickerGroups,
  mainModelName,
  onClose,
}: {
  def: StationDef;
  editor: Editor;
  llmPickerGroups: ModelPickerGroup[];
  mainModelName: string;
  onClose: () => void;
}) {
  const { t, view } = editor;
  const cm = 'settings.courseModels';
  const slot = (id: SlotId) => findSlot(view, id);
  const stationSlot = def.slot ? slot(def.slot) : undefined;
  const slotIds = [
    ...(def.slot ? [def.slot] : []),
    ...(def.id === 'web-research' ? ['webSearch'] : []),
    ...(def.id === 'doc-parse' ? ['document', 'asr'] : []),
    ...(def.id === 'tts' ? ['tts'] : []),
    ...(def.id === 'media' ? ['image', 'video'] : []),
  ];

  const mediaRow = (capability: SlotCapability, label: string, ariaLabel: string) => {
    const media = slot(ROOT_SLOT[capability]);
    if (!media) return null;
    const providerOnly = capability === 'webSearch' || capability === 'document';
    return (
      <div className="space-y-1.5">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[11px] font-medium">{label}</span>
          {capability !== 'document' && (
            <MediaSwitch capability={capability} slot={media} editor={editor} label={ariaLabel} />
          )}
        </div>
        {providerOnly ? (
          <MediaServiceSelect capability={capability} slot={media} editor={editor} />
        ) : (
          <MediaModelPicker capability={capability} slot={media} editor={editor} />
        )}
        <LockedNote slot={media} t={t} />
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
          <p className="mt-1 truncate rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
            {slotIds.join(' · ')}
          </p>
        </div>
        <button
          onClick={onClose}
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

        {stationSlot && (
          <div className="space-y-1.5">
            <p className="text-xs font-medium">{t(`${cm}.modelSource`)}</p>
            {llmPickerGroups.length > 0 || stationSlot.locked ? (
              <ChatSlotPicker
                slot={stationSlot}
                editor={editor}
                groups={llmPickerGroups}
                followLabel={t(`${cm}.followMainline`)}
                followNote={mainModelName}
              />
            ) : (
              <p className="text-[11px] text-muted-foreground">{t(`${cm}.noProviderHint`)}</p>
            )}
          </div>
        )}

        {def.subSlots && def.subSlots.length > 0 && llmPickerGroups.length > 0 && (
          <div className="space-y-2">
            <p className="text-xs font-medium">{t(`${cm}.subStagesTitle`)}</p>
            {def.subSlots.map((sub) => {
              const subSlot = slot(sub.key);
              if (!subSlot) return null;
              return (
                <div key={sub.key} className="space-y-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[11px]">{t(sub.labelKey)}</span>
                    <span className="truncate font-mono text-[9px] text-muted-foreground/70">
                      {sub.key.split('.').pop()}
                    </span>
                  </div>
                  <ChatSlotPicker
                    slot={subSlot}
                    editor={editor}
                    groups={llmPickerGroups}
                    followLabel={t(`${cm}.followParent`)}
                    followNote={
                      refName(view, 'chat', effectiveRef(stationSlot), t) ?? mainModelName
                    }
                  />
                </div>
              );
            })}
          </div>
        )}

        {/* 联网调研：搜索服务 */}
        {def.id === 'web-research' &&
          mediaRow('webSearch', t(`${cm}.searchService`), t(`${cm}.searchService`))}

        {/* 语音合成 */}
        {def.id === 'tts' && mediaRow('tts', t('settings.ttsSettings'), t('settings.enableTTS'))}

        {/* 文档解析：解析服务 + 语音转写 */}
        {def.id === 'doc-parse' && (
          <div className="space-y-3">
            {mediaRow('document', t(`${cm}.parseService`), t(`${cm}.parseService`))}
            {mediaRow('asr', t(`${cm}.asrTranscribe`), t('settings.enableASR'))}
          </div>
        )}

        {/* 媒体生成：配图 + 视频 */}
        {def.id === 'media' && (
          <>
            {mediaRow('image', t(`${cm}.aiIllustration`), t('settings.enableImageGeneration'))}
            {mediaRow('video', t(`${cm}.aiVideo`), t('settings.enableVideoGeneration'))}
          </>
        )}
      </div>
    </aside>
  );
}
