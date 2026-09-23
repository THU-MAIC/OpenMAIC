/**
 * 课程模型配置「站点 → 运行时 stage 键」契约。
 *
 * 一个站点旋钮可以对应多个服务端运行时 stage：课堂互动承诺覆盖多智能体
 * 对话（chat-adapter）、测验批改（quiz-grade）与 PBL 运行时（pbl-v2-runtime，
 * 其 `:instructor` / `:open-task` / `:evaluate` / `:simulator` 复合子键经
 * getUserStageRoute 的冒号父级回溯继承基键）。覆盖该站点时必须把整组键
 * 一起写、恢复跟随时一起清——只写其中一个键会让其余运行时 stage 静默回落
 * 主线模型（PR #1644 review 报告的 P0：课堂互动覆盖对 quiz-grade 与
 * pbl-v2-runtime:instructor 不生效）。
 *
 * 键的合法性由 tests/config/station-stage-keys.test.ts 对照 LLM_STAGES
 * 静态校验，防止两端漂移。
 */
export const STATION_STAGE_KEYS: Record<string, readonly string[]> = {
  'web-research': ['web-search-query-rewrite'],
  outline: ['scene-outlines-stream'],
  agents: ['agent-profiles'],
  'scene-content': ['scene-content'],
  'scene-actions': ['scene-actions'],
  interaction: ['chat-adapter', 'quiz-grade', 'pbl-chat', 'pbl-v2-runtime'],
};
