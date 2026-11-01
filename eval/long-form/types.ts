/**
 * The long-form eval compares a generated 60-minute course against a course a
 * human actually designed for the same length.
 *
 * The ground truth is a parsed `网页美化版` deck (`scripts/long-form/parse-deck.mjs`):
 * every page carries the designer's own minutes, teaching purpose, spoken cues
 * and hand-forward. That is the only place in this project where a real
 * hour-long lesson exists in machine-readable form.
 */

export interface DeckPage {
  id: string;
  index: number;
  theme: 'light' | 'dark';
  hero: boolean;
  animate: string | null;
  title: string;
  section: string;
  minutes: number;
  purpose: string;
  talk: string[];
  transition: string;
  cueChars: number;
  talkSegments: number;
}

/** A contiguous run of pages under one section label. */
export interface DeckUnit {
  section: string;
  minutes: number;
  pages: number;
  pageIds: string[];
}

export interface DeckFixture {
  meta: {
    deckDir: string;
    chapter: string;
    title: string;
    pages: number;
    minutes: number;
    cueChars: number;
    heroPages: number;
    sections: string[];
  };
  pages: DeckPage[];
  units: DeckUnit[];
}

export interface Range {
  min: number;
  max: number;
  mean: number;
  median: number;
  stdDev: number;
}

export interface DeckMetrics {
  pages: number;
  minutes: number;
  pagesPerMinute: number;
  minutesPerPage: number;
  pageMinutes: Range;
  units: number;
  /**
   * Units that run two pages or more — the ones a reader experiences as a
   * module. A one-page section is a topic label on a page, and counting it as a
   * module flatters the granularity comparison.
   */
  multiPageUnits: number;
  unitMinutes: Range;
  pagesPerUnit: number;
  heroPages: number;
  purposeCoverage: number;
  transitionCoverage: number;
  cueChars: number;
  cueCharsPerMinute: number;
  talkSegmentsPerPage: number;
  /** Pages that carry a quiz or retrieval beat, by the deck's own markup. */
  retrievalPages: number;
}

/**
 * One calibration line: what the human did, what the planner assumes, and
 * whether the gap is small enough to leave alone.
 */
export interface CalibrationRow {
  key: string;
  label: string;
  human: number;
  model: number;
  unit: string;
  /** Absolute tolerance within which the two are considered the same. */
  tolerance: number;
  /**
   * `match` — inside tolerance, leave the model alone.
   * `adjust` — outside tolerance, and the model should move toward the human.
   * `info` — the two measure different things on purpose; recorded, not acted on.
   */
  verdict: 'match' | 'adjust' | 'info';
  note: string;
}

export interface CalibrationReport {
  fixture: string;
  title: string;
  deck: DeckMetrics;
  rows: CalibrationRow[];
  /** Structural subset of the eight-dimension rubric, 1-5 each. */
  structuralScores: Array<{ dimension: string; score: number; reason: string }>;
  findings: string[];
}

export function range(values: readonly number[]): Range {
  if (values.length === 0) return { min: 0, max: 0, mean: 0, median: 0, stdDev: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const mean = sorted.reduce((acc, value) => acc + value, 0) / sorted.length;
  const middle = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
  const variance = sorted.reduce((acc, value) => acc + (value - mean) ** 2, 0) / sorted.length;
  return {
    min: sorted[0],
    max: sorted[sorted.length - 1],
    mean,
    median,
    stdDev: Math.sqrt(variance),
  };
}
