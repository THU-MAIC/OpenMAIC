import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { writeReport } from '@/eval/outline-language/reporter';
import type { EvalResult } from '@/eval/outline-language/types';

describe('writeReport', () => {
  let runDir: string;

  beforeEach(() => {
    runDir = mkdtempSync(join(tmpdir(), 'reporter-test-'));
  });

  afterEach(() => {
    rmSync(runDir, { recursive: true, force: true });
  });

  const sample: EvalResult[] = [
    {
      case_id: 'en-001',
      category: 'english-teaching',
      requirement: 'teach English to beginners',
      groundTruth: 'English as primary',
      directive: 'Use English as the teaching language',
      outlinesCount: 3,
      judgePassed: true,
      judgeReason: 'correct language',
    },
    {
      case_id: 'zh-002',
      category: 'chinese-teaching',
      requirement: '用中文讲授数学',
      groundTruth: '以中文为主',
      directive: 'Use Chinese throughout',
      outlinesCount: 2,
      judgePassed: false,
      judgeReason: 'wrong phrasing',
    },
  ];

  it('writes a report.md file with header, per-case detail, and summary table', () => {
    const path = writeReport(runDir, sample, {
      inferenceModel: 'openai:gpt-4.1',
      judgeModel: 'anthropic:claude-haiku-4-5',
    });
    expect(existsSync(path)).toBe(true);
    expect(path).toBe(join(runDir, 'report.md'));

    const content = readFileSync(path, 'utf-8');
    expect(content).toContain('# Outline Language Inference Eval Results');
    expect(content).toContain('**Model**: openai:gpt-4.1');
    expect(content).toContain('**Judge model**: anthropic:claude-haiku-4-5');
    expect(content).toContain('**Passed**: 1/2');
    expect(content).toContain('### PASS en-001');
    expect(content).toContain('### **FAIL** zh-002');
    expect(content).toContain('## Summary');
    expect(content).toContain('| # | Case | Category | Outlines | Result | Judge reason |');
    expect(content).toContain('| 1 | en-001 | english-teaching | 3 | PASS | correct language |');
    expect(content).toContain('| 2 | zh-002 | chinese-teaching | 2 | FAIL | wrong phrasing |');
  });

  it('returns a successfully written path even when all cases pass', () => {
    const allPass: EvalResult[] = [{ ...sample[0] }];
    const path = writeReport(runDir, allPass, {
      inferenceModel: 'openai:gpt-4.1',
      judgeModel: 'openai:gpt-4.1',
    });
    const content = readFileSync(path, 'utf-8');
    expect(content).toContain('**Passed**: 1/1 (100%)');
  });
});
