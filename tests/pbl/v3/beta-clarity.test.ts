import { readFileSync } from 'node:fs';
import { createInstance } from 'i18next';
import { describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
import { installedProject } from '@/lib/server/pbl-v3/catalog';
import { startOrchestration } from '@/lib/pbl/v3/domain/orchestration/transition';
import { continueActionLabel } from '@/lib/pbl/v3/presentation';
import { visibleProductLabels } from '@/lib/server/pbl-v3/ui-labels';
import { teachingProductContext } from '@/lib/server/pbl-v3/product-context';
import { renderTeachingPrompt, teachingSection } from '@/lib/server/pbl-v3/teaching-prompt';
import {
  learnerExpressionRules,
  planPresentationRules,
  stageSkill,
} from '@/lib/server/pbl-v3/skills';
import type { TeachingPromptInput } from '@/lib/server/pbl-v3/teaching-prompt';
import { reviewResponse } from '@/lib/server/pbl-v3/review-question';

const definition = installedProject({ id: 'greeting-python', version: '1.0.0' }).definition;
function fixture(index: number): TeachingPromptInput {
  const state = startOrchestration(definition).state;
  state.position.stageIndex = index;
  const milestone = definition.milestones[0]!;
  const stage = milestone.stages[index]!;
  return {
    definition,
    stage,
    milestone,
    role: 'agent' in stage ? stage.agent : 'mentor',
    stageKey: `${milestone.id}:${index}`,
    collected: state.collected[milestone.id]!,
    skill: { ...stageSkill(stage), documents: [] },
    packaged: false,
    communication: { uiLocale: 'zh-CN', responseLanguage: null },
    workspace: {
      state,
      evaluation: null,
      environment: { state: 'running', ready: true },
      observedFiles: [],
      completeFileList: false,
      buildAvailable: true,
      tools: [],
    },
  };
}

describe('learner-facing actions', () => {
  it('uses the same real destination label in Chinese UI hints and live Agent context for every step', async () => {
    const zh = JSON.parse(readFileSync('lib/i18n/locales/zh-CN.json', 'utf8'));
    const i18n = createInstance();
    await i18n.init({ lng: 'zh-CN', resources: { 'zh-CN': { translation: zh } } });
    expect(visibleProductLabels('zh-CN')).toMatchObject({
      task: '当前任务',
      submitDecision: '提交决策',
      runTests: '运行测试',
      submitQuiz: '提交答案',
    });
    const expected = [
      '进入讨论并提交决策',
      '进入理解与审阅计划',
      '进入理解与审阅实现',
      '进入测试与修复',
      '进入检验理解',
      '进入复盘本阶段',
      '继续',
    ];
    for (let index = 0; index < expected.length; index++) {
      const input = fixture(index);
      const view = {
        state: input.workspace!.state,
        milestones: [
          {
            ...input.milestone,
            stages: ['teaching', 'dialogue', 'plan', 'code', 'tests', 'quiz', 'recap'],
          },
        ],
      };
      const action = continueActionLabel(view, i18n.t);
      expect(action).toBe(expected[index]);
      const context = teachingProductContext({ ...input, uiLocale: 'zh-CN' });
      expect(context.visibleLabels.continue).toBe(action);
      expect(context.labels.continue.zh).toBe(action);
      expect(i18n.t('pblV3.journey.ready', { action })).toContain(`“${action}”`);
      expect(i18n.t('pblV3.testResult.hints.passed', { action })).toContain(`“${action}”`);
    }
    // Historical completion messages must not claim a button for a different/current stage.
    expect(i18n.t('pblV3.journey.completionHandoff')).toBe(
      '本环节已完成。下一步操作请看学习助手底部的任务栏。',
    );
    expect(teachingProductContext(fixture(0)).current.continueAvailableAfterReply).toBe(false);
    const completed = fixture(0);
    completed.collected.teachingCompleted = true;
    expect(
      teachingProductContext({ ...completed, completionRecorded: true }).current
        .continueAvailableAfterReply,
    ).toBe(true);
  });

  it('retains generic navigation at milestone boundaries and tolerates older views without stage labels', () => {
    const input = fixture(6);
    const t = (key: string) => key;
    expect(continueActionLabel({ state: input.workspace!.state }, t)).toBe('pblV3.next');
    expect(visibleProductLabels('unknown').continue).toBe(visibleProductLabels('en-US').continue);
  });

  it('keeps existing locale fallbacks structurally compatible with dynamic action names', async () => {
    for (const locale of [
      'ar-SA',
      'de-DE',
      'en-US',
      'es-MX',
      'fr-FR',
      'ja-JP',
      'ko-KR',
      'pt-BR',
      'ru-RU',
      'vi-VN',
      'zh-TW',
    ]) {
      const data = JSON.parse(readFileSync(`lib/i18n/locales/${locale}.json`, 'utf8'));
      const i18n = createInstance();
      await i18n.init({ lng: locale, resources: { [locale]: { translation: data } } });
      const input = fixture(0);
      const action = continueActionLabel(
        {
          state: input.workspace!.state,
          milestones: [{ ...input.milestone, stages: ['teaching', 'dialogue'] }],
        },
        i18n.t,
      );
      expect(action).toBe(visibleProductLabels(locale, 'dialogue').continue);
      expect(i18n.t('pblV3.journey.ready', { action })).toContain(action);
      expect(i18n.t('pblV3.journey.ready', { action })).not.toContain('{{action}}');
    }
  });
});

describe('selective task emphasis and readable plans', () => {
  const question = '**请看看这两处是否符合你的计划；没有想改的就回复认可当前版本。**';
  const explanation = '两个函数写好了，编译检查也通过了。';

  it.each(['\n\n', '\r\n\r\n', '\n \n'])(
    'records the final question from one complete response (separator %j)',
    (separator) => {
      const complete = `${explanation}${separator}${question}`;
      expect(reviewResponse(complete)).toEqual({ response: complete, question });
      expect(reviewResponse(`  ${complete}\n`)).toEqual({ response: complete, question });
      expect(reviewResponse(question)).toEqual({ response: question, question });
    },
  );

  it('does not rewrite, compare or append prose when recording a complete reply', () => {
    const paraphrase = '**没有其他想改的地方，就告诉我你认可这一版。**';
    for (const body of [
      `${explanation}\n\n${paraphrase}`,
      `> ${question}\n\n引用的是之前的问题。\n\n${paraphrase}`,
      `\`\`\`text\n${question}\n\`\`\`\n\n${paraphrase}`,
      `Example:\n\n    ${question}\n\n${paraphrase}`,
      `Example:\n\n\t${question}\n\n${paraphrase}`,
      `Example:\n\n    ${question}\n\n${question}`,
    ])
      expect(reviewResponse(body)).toEqual({
        response: body,
        question: body.endsWith(paraphrase) ? paraphrase : question,
      });
    expect(() => reviewResponse(' \n')).toThrow('complete review response');
  });

  it('applies action formatting to all roles while retaining teaching order, single handoff and control-only assessments', () => {
    for (let index = 0; index < 7; index++) {
      const input = fixture(index);
      const prompt = renderTeachingPrompt(input).systemPrompt;
      expect(prompt).toContain(learnerExpressionRules);
      expect(prompt).toContain('不强制添加行动段');
      expect(prompt).toContain('只提交一份完整回复');
      if (input.stage.kind === 'check') {
        expect(prompt).toContain('do not require any chat answer');
        expect(prompt).toContain(
          'Never read_next_skill, request_skill_review or complete_stage here',
        );
      }
      if (index === 0) expect(prompt).toContain('first state what the learner will accomplish');
    }
  });

  it('overlays plan readability on packaged Skills without weakening version/decision contracts or affecting other stages', () => {
    const input = fixture(2);
    input.packaged = true;
    input.skill.content = {
      'SKILL.md': 'Course-specific plan constraints',
      'A-plan.md': 'Preserve my supplied interfaces.',
    };
    input.skill.progression = ['SKILL.md', 'A-plan.md'];
    const section = teachingSection(input, 'A-plan.md');
    expect(section.instruction).toBe('Preserve my supplied interfaces.');
    expect(section.delivery).toContain(planPresentationRules);
    const prompt = renderTeachingPrompt(input).systemPrompt;
    expect(prompt).toContain(planPresentationRules);
    expect(prompt).toContain('已批准的前序章节必须原样保留');
    expect(prompt).toContain('哈希校验、审阅、当前版本批准或正式测试');
    for (const index of [0, 1, 3, 4, 5, 6])
      expect(renderTeachingPrompt(fixture(index)).systemPrompt).not.toContain(
        planPresentationRules,
      );
  });
});
