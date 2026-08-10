/**
 * PBL v2 — Evaluator JSON-tail parser.
 *
 * All evaluator prompts include a structured JSON payload the platform
 * persists. Task evaluations now output JSON only; milestone / final
 * evaluations keep a short narrative plus JSON tail for their streaming
 * cards. This module is the **only** place that turns raw LLM text into
 * typed values. Keeping it pure (no I/O, no LLM) lets unit tests cover
 * every wonky output shape providers have shipped us.
 *
 * Robustness we explicitly handle:
 *  - LLM emits fenced JSON, naked JSON, or prose + JSON → reuse the
 *    shared OpenMAIC generation JSON repair parser
 *  - LLM emits malformed JSON inside the fence → reuse shared repair;
 *    return null only if no object can be recovered
 *  - LLM emits `stars: "4/5"` / `"good"` / `null` / `8.7` / `NaN`
 *    → clamp + half-step round; reject non-numeric
 *  - LLM emits `score: "70/100"` / out-of-range / negative
 *    → coerce to a clean [0, 100] integer; reject non-numeric
 *
 * This is the lesson from the v1 repo's evaluator (Python). The same
 * three failure modes occurred there too — they got fixed iteratively;
 * we encode them all up front here.
 */

import { parseJsonResponse } from '@/lib/generation/json-repair';

const FENCED_JSON_RE = /```json\s*\n([\s\S]*?)\n\s*```/g;
const ANY_FENCED_JSON_RE = /```(?:json)?\s*([\s\S]*?)```/g;
const TEMPLATE_PLACEHOLDER_RE = /\{\{\s*[^}]+\s*\}\}/g;

function splitLastFencedJsonTail(text: string): {
  narrative: string;
  tail: string;
  tailStart: number;
} {
  if (!text) return { narrative: '', tail: '', tailStart: -1 };
  let lastIdx = -1;
  let lastLen = 0;
  let probe: RegExpExecArray | null;
  const re = new RegExp(FENCED_JSON_RE.source, 'g');
  while ((probe = re.exec(text)) !== null) {
    lastIdx = probe.index;
    lastLen = probe[0].length;
  }
  if (lastIdx < 0) return { narrative: text, tail: '', tailStart: -1 };
  return {
    narrative: text.slice(0, lastIdx),
    tail: text.slice(lastIdx, lastIdx + lastLen),
    tailStart: lastIdx,
  };
}

/** Parse the trailing structured JSON the evaluator was asked to emit.
 *  Returns the parsed object or null if none found / invalid. */
export function parseEvaluationTail(text: string): Record<string, unknown> | null {
  if (!text) return null;
  const candidates: string[] = [text];
  let m: RegExpExecArray | null;
  const re = new RegExp(ANY_FENCED_JSON_RE.source, 'g');
  while ((m = re.exec(text)) !== null) {
    candidates.push(m[1]);
  }
  const nakedTail = extractTrailingBalancedObjectRange(text.trimEnd());
  if (nakedTail) candidates.push(nakedTail.json);

  const parsed = parseLastObjectCandidate(candidates);
  return parsed;
}

function parseLastObjectCandidate(candidates: string[]): Record<string, unknown> | null {
  for (let i = candidates.length - 1; i >= 0; i--) {
    const parsed = parseJsonResponse<unknown>(candidates[i].trim());
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  }
  return null;
}

/** Find the last well-balanced `{...}` substring in text. Naive but
 *  enough for our case: evaluator narratives never contain a nested
 *  brace in the prose. Returns null when nothing parses cleanly. */
function extractTrailingBalancedObjectRange(text: string): { json: string; start: number } | null {
  // Walk from the END backwards to find the last `}`, then walk back
  // further to find its matching `{`. Counting braces only — string-
  // escape edge cases (a `}` inside a JSON string) are rare in
  // narrative + JSON-tail output and tolerable to miss.
  const lastClose = text.lastIndexOf('}');
  if (lastClose < 0) return null;
  let depth = 0;
  for (let i = lastClose; i >= 0; i--) {
    const ch = text[i];
    if (ch === '}') depth++;
    else if (ch === '{') {
      depth--;
      if (depth === 0) {
        return { json: text.slice(i, lastClose + 1), start: i };
      }
    }
  }
  return null;
}

/** Strip the trailing structured JSON block from a narrative so the UI
 *  can render the prose alone. Handles both supported evaluator tails:
 *  the LAST fenced ```json block, or a naked trailing `{...}` object.
 *  Earlier example blocks (if any) survive.
 *
 *  Implementation note: we cannot just regex-replace `FENCED_JSON_RE`
 *  globally — that would also strip example blocks the prose was
 *  showing on purpose. Instead we find the LAST fence and slice it
 *  out, then trim trailing whitespace. */
export function stripEvaluationTail(text: string): string {
  if (!text) return '';
  const { narrative, tail } = splitLastFencedJsonTail(text);
  if (tail) return narrative.trimEnd();
  const trimmed = text.trimEnd();
  const nakedTail = extractTrailingBalancedObjectRange(trimmed);
  if (nakedTail) {
    const prefix = trimmed.slice(0, nakedTail.start);
    if (prefix && !/\n\s*$/.test(prefix)) return trimmed;
    const candidate = nakedTail.json.trim();
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return trimmed.slice(0, nakedTail.start).trimEnd();
      }
    } catch {
      // Not a usable JSON tail; keep the prose unchanged.
    }
  }
  return trimmed;
}

/**
 * Milestone reflections must stay about the stage that just ended.
 * The next stage is opened by the explicit Continue action, so any
 * generated section that starts teaching / scaffolding the next first
 * microtask is removed while preserving the structured JSON tail.
 */
export function sanitizeMilestoneEvaluationFeedback(text: string): string {
  if (!text) return '';
  const { narrative, tail } = splitLastFencedJsonTail(text);
  const normalized = narrative.replace(/\r\n/g, '\n');
  const disallowedSectionRe =
    /(^|\n)\s*(?:#{1,6}\s*)?(?:当前阶段目标|下(?:一|个|一个)阶段(?:目标|任务|计划|内容|引导)|你目前的代码应该长这样|目前的代码应该长这样|参考代码|起始代码|代码模板|第(?:一|1)个微任务|第(?:一|1)个任务|First microtask|Next task|Current stage goal|Your code should look like|Starter code)[^\n]*/i;
  const sectionMatch = disallowedSectionRe.exec(normalized);
  const keptNarrative = sectionMatch
    ? normalized.slice(0, Math.max(0, sectionMatch.index)).trimEnd()
    : normalized.trimEnd();
  if (!tail) return keptNarrative;
  return keptNarrative ? `${keptNarrative}\n\n${tail}` : tail;
}

/** Coerce an LLM-emitted ``stars`` value to a clean 0-5 number in 0.5
 *  increments. Returns null if the input is not a usable number — the
 *  UI hides the rating cleanly rather than rendering a bogus value.
 *
 *  Accepts:
 *  - clean numbers: `4.5`, `3`, `5`
 *  - numeric strings: `"4"`, `"3.5"`
 *  - "n / 5" or "n/5" strings: `"4.5/5"`, `"3 / 5"` (extract the n)
 *  - out-of-range numbers: clamp to [0, 5]
 *
 *  Rejects (returns null):
 *  - NaN / Infinity
 *  - non-numeric strings: `"good"`, `"4/5 stars"` with extra text
 *  - null / undefined
 *  - objects / arrays
 */
export function normalizeStars(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  let candidate: number;
  if (typeof raw === 'number') {
    candidate = raw;
  } else if (typeof raw === 'string') {
    // Permit "4.5/5" or "4.5 / 5" — extract numerator.
    const slashMatch = raw.match(/^\s*(-?\d+(?:\.\d+)?)\s*\/\s*5\s*$/);
    if (slashMatch) {
      candidate = parseFloat(slashMatch[1]);
    } else {
      const plain = raw.trim();
      // Refuse strings with non-numeric tail like "4 stars" or "good".
      if (!/^-?\d+(?:\.\d+)?$/.test(plain)) return null;
      candidate = parseFloat(plain);
    }
  } else {
    return null;
  }
  if (!Number.isFinite(candidate)) return null;
  const clamped = Math.max(0, Math.min(5, candidate));
  return Math.round(clamped * 2) / 2;
}

/** Coerce an LLM-emitted ``score`` value to a clean 0-100 integer.
 *  Returns null if not a usable number. */
export function normalizeScore(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  let candidate: number;
  if (typeof raw === 'number') {
    candidate = raw;
  } else if (typeof raw === 'string') {
    // Permit "80/100" or "80 / 100" — extract numerator.
    const slashMatch = raw.match(/^\s*(-?\d+(?:\.\d+)?)\s*\/\s*100\s*$/);
    if (slashMatch) {
      candidate = parseFloat(slashMatch[1]);
    } else {
      const plain = raw.trim();
      if (!/^-?\d+(?:\.\d+)?$/.test(plain)) return null;
      candidate = parseFloat(plain);
    }
  } else {
    return null;
  }
  if (!Number.isFinite(candidate)) return null;
  const clamped = Math.max(0, Math.min(100, candidate));
  return Math.round(clamped);
}

/** Coerce an LLM-emitted string-list field. Filters empties and
 *  non-strings. Caps length so a runaway LLM can't blow up storage. */
export function normalizeStringList(raw: unknown, max = 8): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const s = stripTemplatePlaceholders(item).trim();
    if (!s) continue;
    out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

/** Coerce an LLM-emitted string field. Returns null when empty / wrong
 *  type. Trims whitespace. */
export function normalizeOptionalString(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = stripTemplatePlaceholders(raw).trim();
  return s || null;
}

export function stripTemplatePlaceholders(text: string): string {
  return text.replace(TEMPLATE_PLACEHOLDER_RE, '').replace(/\s{2,}/g, ' ');
}
