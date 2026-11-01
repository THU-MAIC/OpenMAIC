/**
 * Markdown report for a calibration run.
 *
 * The report is written to disk because a calibration is only useful if the
 * next person can diff it: a default that drifts shows up as a changed row, not
 * as an argument.
 */

import type { CalibrationReport } from './types';

function fmt(value: number, digits = 2): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(digits);
}

const VERDICT_LABEL: Record<string, string> = {
  match: '✅ 一致',
  adjust: '⚠️ 需校准',
  info: 'ℹ️ 口径不同',
};

export function renderReport(report: CalibrationReport): string {
  const { deck, rows, structuralScores, findings } = report;

  const lines: string[] = [
    `# 长课校准报告 · ${report.title}`,
    '',
    `基线：\`${report.fixture}\``,
    '',
    '## 一、真人基线',
    '',
    '| 指标 | 值 |',
    '| --- | --- |',
    `| 页数 / 总时长 | ${deck.pages} 页 / ${deck.minutes} 分钟 |`,
    `| 页密度 | ${fmt(deck.pagesPerMinute)} 页/分钟 |`,
    `| 每页时长 | 均值 ${fmt(deck.minutesPerPage)} 分钟，范围 ${deck.pageMinutes.min}-${deck.pageMinutes.max}，变异系数 ${fmt(deck.pageMinutes.stdDev / deck.pageMinutes.mean)} |`,
    `| 教学单元 | ${deck.units} 个（其中多页单元 **${deck.multiPageUnits}** 个） |`,
    `| 多页单元时长 | ${fmt(deck.unitMinutes.min, 0)}-${fmt(deck.unitMinutes.max, 0)} 分钟，均值 ${fmt(deck.unitMinutes.mean, 1)} |`,
    `| 转场页（hero） | ${deck.heroPages} 页 |`,
    `| 每页教学目标 | ${Math.round(deck.purposeCoverage * 100)}% |`,
    `| 每页过渡句 | ${Math.round(deck.transitionCoverage * 100)}% |`,
    `| 讲稿提示字数 | ${deck.cueChars} 字（${fmt(deck.cueCharsPerMinute, 0)} 字/分钟） |`,
    `| 每页讲话段数 | ${fmt(deck.talkSegmentsPerPage, 1)} 段 |`,
    `| 检索页（代理指标） | ${deck.retrievalPages} 页 |`,
    '',
    '## 二、与模型默认值对比',
    '',
    '| 指标 | 真人 | 模型 | 单位 | 容差 | 判定 |',
    '| --- | --- | --- | --- | --- | --- |',
    ...rows.map(
      (row) =>
        `| ${row.label} | ${fmt(row.human)} | ${fmt(row.model)} | ${row.unit} | ±${fmt(row.tolerance)} | ${VERDICT_LABEL[row.verdict]} |`,
    ),
    '',
    '### 逐条说明',
    '',
    ...rows.map((row) => `- **${row.label}**（${VERDICT_LABEL[row.verdict]}）：${row.note}`),
    '',
    '## 三、结构维度评分（可计算子集）',
    '',
    '> D3 演绎质量、D4 认知负荷、D5 参与度需要模型评审，不在本报告内。',
    '',
    '| 维度 | 得分 | 依据 |',
    '| --- | --- | --- |',
    ...structuralScores.map((item) => `| ${item.dimension} | ${item.score} / 5 | ${item.reason} |`),
    '',
    '## 四、结论',
    '',
    ...findings.map((finding) => `- ${finding}`),
    '',
  ];

  return lines.join('\n');
}
