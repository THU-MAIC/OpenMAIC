/**
 * Calibration: where the planner's defaults disagree with a lesson a person
 * actually taught.
 *
 * The point is not to make the model imitate one deck. It is to find the
 * defaults that are *wrong about the medium* — a page count that cannot fill an
 * hour, a module so long nobody could hold it — and move only those. A row that
 * sits inside its tolerance is evidence the default was already right, and is
 * recorded so a later change that breaks it shows up immediately.
 */

import {
  DEFAULT_SCENE_DENSITY,
  buildLongFormBrief,
  planLongFormCourse,
  SPEECH_DENSITY,
  speechRateFor,
} from '@/lib/generation/long-form';

import type { CalibrationReport, CalibrationRow, DeckMetrics } from '../types';
import { measureDeck } from './deck';

/**
 * Modules a reader would actually experience as modules: a run of two or more
 * pages. A one-page section is a topic label on a page, not a unit of teaching,
 * and counting it as a module would flatter the granularity comparison.
 */
function multiPageUnits(fixture: Parameters<typeof measureDeck>[0]) {
  const units = fixture.units.filter((unit) => unit.pages >= 2);
  return {
    count: units.length,
    maxMinutes: Math.max(...units.map((unit) => unit.minutes)),
    minMinutes: Math.min(...units.map((unit) => unit.minutes)),
    meanMinutes: units.reduce((acc, unit) => acc + unit.minutes, 0) / Math.max(1, units.length),
  };
}

function row(
  key: string,
  label: string,
  human: number,
  model: number,
  unit: string,
  tolerance: number,
  note: string,
  verdict?: CalibrationRow['verdict'],
): CalibrationRow {
  const resolved =
    verdict ?? (Math.abs(human - model) <= tolerance ? 'match' : ('adjust' as const));
  return { key, label, human, model, unit, tolerance, verdict: resolved, note };
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function calibrate(
  fixture: Parameters<typeof measureDeck>[0],
  fixtureName: string,
): CalibrationReport {
  const deck: DeckMetrics = measureDeck(fixture);
  const plan = planLongFormCourse({ minutes: deck.minutes, language: 'zh' });
  const units = multiPageUnits(fixture);

  const modelMinutesPerPage = plan.minutes / plan.scenes.length;
  const modelMaxModule = Math.max(...plan.modules.map((module) => module.durationMinutes));
  const modelMinModule = Math.min(...plan.modules.map((module) => module.durationMinutes));

  // What a verbatim script for this hour would have to contain, against what
  // the designer's cue notes actually contain.
  const verbatimCharsPerMinute = Math.round(speechRateFor('zh') * SPEECH_DENSITY);
  const expansion = verbatimCharsPerMinute / deck.cueCharsPerMinute;

  // The two page-level contracts are not planner arithmetic — they are things
  // the long-form brief either asks the model for or does not. Checking the
  // rendered brief keeps the row honest: it fails if the requirement is ever
  // dropped from the prompt.
  const brief = buildLongFormBrief(plan);
  const requiresObjective = /teachingObjective/.test(brief) ? 1 : 0;
  const requiresTransition = /hands forward/.test(brief) ? 1 : 0;

  const rows: CalibrationRow[] = [
    row(
      'minutesPerPage',
      '每页分钟',
      round(deck.minutesPerPage),
      round(modelMinutesPerPage),
      'min',
      0.4,
      '长课的核心密度：低于 1.8 分钟/页就会退化成念页。',
    ),
    row(
      'pages',
      '总页数',
      deck.pages,
      plan.scenes.length,
      '页',
      4,
      `页密度 ${DEFAULT_SCENE_DENSITY} 页/分钟 的实际产出。`,
    ),
    row(
      'modules',
      '模块数（多页单元）',
      units.count,
      plan.modules.length,
      '个',
      1,
      '真人用 7 个多页单元讲完 61 分钟；模型按 ~8.5 分钟切一个模块。',
    ),
    row(
      'maxModuleMinutes',
      '最长模块',
      units.maxMinutes,
      modelMaxModule,
      'min',
      3,
      '单模块超过 ~12 分钟，学习者就无法把它当一个整体记住。',
    ),
    row(
      'minModuleMinutes',
      '最短模块',
      units.minMinutes,
      modelMinModule,
      'min',
      3,
      '真人的短单元只放 1-2 页，但仍是独立的教学动作。',
    ),
    row(
      'purposeCoverage',
      '每页教学目标覆盖率',
      round(deck.purposeCoverage, 2),
      requiresObjective,
      '比例',
      0.2,
      '真人 28/28 页都写了 purpose；长课 brief 的第 7 条要求每页填 teachingObjective。',
    ),
    row(
      'transitionCoverage',
      '每页过渡句覆盖率',
      round(deck.transitionCoverage, 2),
      requiresTransition,
      '比例',
      0.2,
      '真人 28/28 页都写了 transition；长课 brief 的第 8 条要求每页 description 以交棒句收尾。',
    ),
    row(
      'charsPerMinute',
      '每分钟讲稿字数',
      round(deck.cueCharsPerMinute),
      verbatimCharsPerMinute,
      '字',
      0,
      `真人写的是讲稿提示（cue），按逐字稿折算需 ×${round(expansion, 1)}；模型预算的是逐字稿本身，不要往下调。`,
      'info',
    ),
    row(
      'segmentsPerPage',
      '每页讲话段数',
      round(deck.talkSegmentsPerPage, 1),
      12.5,
      '段',
      0,
      '真人 3.4 段 cue（每段临场展开）；模型要求 9-16 个 action/text 对象，其中约一半是 spotlight 等动作，纯讲话段约 5-8 段。',
      'info',
    ),
  ];

  const dispersion = deck.pageMinutes.stdDev / deck.pageMinutes.mean;
  const structuralScores = [
    {
      dimension: 'D2 结构与节奏',
      score: dispersion <= 0.3 && deck.retrievalPages >= 2 ? 4 : 3,
      reason: `页时长变异系数 ${round(dispersion)}，检索页 ${deck.retrievalPages} 个（代理指标），单元 ${units.count} 个 / 4-${units.maxMinutes} 分钟。`,
    },
    {
      dimension: 'D6 评估与反馈',
      score: deck.retrievalPages === 0 ? 1 : deck.retrievalPages < 3 ? 2 : 3,
      reason: `全篇无 quiz 页，检索只靠口头提问（${deck.retrievalPages} 页命中检索词）。真人长课的普遍短板。`,
    },
    {
      dimension: 'D7 连贯性与记忆锚',
      score: deck.transitionCoverage >= 0.95 ? 5 : 3,
      reason: `每页过渡句覆盖率 ${Math.round(deck.transitionCoverage * 100)}%，开场埋的"阿片受体"主线在收束页闭合。`,
    },
  ];

  const findings = buildFindings(deck, plan, units, expansion, {
    requiresObjective: requiresObjective === 1,
    requiresTransition: requiresTransition === 1,
  });

  return {
    fixture: fixtureName,
    title: fixture.meta.title,
    deck,
    rows,
    structuralScores,
    findings,
  };
}

function buildFindings(
  deck: DeckMetrics,
  plan: ReturnType<typeof planLongFormCourse>,
  units: ReturnType<typeof multiPageUnits>,
  expansion: number,
  contract: { requiresObjective: boolean; requiresTransition: boolean },
): string[] {
  const findings: string[] = [];

  const pageDrift = Math.abs(plan.scenes.length - deck.pages) / deck.pages;
  findings.push(
    pageDrift <= 0.15
      ? `页密度校准通过：模型 ${plan.scenes.length} 页 / 真人 ${deck.pages} 页，偏差 ${Math.round(pageDrift * 100)}%。0.45 页/分钟这个默认值是对的。`
      : `页密度偏差 ${Math.round(pageDrift * 100)}%：模型 ${plan.scenes.length} 页 / 真人 ${deck.pages} 页，需要复核 DEFAULT_SCENE_DENSITY。`,
  );

  findings.push(
    `模块粒度：模型 ${plan.modules.length} 个模块（${Math.min(...plan.modules.map((m) => m.durationMinutes))}-${Math.max(...plan.modules.map((m) => m.durationMinutes))} 分钟），真人 ${units.count} 个多页单元（${units.minMinutes}-${units.maxMinutes} 分钟）。`,
  );

  findings.push(
    `讲稿密度不可直接对比：真人 ${Math.round(deck.cueCharsPerMinute)} 字/分钟是 cue（临场展开），逐字稿需 ${Math.round(deck.cueCharsPerMinute * expansion)} 字/分钟。若把这份备注直接喂给 TTS，61 分钟只会产出约 ${Math.round(deck.minutes / expansion)} 分钟。`,
  );

  const missing = [
    contract.requiresObjective ? null : 'teachingObjective',
    contract.requiresTransition ? null : '页级交棒句',
  ].filter(Boolean);

  findings.push(
    missing.length === 0
      ? `页级契约已覆盖：真人每页都有 purpose 与 transition（各 ${deck.pages}/${deck.pages}），长课 brief 已把两者列为硬要求。`
      : `页级契约仍缺失：${missing.join('、')}。真人对 ${deck.pages} 页全部填写。`,
  );

  if (deck.retrievalPages < 3) {
    findings.push(
      `检索点不足：真人 ${deck.retrievalPages} 处口头检索、0 个 quiz 页。长课若照此生成，D6 会稳定低分。`,
    );
  }

  return findings;
}
