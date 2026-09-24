'use client';

// 共享的 LLM 模型组构建：课程模型配置与首页工具栏的模型选择器共用同一份
// 「可用 provider 过滤 + 套餐组按优先级置顶 + 组内套餐推荐序」逻辑。优先级
// 口径唯一：生效套餐按 TOKEN_PLAN_PRESETS 声明顺序（activeTokenPlansIn
// PriorityOrder），两处消费不允许各自排序。

import { useMemo } from 'react';
import { useSettingsStore } from '@/lib/store/settings';
import { isLLMProviderConfigured } from '@/lib/store/settings-validation';
import { modelIdsMatch } from '@/lib/ai/model-aliases';
import type { ProviderId } from '@/lib/ai/providers';
import type { ModelInfo } from '@/lib/types/provider';
import { TOKEN_PLAN_PRESETS } from '@/lib/config/token-plan-presets';
import { activeTokenPlansInPriorityOrder } from '@/lib/config/apply-token-plan';
import type { ModelPickerGroup } from './model-picker';

/**
 * Token Plan 套餐播种的 LLM provider → 套餐推荐模型序（defaultModels，即官方
 * 推荐顺序）。组内模型按此序排列——即便目录被 /models 探测或旧种子打乱
 * （例如 cogevol 系列始终排最前）。
 *
 * 注意：这里只回答「组内模型怎么排」。组与组之间谁靠前，取决于运行时哪些
 * 套餐真正生效，见 useLLMPickerGroups 里的 planRank。
 */
const TOKEN_PLAN_LLM_PRESETS: ReadonlyMap<string, readonly string[]> = new Map(
  TOKEN_PLAN_PRESETS.flatMap((preset) => {
    const llm = preset.modalities.llm;
    return llm?.defaultModels?.length ? [[llm.providerId, llm.defaultModels] as const] : [];
  }),
);

export interface LLMProviderEntry {
  id: ProviderId;
  name: string;
  models: ModelInfo[];
}

/**
 * 可选的 LLM provider 与模型组。providers 是原始可用列表（供名称解析等
 * 使用）；groups 是选择器直接消费的分组视图（含套餐置顶与推荐序）。
 */
export function useLLMPickerGroups(): {
  groups: ModelPickerGroup[];
  providers: LLMProviderEntry[];
} {
  const providersConfig = useSettingsStore((s) => s.providersConfig);
  const tokenPlanEnrollments = useSettingsStore((s) => s.tokenPlanEnrollments);
  const tokenPlanDisabled = useSettingsStore((s) => s.tokenPlanDisabled);

  // ── 可用 LLM 选项（已配置 provider 的模型目录，带思考能力供选择器渲染） ──
  const providers = useMemo(
    () =>
      Object.entries(providersConfig ?? {})
        .filter(
          ([, config]) =>
            config.enabled !== false && // 授权层「启用此提供方」关闭时不展示
            isLLMProviderConfigured(config),
        )
        .map(([id, config]) => ({
          id: id as ProviderId,
          name: config.name || id,
          models:
            config.isServerConfigured && !config.apiKey && config.serverModels?.length
              ? config.models.filter((model) =>
                  config.serverModels?.some((serverModelId) =>
                    modelIdsMatch(id, model.id, serverModelId),
                  ),
                )
              : config.models,
        })),
    [providersConfig],
  );

  // 生效套餐的 LLM provider → 优先级序号（0 最高）。顺序取自
  // TOKEN_PLAN_PRESETS 的声明顺序，与 Token Plan 列表里看到的上下顺序一致；
  // 被「启用此套餐」关闭或未连接的套餐不进入该表，因此其 provider 在选择
  // 列表中退回普通 provider 的位置。
  const planRank = useMemo(() => {
    const rank = new Map<string, number>();
    activeTokenPlansInPriorityOrder({
      tokenPlanEnrollments,
      providersConfig: providersConfig ?? {},
      tokenPlanDisabled,
    }).forEach((preset, index) => {
      const pid = preset.modalities.llm?.providerId;
      // 同一 provider 被多个套餐声明时，靠前的套餐先落位、不被后者覆盖。
      if (pid && !rank.has(pid)) rank.set(pid, index);
    });
    return rank;
  }, [tokenPlanEnrollments, providersConfig, tokenPlanDisabled]);

  // 套餐 provider 的模型组在选择列表中置顶，多个套餐之间按套餐列表顺序排
  // 列；组内模型按套餐推荐序排列（稳定排序：目录中不在推荐序里的模型保持
  // 原相对顺序排在后面）。
  const groups = useMemo<ModelPickerGroup[]>(
    () =>
      providers
        .map((p) => {
          const recommended = TOKEN_PLAN_LLM_PRESETS.get(p.id);
          const rank = recommended
            ? new Map(recommended.map((id, index) => [id, index] as const))
            : null;
          return {
            id: p.id,
            name: p.name,
            // 「是套餐组」以运行时生效状态为准，而非该 provider 恰好被某个
            // 套餐声明过——关掉的套餐不该继续霸占置顶位。
            isTokenPlan: planRank.has(p.id),
            planRank: planRank.get(p.id) ?? Number.MAX_SAFE_INTEGER,
            models: p.models
              .map((m) => ({
                id: m.id,
                name: m.name,
                thinking: m.capabilities?.thinking,
              }))
              .sort(
                (a, b) =>
                  (rank?.get(a.id) ?? Number.MAX_SAFE_INTEGER) -
                  (rank?.get(b.id) ?? Number.MAX_SAFE_INTEGER),
              ),
          };
        })
        // 稳定排序：套餐组按套餐列表顺序在前，其余保持 provider 原顺序。
        .sort((a, b) => a.planRank - b.planRank),
    [providers, planRank],
  );

  return { groups, providers };
}
