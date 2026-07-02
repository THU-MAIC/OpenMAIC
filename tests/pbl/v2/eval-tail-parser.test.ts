/**
 * Tests for the evaluator JSON-tail parser + normalizers.
 *
 * Heavy on the failure-mode coverage — these are the same modes the
 * v1 Python repo's evaluator iteratively fixed. Encoding them all
 * here means a regression shows up as a red test, not as a learner
 * staring at a star rating that says "good".
 */
import { describe, expect, it } from 'vitest';
import {
  normalizeOptionalString,
  normalizeScore,
  normalizeStars,
  normalizeStringList,
  parseEvaluationTail,
  sanitizeMilestoneEvaluationFeedback,
  stripEvaluationTail,
  stripTemplatePlaceholders,
} from '@/lib/pbl/v2/operations/eval-tail-parser';

describe('parseEvaluationTail', () => {
  it('returns null on empty / blank input', () => {
    expect(parseEvaluationTail('')).toBeNull();
    expect(parseEvaluationTail('     ')).toBeNull();
  });

  it('returns null when no JSON tail is present', () => {
    expect(parseEvaluationTail('Great work today!')).toBeNull();
  });

  it('parses a single fenced ```json block', () => {
    const text =
      '反馈段落...\n\n```json\n{"strengths": ["a"], "improvements": ["b"], "score": 80}\n```\n';
    const out = parseEvaluationTail(text);
    expect(out).toEqual({ strengths: ['a'], improvements: ['b'], score: 80 });
  });

  it('parses a JSON-only task evaluation object with feedback', () => {
    const text =
      '{"feedback":"这次提交展示了可运行的输入输出，已经达到继续要求。","strengths":["输出清楚"],"improvements":["补充边界样例"],"score":72}';

    expect(parseEvaluationTail(text)).toEqual({
      feedback: '这次提交展示了可运行的输入输出，已经达到继续要求。',
      strengths: ['输出清楚'],
      improvements: ['补充边界样例'],
      score: 72,
    });
  });

  it('parses fenced JSON even when the closing fence is on the JSON line', () => {
    const text =
      '反馈段落...\n\n```json\n{"strengths": ["a"], "improvements": ["b"], "score": 80}```';

    expect(parseEvaluationTail(text)).toEqual({
      strengths: ['a'],
      improvements: ['b'],
      score: 80,
    });
  });

  it('takes the LAST fenced block when multiple exist (narrative example + real tail)', () => {
    const text =
      'Example shape:\n```json\n{"sample": "ignore"}\n```\n\n' +
      '实际反馈...\n\n```json\n{"strengths": ["x"], "improvements": ["y"]}\n```\n';
    expect(parseEvaluationTail(text)).toEqual({
      strengths: ['x'],
      improvements: ['y'],
    });
  });

  it('falls back to a trailing balanced {...} when no fence', () => {
    const text = '反馈段落...\n\n{"learned": ["a", "b"], "performance": "p", "stars": 4.5}';
    expect(parseEvaluationTail(text)).toEqual({
      learned: ['a', 'b'],
      performance: 'p',
      stars: 4.5,
    });
  });

  it('uses the shared JSON repair parser for malformed fenced blocks', () => {
    const text = '反馈\n```json\n{ this is not json\n```';
    expect(parseEvaluationTail(text)).toEqual({ 'this is not json': null });
  });

  it('rejects a top-level array (only object payloads are accepted)', () => {
    const text = 'narrative\n```json\n["a", "b"]\n```';
    expect(parseEvaluationTail(text)).toBeNull();
  });

  it('survives a UTF-8 / Chinese narrative + fenced tail', () => {
    const text =
      '恭喜你完成了这一阶段！你在调试的时候非常有耐心。\n\n' +
      '```json\n{"learned": ["读懂报错信息", "用 print 排查"], "performance": "面对错误冷静、自己定位问题", "stars": 4}\n```';
    const out = parseEvaluationTail(text);
    expect(out).toMatchObject({
      stars: 4,
      learned: ['读懂报错信息', '用 print 排查'],
    });
  });
});

describe('stripEvaluationTail', () => {
  it('returns input untouched when no fenced tail', () => {
    expect(stripEvaluationTail('Good narrative.')).toBe('Good narrative.');
  });

  it('strips only the LAST fenced block, leaving earlier ones intact', () => {
    const text =
      'Example block:\n```json\n{"sample": 1}\n```\n\nReal narrative.\n\n```json\n{"x": 1}\n```\n';
    const stripped = stripEvaluationTail(text);
    expect(stripped).toContain('Example block');
    expect(stripped).toContain('{"sample": 1}');
    expect(stripped).not.toContain('{"x": 1}');
  });

  it('trims trailing whitespace after stripping', () => {
    const text = 'narrative\n\n```json\n{"x":1}\n```\n\n   \n';
    expect(stripEvaluationTail(text)).toBe('narrative');
  });

  it('strips a naked trailing JSON object that parseEvaluationTail accepts', () => {
    const text =
      '这一阶段你已经完成了删除功能，并用两种情况验证了结果。\n' +
      '{"learned":["用 in 判断商品是否在列表里"],"performance":"能用输出检查逻辑。","stars":4.0}';

    expect(stripEvaluationTail(text)).toBe(
      '这一阶段你已经完成了删除功能，并用两种情况验证了结果。',
    );
  });

  it('does not strip prose that only contains inline JSON-like examples', () => {
    const text = '可以把配置写成 {"mode":"demo"}，这只是正文示例。';
    expect(stripEvaluationTail(text)).toBe(text);
  });
});

describe('template placeholder cleanup', () => {
  it('removes unresolved template placeholders from structured strings', () => {
    expect(stripTemplatePlaceholders('恭喜 {{NAME}} 完成项目')).toBe('恭喜 完成项目');
    expect(normalizeStringList(['你完成了 {{PROJECT}}', '{{NAME}}'], 4)).toEqual(['你完成了']);
    expect(normalizeOptionalString('下一步可以扩展 {{FEATURE}}')).toBe('下一步可以扩展');
  });
});

describe('sanitizeMilestoneEvaluationFeedback', () => {
  it('removes next-stage setup sections but keeps the structured JSON tail', () => {
    const text = [
      '你完成了搭建清单骨架这一阶段，也跑通了添加和展示功能。',
      '你遇到变量名问题时能自己回头检查，这是很好的项目调试习惯。',
      '',
      '当前阶段目标',
      '我们接下来要实现删除商品功能。',
      '',
      '你目前的代码应该长这样',
      '```python',
      'shopping = []',
      '```',
      '',
      '第一个微任务：编写删除商品函数',
      '',
      '```json',
      '{"learned":["创建列表","封装添加函数"],"performance":"能用运行结果检查功能。","stars":4}',
      '```',
    ].join('\n');

    const sanitized = sanitizeMilestoneEvaluationFeedback(text);

    expect(sanitized).toContain('你完成了搭建清单骨架这一阶段');
    expect(sanitized).not.toContain('当前阶段目标');
    expect(sanitized).not.toContain('第一个微任务');
    expect(parseEvaluationTail(sanitized)).toEqual({
      learned: ['创建列表', '封装添加函数'],
      performance: '能用运行结果检查功能。',
      stars: 4,
    });
  });

  it('allows a short Continue handover sentence in the reflection card', () => {
    const text =
      '这个阶段完成了。下一阶段是实现删除功能，点击 Continue 按钮后再继续。\n\n```json\n{"learned":["a"],"performance":"p","stars":4}\n```';

    const sanitized = sanitizeMilestoneEvaluationFeedback(text);

    expect(sanitized).toContain('下一阶段是实现删除功能');
    expect(sanitized).toContain('Continue 按钮');
  });
});

describe('normalizeStars', () => {
  it('returns null for null / undefined / non-numeric strings / objects', () => {
    expect(normalizeStars(null)).toBeNull();
    expect(normalizeStars(undefined)).toBeNull();
    expect(normalizeStars('good')).toBeNull();
    expect(normalizeStars('4 stars')).toBeNull();
    expect(normalizeStars({})).toBeNull();
    expect(normalizeStars([])).toBeNull();
  });

  it('returns null for NaN / Infinity', () => {
    expect(normalizeStars(Number.NaN)).toBeNull();
    expect(normalizeStars(Number.POSITIVE_INFINITY)).toBeNull();
    expect(normalizeStars(Number.NEGATIVE_INFINITY)).toBeNull();
  });

  it('clamps to [0, 5]', () => {
    expect(normalizeStars(8.7)).toBe(5);
    expect(normalizeStars(-2)).toBe(0);
    expect(normalizeStars(5)).toBe(5);
    expect(normalizeStars(0)).toBe(0);
  });

  it('snaps to the nearest 0.5', () => {
    expect(normalizeStars(4.5)).toBe(4.5);
    expect(normalizeStars(4.3)).toBe(4.5);
    expect(normalizeStars(4.7)).toBe(4.5);
    expect(normalizeStars(4.8)).toBe(5);
    expect(normalizeStars(4.2)).toBe(4);
  });

  it('parses "n/5" and "n / 5" strings', () => {
    expect(normalizeStars('4/5')).toBe(4);
    expect(normalizeStars('4.5 / 5')).toBe(4.5);
    expect(normalizeStars('3.0/5')).toBe(3);
  });

  it('parses bare numeric strings', () => {
    expect(normalizeStars('4')).toBe(4);
    expect(normalizeStars('4.5')).toBe(4.5);
  });
});

describe('normalizeScore', () => {
  it('rejects non-numeric and NaN', () => {
    expect(normalizeScore(null)).toBeNull();
    expect(normalizeScore('great')).toBeNull();
    expect(normalizeScore(Number.NaN)).toBeNull();
  });

  it('rounds to integer and clamps to [0, 100]', () => {
    expect(normalizeScore(85.7)).toBe(86);
    expect(normalizeScore(150)).toBe(100);
    expect(normalizeScore(-10)).toBe(0);
  });

  it('parses "n/100" strings', () => {
    expect(normalizeScore('72/100')).toBe(72);
    expect(normalizeScore('72 / 100')).toBe(72);
  });
});

describe('normalizeStringList', () => {
  it('returns [] for non-array', () => {
    expect(normalizeStringList(null)).toEqual([]);
    expect(normalizeStringList('a,b')).toEqual([]);
    expect(normalizeStringList({})).toEqual([]);
  });

  it('filters non-strings and empties, trims whitespace', () => {
    expect(normalizeStringList(['a', '  b  ', '', null, 3, 'c'])).toEqual(['a', 'b', 'c']);
  });

  it('caps at max length', () => {
    expect(normalizeStringList(['a', 'b', 'c', 'd'], 2)).toEqual(['a', 'b']);
  });
});

describe('normalizeOptionalString', () => {
  it('returns null for non-strings / empties', () => {
    expect(normalizeOptionalString(null)).toBeNull();
    expect(normalizeOptionalString(123)).toBeNull();
    expect(normalizeOptionalString('')).toBeNull();
    expect(normalizeOptionalString('   ')).toBeNull();
  });

  it('returns trimmed string', () => {
    expect(normalizeOptionalString('  hi  ')).toBe('hi');
  });
});
