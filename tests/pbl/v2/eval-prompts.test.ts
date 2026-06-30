/**
 * Tests for the evaluator prompt builders.
 *
 * Focus: the builders correctly read project state (engagement,
 * submissions, prior evals) and assemble {system, user} prompts.
 * We don't assert the exact prose of the markdown system prompts —
 * those are easier to review by reading the .md files directly. We
 * DO assert the language interpolation, evidence presence, and a
 * few must-have fences.
 */
import { describe, expect, it } from 'vitest';
import {
  buildFinalEvalPrompt,
  buildMilestoneEvalPrompt,
  buildTaskEvalPrompt,
  formatProjectEngagementRollup,
  formatProjectSynthesisChecks,
} from '@/lib/pbl/v2/operations/eval-prompts';
import { addSubmission } from '@/lib/pbl/v2/operations/submission';
import { addEvaluation } from '@/lib/pbl/v2/operations/evaluation';
import { recordEvent } from '@/lib/pbl/v2/operations/engagement';
import type {
  PBLEngagementSummary,
  PBLMicrotask,
  PBLMilestone,
  PBLProjectV2,
} from '@/lib/pbl/v2/types';

function mkMicrotask(
  id: string,
  title: string,
  overrides: Partial<PBLMicrotask> = {},
): PBLMicrotask {
  return {
    id,
    title,
    description: `desc-${id}`,
    status: 'completed',
    assignee: 'user',
    hints: ['hint-1', 'hint-2'],
    order: 0,
    ...overrides,
  };
}

function mkMilestone(
  id: string,
  title: string,
  microtasks: PBLMicrotask[],
  overrides: Partial<PBLMilestone> = {},
): PBLMilestone {
  return {
    id,
    title,
    description: `desc-${id}`,
    status: 'completed',
    order: 0,
    microtasks,
    documents: [],
    ...overrides,
  };
}

function mkProject(opts: { language?: string; milestones?: PBLMilestone[] } = {}): PBLProjectV2 {
  return {
    uiPhase: 'workspace',
    title: 'HashMap Word Count',
    description: 'Build a Java word-count tool using HashMap',
    learningObjective: 'Use HashMap key/value patterns',
    proficiency: 'intermediate',
    language: opts.language ?? 'zh-CN',
    tags: [],
    status: 'active',
    roles: [],
    milestones: opts.milestones ?? [],
    submissions: [],
    evaluations: [],
    threads: [],
    engagementEvents: [],
    createdAt: 'ts',
    updatedAt: 'ts',
  };
}

describe('buildTaskEvalPrompt', () => {
  it('emits {system, user} with language interpolated into system block', () => {
    const t = mkMicrotask('t1', '初始化 HashMap');
    const ms = mkMilestone('ms1', 'Setup', [t]);
    const project = mkProject({ language: 'zh-CN', milestones: [ms] });
    const { system, user } = buildTaskEvalPrompt(project, ms, t);
    // The system block came from the .md file with {{language}}
    // substituted. We assert that substitution happened by checking
    // the literal token appears somewhere.
    expect(system).toContain('zh-CN');
    expect(system).not.toContain('{{language}}');
    // The user block carries project + milestone + task context +
    // hints. Submissions section is absent here because we didn't
    // add any (D1-B: this is the case where the caller decides not
    // to invoke task eval at all, but the function still produces a
    // usable prompt if invoked).
    expect(user).toContain('HashMap Word Count');
    expect(user).toContain('Setup');
    expect(user).toContain('初始化 HashMap');
    expect(user).toContain('hint-1');
    expect(user).not.toContain('What the learner produced');
  });

  it('includes only the latest submission section when submissions exist', () => {
    const t = mkMicrotask('t1', '初始化 HashMap');
    const ms = mkMilestone('ms1', 'Setup', [t]);
    const project = mkProject({ milestones: [ms] });
    const older = addSubmission(project, {
      microtaskId: 't1',
      milestoneId: 'ms1',
      kind: 'text',
      content: 'old broken draft',
    });
    const newer = addSubmission(project, {
      microtaskId: 't1',
      milestoneId: 'ms1',
      kind: 'text',
      content: 'Map<String,Integer> m = new HashMap<>();',
    });
    older.createdAt = '2026-05-30T00:00:00.000Z';
    newer.createdAt = '2026-05-30T00:01:00.000Z';
    const { user } = buildTaskEvalPrompt(project, ms, t);
    expect(user).toContain('What the learner produced in the latest submission');
    expect(user).toContain('HashMap<>()');
    expect(user).not.toContain('old broken draft');
  });

  it('keeps prior task evaluations as context without older raw submissions', () => {
    const t = mkMicrotask('t1', '初始化 HashMap');
    const ms = mkMilestone('ms1', 'Setup', [t]);
    const project = mkProject({ milestones: [ms] });
    const older = addSubmission(project, {
      microtaskId: 't1',
      milestoneId: 'ms1',
      kind: 'text',
      content: 'old raw mistake',
    });
    const newer = addSubmission(project, {
      microtaskId: 't1',
      milestoneId: 'ms1',
      kind: 'text',
      content: 'new correct answer',
    });
    older.createdAt = '2026-05-30T00:00:00.000Z';
    newer.createdAt = '2026-05-30T00:01:00.000Z';
    addEvaluation(project, {
      kind: 'task',
      microtaskId: 't1',
      milestoneId: 'ms1',
      feedback: 'older feedback',
      improvements: ['fix the previous draft'],
      score: 45,
    });

    const { user } = buildTaskEvalPrompt(project, ms, t);
    expect(user).toContain('Prior task evaluations for context only');
    expect(user).toContain('score=45/100');
    expect(user).toContain('new correct answer');
    expect(user).not.toContain('old raw mistake');
  });

  it('includes recent-chat-summary when provided', () => {
    const t = mkMicrotask('t1', 't');
    const ms = mkMilestone('ms1', 'm', [t]);
    const project = mkProject({ milestones: [ms] });
    const { user } = buildTaskEvalPrompt(project, ms, t, {
      recentChatSummary: 'learner asked about put()',
    });
    expect(user).toContain('learner asked about put');
  });

  it('treats later microtasks as an exclusion boundary for task improvements', () => {
    const t1 = mkMicrotask('t1', '准备两个手算测试样例', {
      order: 0,
      description: '写出两个可手算的输入和预期结果',
    });
    const t2 = mkMicrotask('t2', '确定双指针起点', {
      order: 1,
      description: '设置 left 和 right 的初始位置',
      status: 'todo',
    });
    const ms = mkMilestone('ms1', '双指针基础', [t1, t2]);
    const project = mkProject({ milestones: [ms] });
    const { system, user } = buildTaskEvalPrompt(project, ms, t1);

    expect(system).toContain('Task-boundary discipline');
    expect(system).toContain('Do not penalize missing work that belongs to a later');
    expect(system).toContain('microtask, next stage, or future extension');
    expect(system).toContain('The `improvements` array');
    expect(system).toContain("THIS completed microtask's deliverable");
    expect(user).toContain('Later microtasks in this milestone — exclusion boundary');
    expect(user).toContain('确定双指针起点');
    expect(user).toContain('Do not mention these later-task requirements as missing work');
    expect(user).toContain('items in `improvements` for the current task');
  });

  it('separates task evaluation prose from strengths and improvements card content', () => {
    const t = mkMicrotask('t1', '提交 HashMap 初始化代码');
    const ms = mkMilestone('ms1', 'Setup', [t]);
    const project = mkProject({ milestones: [ms] });
    const { system } = buildTaskEvalPrompt(project, ms, t);

    expect(system).toContain('Keep prose and card content separate');
    expect(system).toContain('Output ONLY one valid JSON object');
    expect(system).toContain('Do not use ```json fences');
    expect(system).toContain('"feedback": "..."');
    expect(system).toContain('Do not repeat the same point in both places');
    expect(system).toContain('1-2 short sentences');
    expect(system).toContain('neutrally summarize what the learner submitted / demonstrated');
    expect(system).toContain('belong only in the JSON `strengths` and `improvements` arrays');
  });

  it('uses en-US system block when project language is en-US', () => {
    const t = mkMicrotask('t1', 't');
    const ms = mkMilestone('ms1', 'm', [t]);
    const project = mkProject({ language: 'en-US', milestones: [ms] });
    const { system } = buildTaskEvalPrompt(project, ms, t);
    expect(system).toContain('en-US');
  });
});

describe('buildMilestoneEvalPrompt', () => {
  it('includes per-microtask telemetry from cached engagement when present', () => {
    const cached: PBLEngagementSummary = {
      durationSeconds: 240,
      learnerTurnCount: 6,
      errorCount: 2,
      repeatErrorCount: 1,
      errorSignatures: ['null_check'],
      conceptsUnlocked: ['hashmap_put'],
      struggles: ['confused about key type'],
      closingQuality: 'ok',
      closingAnswer: '我用 put 存进去的',
    };
    const t = mkMicrotask('t1', '初始化', { engagement: cached });
    const ms = mkMilestone('ms1', 'Setup', [t]);
    const project = mkProject({ milestones: [ms] });
    const { user } = buildMilestoneEvalPrompt(project, ms);
    expect(user).toContain('time on task: 240s');
    expect(user).toContain('learner messages: 6');
    expect(user).toContain('errors seen: 2, 1 repeated');
    expect(user).toContain('hashmap_put');
    expect(user).toContain('closing check: quality=ok');
  });

  it('falls back to live ledger when no cached engagement', () => {
    const t = mkMicrotask('t1', '初始化', { engagement: undefined });
    const ms = mkMilestone('ms1', 'Setup', [t]);
    const project = mkProject({ milestones: [ms] });
    recordEvent(project, 'microtask_opened', {
      microtaskId: 't1',
      milestoneId: 'ms1',
    });
    recordEvent(project, 'learner_turn', { microtaskId: 't1' });
    recordEvent(project, 'learner_turn', { microtaskId: 't1' });
    const { user } = buildMilestoneEvalPrompt(project, ms);
    expect(user).toContain('learner messages: 2');
  });

  it('includes task-eval recap when a task evaluation exists', () => {
    const t = mkMicrotask('t1', 't');
    const ms = mkMilestone('ms1', 'm', [t]);
    const project = mkProject({ milestones: [ms] });
    addEvaluation(project, {
      kind: 'task',
      microtaskId: 't1',
      milestoneId: 'ms1',
      feedback: '...',
      strengths: ['clean code'],
      improvements: ['add comments'],
      score: 80,
    });
    const { user } = buildMilestoneEvalPrompt(project, ms);
    expect(user).toContain('Task eval recap');
    expect(user).toContain('strengths=clean code');
    expect(user).toContain('growth-edges=add comments');
  });

  it('language interpolates into milestone system block', () => {
    const t = mkMicrotask('t1', 't');
    const ms = mkMilestone('ms1', 'm', [t]);
    const project = mkProject({ language: 'ja-JP', milestones: [ms] });
    const { system } = buildMilestoneEvalPrompt(project, ms);
    expect(system).toContain('ja-JP');
    expect(system).not.toContain('{{language}}');
    expect(system).toContain('Output ONLY one valid JSON object');
    expect(system).toContain('"feedback": "..."');
    expect(system).toContain('Do not use ```json fences');
  });

  it('milestone system block forbids opening the next stage before Continue', () => {
    const t = mkMicrotask('t1', 't');
    const ms = mkMilestone('ms1', 'm', [t]);
    const project = mkProject({ milestones: [ms] });
    const { system } = buildMilestoneEvalPrompt(project, ms);

    expect(system).toContain('Continue');
    expect(system).toContain('first microtask');
    expect(system).toContain('clicks Continue');
  });
});

describe('formatProjectEngagementRollup', () => {
  it('aggregates totals across milestones', () => {
    const t1 = mkMicrotask('t1', 'A', {
      status: 'completed',
      engagement: {
        durationSeconds: 60,
        learnerTurnCount: 3,
        errorCount: 1,
        repeatErrorCount: 0,
        conceptsUnlocked: ['c1'],
        closingQuality: 'strong',
      },
    });
    const t2 = mkMicrotask('t2', 'B', {
      status: 'completed',
      engagement: {
        durationSeconds: 120,
        learnerTurnCount: 4,
        errorCount: 3,
        repeatErrorCount: 2,
        conceptsUnlocked: ['c2'],
        closingQuality: 'weak',
      },
    });
    const ms = mkMilestone('ms1', 'M1', [t1, t2]);
    const project = mkProject({ milestones: [ms] });
    const rollup = formatProjectEngagementRollup(project);
    expect(rollup).toContain('Wall time: ~3 min');
    expect(rollup).toContain('Learner turns: 7');
    expect(rollup).toContain('Microtasks completed: 2');
    expect(rollup).toContain('Errors hit: 4');
    expect(rollup).toContain('repeats: 2');
    expect(rollup).toContain('weak=1, ok=0, strong=1');
    expect(rollup).toContain('c1, c2');
    // Per-milestone line check
    expect(rollup).toContain('- M1 [completed] · 2/2 tasks');
  });

  it('handles empty project gracefully', () => {
    const project = mkProject({ milestones: [] });
    const rollup = formatProjectEngagementRollup(project);
    expect(rollup).toContain('Wall time: ~0 min');
    expect(rollup).toContain('Microtasks completed: 0');
  });
});

describe('formatProjectSynthesisChecks', () => {
  it('includes recorded stage synthesis question, learner answer, concept, and quality', () => {
    const t = mkMicrotask('t1', '收束核心概念');
    const ms = mkMilestone('ms1', '核心阶段', [t], {
      synthesisCheck: { coreConcept: '为什么循环可以避免重复代码' },
    });
    const project = mkProject({ milestones: [ms] });
    recordEvent(project, 'stage_synthesis_check', {
      microtaskId: 't1',
      milestoneId: 'ms1',
      payload: {
        coreConcept: '循环与重复逻辑',
        question: '回头看整个阶段，循环解决了什么问题？',
        learner_answer: '它把重复动作放进同一个结构里，条件满足时继续执行。',
        quality: 'strong',
      },
    });

    const checks = formatProjectSynthesisChecks(project);
    expect(checks).toContain('核心阶段');
    expect(checks).toContain('循环与重复逻辑');
    expect(checks).toContain('回头看整个阶段');
    expect(checks).toContain('它把重复动作放进同一个结构里');
    expect(checks).toContain('quality: strong');
    expect(checks).toContain('source: stage_synthesis_check');
  });

  it('falls back to a closing_check on the final microtask for older records', () => {
    const early = mkMicrotask('t1', '铺垫', { order: 0 });
    const last = mkMicrotask('t2', '整合', { order: 1 });
    const ms = mkMilestone('ms1', '核心阶段', [early, last], {
      synthesisCheck: { coreConcept: '哈希查找为什么快' },
    });
    const project = mkProject({ milestones: [ms] });
    recordEvent(project, 'closing_check', {
      microtaskId: 't2',
      milestoneId: 'ms1',
      payload: {
        question: '为什么 HashMap 查找通常很快？',
        learner_answer: '因为 key 会被映射到位置，不用一个个遍历。',
        quality: 'ok',
      },
    });

    const checks = formatProjectSynthesisChecks(project);
    expect(checks).toContain('哈希查找为什么快');
    expect(checks).toContain('为什么 HashMap 查找通常很快');
    expect(checks).toContain('不用一个个遍历');
    expect(checks).toContain('quality: ok');
    expect(checks).toContain('source: closing_check on final microtask');
  });

  it('does not invent an answer when a core milestone has no synthesis record', () => {
    const t = mkMicrotask('t1', '收束核心概念');
    const ms = mkMilestone('ms1', '核心阶段', [t], {
      synthesisCheck: { coreConcept: '变量如何保存状态' },
    });
    const project = mkProject({ milestones: [ms] });

    const checks = formatProjectSynthesisChecks(project);
    expect(checks).toContain('核心阶段');
    expect(checks).toContain('变量如何保存状态');
    expect(checks).toContain('no learner answer recorded');
  });
});

describe('buildFinalEvalPrompt', () => {
  it('emits {system, user} with per-milestone recap + analytics rollup', () => {
    const t = mkMicrotask('t1', 't');
    const ms = mkMilestone('ms1', 'M1', [t]);
    const project = mkProject({ milestones: [ms] });
    addEvaluation(project, {
      kind: 'milestone',
      milestoneId: 'ms1',
      feedback: '阶段完成的反思...',
      strengths: ['理解了 HashMap', '能调试'],
      improvements: [],
      stars: 4.5,
    });
    const { system, user } = buildFinalEvalPrompt(project);
    expect(system).toContain('zh-CN');
    expect(user).toContain('Per-milestone reflection cards');
    expect(user).toContain('4.5★');
    expect(user).toContain('learned: 理解了 HashMap');
    expect(user).toContain('Engagement rollup');
  });

  it('feeds integrative stage-check evidence to the final evaluator', () => {
    const t = mkMicrotask('t1', '整合阶段理解');
    const ms = mkMilestone('ms1', '核心阶段', [t], {
      synthesisCheck: { coreConcept: '循环如何表达重复过程' },
    });
    const project = mkProject({ milestones: [ms] });
    recordEvent(project, 'stage_synthesis_check', {
      microtaskId: 't1',
      milestoneId: 'ms1',
      payload: {
        question: '把整个阶段连起来看，循环帮你表达了什么？',
        learner_answer: '循环让我把同样的步骤放进一段代码里反复执行。',
        quality: 'strong',
      },
    });

    const { system, user } = buildFinalEvalPrompt(project);
    expect(system).toContain('Integrative checks');
    expect(system).toContain('explicitly');
    expect(system).toContain('praise');
    expect(system).toContain('Output ONLY one valid JSON object');
    expect(system).toContain('"feedback": "..."');
    expect(system).toContain('what_you_learned');
    expect(user).toContain('## Integrative checks (stage synthesis)');
    expect(user).toContain('循环如何表达重复过程');
    expect(user).toContain('把整个阶段连起来看');
    expect(user).toContain('同样的步骤放进一段代码里反复执行');
    expect(user).toContain('quality: strong');
  });

  it('handles milestones with no prior milestone eval', () => {
    const t = mkMicrotask('t1', 't');
    const ms = mkMilestone('ms1', 'M1', [t]);
    const project = mkProject({ milestones: [ms] });
    const { user } = buildFinalEvalPrompt(project);
    expect(user).toContain('(no milestone evaluation recorded)');
  });
});

// ---------------------------------------------------------------------------
// SCENARIO (role-play) — increment 6
// ---------------------------------------------------------------------------

function mkScenarioProject(): PBLProjectV2 {
  const beat1 = mkMicrotask('beat-1', '翻前决策', {
    successWhen: '做出 preflop 决定：跟注、加注或弃牌',
    skillFocus: '翻前手牌选择',
  });
  const beat2 = mkMicrotask('beat-2', '翻后决策', {
    successWhen: '在 flop 后做出下注决定',
    skillFocus: '翻后下注',
  });
  const roleplay = mkMilestone('ms-rp', '第一手牌', [beat1, beat2], { scenarioStage: 'roleplay' });
  const project = mkProject({ milestones: [roleplay] });
  project.scenario = {
    setting: '德州扑克新手现金桌',
    goal: '练习翻前/翻后的下注决策',
    rules: '德州扑克基本规则',
    learnerRole: '你是按钮位玩家',
    characters: [{ id: 'c1', name: '老周', persona: '老练牌手' }],
  };
  project.threads = [
    {
      agentId: 'simulator',
      messages: [
        { id: 'm1', roleType: 'system', content: '牌桌灯光微暗，第一手刚发下。', ts: 't' },
        { id: 'm2', roleType: 'simulator', characterId: 'c1', content: '轮到你了。', ts: 't' },
        { id: 'm3', roleType: 'user', content: '我加注到 11。', ts: 't' },
      ],
    },
  ];
  return project;
}

describe('buildFinalEvalPrompt — scenario branch (6b)', () => {
  it('uses the scenario prompt + transcript + act goals for a role-play project', () => {
    const { system, user } = buildFinalEvalPrompt(mkScenarioProject());
    expect(system).toContain('zh-CN');
    expect(system).not.toContain('{{language}}');
    // scenario-specific evidence, NOT the knowledge-recap rollup
    expect(user).toContain('## The scenario');
    expect(user).toContain('How it actually went');
    expect(user).toContain('act goals to assess');
    expect(user).toContain('Learner: 我加注到 11。');
    expect(user).toContain('老周:');
    expect(user).toContain('练习翻前/翻后的下注决策');
    // must NOT carry the ordinary knowledge-eval scaffolding
    expect(user).not.toContain('Per-milestone reflection cards');
    expect(user).not.toContain('Engagement rollup (from the analytics ledger)');
  });

  it('does NOT change the prompt for ordinary (non-scenario) projects', () => {
    const t = mkMicrotask('t1', 't');
    const ms = mkMilestone('ms1', 'M1', [t]);
    const project = mkProject({ milestones: [ms] });
    const { user } = buildFinalEvalPrompt(project);
    expect(user).toContain('Per-milestone reflection cards');
    expect(user).toContain('Engagement rollup');
    expect(user).not.toContain('## The scenario');
  });
});
