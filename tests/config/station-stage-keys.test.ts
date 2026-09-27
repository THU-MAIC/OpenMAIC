import { describe, expect, it } from 'vitest';
import { STATION_STAGE_KEYS } from '@/lib/config/station-stage-keys';
import { getUserStageRoute, LLM_STAGES, type UserStageRoute } from '@/lib/server/model-routes';

/**
 * PR #1644 review P0 回归：课堂互动站点此前只写 `chat-adapter`，而服务端的
 * quiz-grade / pbl-v2-runtime:* 解析不到该覆盖，静默回落主线模型。本文件锁
 * 两件事：
 * 1. 契约里的每个 stage 键都是合法的 LLM_STAGES 成员（UI 与服务端不漂移）；
 * 2. 按互动站点键集写入路由后，所有承诺覆盖的运行时 stage 都解析到该路由
 *    ——含 pbl-v2-runtime 复合子键经冒号父级回溯继承基键。
 */

const interactionRoute: UserStageRoute = { model: 'minimax-m2.7' };

/**
 * Stages intentionally not covered by any Course Model Config station. Each
 * exception is deliberate, not a missed knob:
 * - conversation-title: reuses the agent-driver connection, not a course stage;
 * - generate-classroom / maic-agent: mainline / legacy entry points;
 * - maic-agent-driver: operator-only. It is resolved exclusively from the
 *   operator's MODEL_ROUTES (with an explicit api dialect and contextWindow) in
 *   agent-runtime/agent-driver-model.ts, so the UI deliberately offers no
 *   user-level override for it.
 */
const STAGES_WITHOUT_A_STATION = [
  'conversation-title',
  'generate-classroom',
  'maic-agent',
  'maic-agent-driver',
] as const;

/** 模拟 UI 写入：互动站点覆盖时整组键一起落同一个路由。 */
function routesFor(keys: readonly string[]): Record<string, UserStageRoute> {
  const routes: Record<string, UserStageRoute> = {};
  for (const key of keys) routes[key] = { ...interactionRoute };
  return routes;
}

describe('station stage keys contract', () => {
  it('每个站点的 stage 键都是 LLM_STAGES 成员', () => {
    for (const [station, keys] of Object.entries(STATION_STAGE_KEYS)) {
      for (const key of keys) {
        expect(LLM_STAGES).toContain(key);
      }
      expect(keys.length, `${station} 至少声明一个键`).toBeGreaterThan(0);
    }
  });

  it('所有 LLM 站点的运行时 stage 都被某个站点覆盖（无孤儿 stage 暗藏同类 P0）', () => {
    const covered = new Set(Object.values(STATION_STAGE_KEYS).flat());
    // 这些 stage 要么被站点直接覆盖、要么经复合回溯从覆盖到的父键继承。
    const coveredWithFallback = new Set(covered);
    for (const stage of LLM_STAGES) {
      let key: string | undefined = stage;
      while (key) {
        if (covered.has(key)) {
          coveredWithFallback.add(stage);
          break;
        }
        const lastColon = key.lastIndexOf(':');
        key = lastColon > 0 ? key.slice(0, lastColon) : undefined;
      }
    }
    const uncovered = LLM_STAGES.filter((stage) => !coveredWithFallback.has(stage));
    expect(uncovered.sort()).toEqual([...STAGES_WITHOUT_A_STATION].sort());
  });

  it('does not expose the operator-only agent driver as a user override', () => {
    const covered = new Set(Object.values(STATION_STAGE_KEYS).flat());
    expect(covered.has('maic-agent-driver')).toBe(false);
  });
});

describe('classroom interaction override reaches every runtime stage (review P0)', () => {
  const routes = routesFor(STATION_STAGE_KEYS.interaction);

  it.each([
    'chat-adapter',
    'quiz-grade',
    'pbl-chat',
    'pbl-v2-runtime',
    'pbl-v2-runtime:instructor',
    'pbl-v2-runtime:open-task',
    'pbl-v2-runtime:evaluate',
    'pbl-v2-runtime:simulator',
  ])('互动覆盖对 %s 生效', (stage) => {
    expect(getUserStageRoute(routes, stage)).toEqual(interactionRoute);
  });

  it('未覆盖互动时全部回落（跟随主线）', () => {
    for (const stage of ['chat-adapter', 'quiz-grade', 'pbl-v2-runtime:instructor']) {
      expect(getUserStageRoute({}, stage)).toBeUndefined();
    }
  });

  it('场景内容的复合子键仍从父键继承（既有回退语义不受影响）', () => {
    const sceneRoutes = routesFor(['scene-content']);
    expect(getUserStageRoute(sceneRoutes, 'scene-content:quiz')).toEqual(interactionRoute);
    // 子键显式覆盖优先于父键（reviewer 要求保留的优先级语义）。
    const withSub = {
      ...sceneRoutes,
      'scene-content:quiz': { model: 'cogevol-base' },
    };
    expect(getUserStageRoute(withSub, 'scene-content:quiz')?.model).toBe('cogevol-base');
    expect(getUserStageRoute(withSub, 'scene-content:slide')?.model).toBe('minimax-m2.7');
  });
});
