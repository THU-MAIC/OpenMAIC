/**
 * Locks the calibration against a real 61-minute lesson.
 *
 * The long-form defaults were not guessed: they were fitted to a deck a person
 * actually taught (`eval/long-form/scenarios/ch18-analgesics.json`). This test
 * is the tripwire — if a later change moves page density, module granularity or
 * the page-level contract away from that baseline, it fails here rather than in
 * a 60-minute course nobody has generated yet.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { calibrate } from '@/eval/long-form/metrics/calibration';
import type { DeckFixture } from '@/eval/long-form/types';

const fixture = JSON.parse(
  readFileSync(
    join(process.cwd(), 'eval', 'long-form', 'scenarios', 'ch18-analgesics.json'),
    'utf-8',
  ),
) as DeckFixture;

const report = calibrate(fixture, 'ch18-analgesics');

describe('long-form calibration against the 镇痛药 deck', () => {
  it('reads the deck as 28 pages over 61 minutes', () => {
    expect(report.deck.pages).toBe(28);
    expect(report.deck.minutes).toBe(61);
    expect(report.deck.minutesPerPage).toBeCloseTo(2.18, 2);
  });

  it('agrees with the human on page density within one page', () => {
    const pages = report.rows.find((row) => row.key === 'pages')!;
    expect(Math.abs(pages.model - pages.human)).toBeLessThanOrEqual(1);
    expect(pages.verdict).toBe('match');
  });

  it('agrees with the human on module granularity', () => {
    const modules = report.rows.find((row) => row.key === 'modules')!;
    expect(modules.model).toBe(7);
    expect(modules.verdict).toBe('match');

    const longest = report.rows.find((row) => row.key === 'maxModuleMinutes')!;
    expect(longest.model).toBeLessThanOrEqual(12);
    expect(longest.verdict).toBe('match');
  });

  it('keeps the page-level contract the human writes on every page', () => {
    const objective = report.rows.find((row) => row.key === 'purposeCoverage')!;
    const transition = report.rows.find((row) => row.key === 'transitionCoverage')!;
    expect(objective.verdict).toBe('match');
    expect(transition.verdict).toBe('match');
  });

  it('does not calibrate the speech budget down to cue density', () => {
    // The deck's notes are presenter cues at ~92 chars/min; a verbatim script
    // runs at ~204. Treating that as a model error would halve every lesson.
    const rate = report.rows.find((row) => row.key === 'charsPerMinute')!;
    expect(rate.verdict).toBe('info');
    expect(rate.model).toBeGreaterThan(rate.human);
  });

  it('reports the two structural dimensions the deck can be scored on', () => {
    const d7 = report.structuralScores.find((score) => score.dimension.startsWith('D7'))!;
    expect(d7.score).toBe(5);
  });
});
