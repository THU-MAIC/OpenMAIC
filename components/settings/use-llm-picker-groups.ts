'use client';

// 共享的 LLM 模型组构建：课程模型配置与首页工具栏的模型选择器共用同一份
// 「工作区可用的语言模型服务 + 套餐组置顶 + 组内套餐推荐序」逻辑。服务与模型
// 来自服务端的模型设置视图（/api/model-config），浏览器不保存任何 provider。

import { useMemo } from 'react';
import { TOKEN_PLAN_PRESETS } from '@/lib/config/token-plan-presets';
import { tokenPlanPresetId } from '@/lib/config/preset-ids';
import type { ModelSettingsView } from '@/lib/model-settings/client';
import { providerLabel, providersFor } from '@/lib/model-settings/edit';
import type { ModelPickerGroup } from './model-picker';

/** Each plan's preset id → its rank (the Token Plan list order) and recommended model order. */
const PLAN_ORDER: ReadonlyMap<string, { rank: number; models: readonly string[] }> = new Map(
  TOKEN_PLAN_PRESETS.map((plan, rank) => [
    tokenPlanPresetId(plan.id),
    { rank, models: plan.modalities.llm?.defaultModels ?? [] },
  ]),
);

/**
 * The language model groups of a model settings view: one per provider that
 * serves chat (the server's and the workspace's), plans first in the Token
 * Plan order, each plan's models in its recommended order.
 */
export function llmPickerGroups(view: ModelSettingsView | null): ModelPickerGroup[] {
  if (!view) return [];
  return providersFor(view, 'chat')
    .map((provider, index) => {
      const plan = PLAN_ORDER.get(provider.preset);
      const rank = plan ? new Map(plan.models.map((id, i) => [id, i] as const)) : null;
      return {
        index,
        group: {
          id: provider.id,
          name: providerLabel(view, provider.id),
          isTokenPlan: !!plan,
          planRank: plan?.rank ?? Number.MAX_SAFE_INTEGER,
          models: (provider.capabilities.chat?.models ?? [])
            .map((model) => ({
              id: model.id,
              name: model.name,
              thinking: model.capabilities?.thinking,
            }))
            .sort(
              (a, b) =>
                (rank?.get(a.id) ?? Number.MAX_SAFE_INTEGER) -
                (rank?.get(b.id) ?? Number.MAX_SAFE_INTEGER),
            ),
        } satisfies ModelPickerGroup & { planRank: number },
      };
    })
    .sort((a, b) => a.group.planRank - b.group.planRank || a.index - b.index)
    .map(({ group: { planRank: _planRank, ...group } }) => group);
}

/** {@link llmPickerGroups}, memoized for a view. */
export function useLLMPickerGroups(view: ModelSettingsView | null): ModelPickerGroup[] {
  return useMemo(() => llmPickerGroups(view), [view]);
}
