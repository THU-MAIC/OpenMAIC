/**
 * Canonical form for tolerant answer-key matching.
 *
 * AI-generated keys often differ from option values/labels by cosmetics:
 * full-width digits and punctuation, extra/missing spaces, case, or a
 * leading letter wrapper ("A." / "A、" / "(B)" / "（Ｂ）"). NFKC folds
 * full-width forms, whitespace is stripped, case is folded, a lone letter
 * wrapper reduces to that letter, and a leading "A."/"A、" prefix is
 * stripped from longer keys so "A. (6, 2)" aligns with the option label.
 *
 * Keep in lockstep with `lib/quiz/answer-key.ts`.
 */
export function canonQuizAnswerKey(s: string): string {
  const folded = s.normalize('NFKC').replace(/\s+/g, '').toLowerCase();
  const wrapped = folded.match(/^(?:[(\[（【])?([a-z])(?:[.)\]、。:：．）】])?$/);
  if (wrapped) return wrapped[1];
  return folded.replace(/^[a-z][.、。:：．)]/, '');
}

/**
 * Resolve an answer-key entry to an option value when exactly one option
 * matches canonically (by value or by label). Unknown or ambiguous entries
 * pass through untouched — never silently re-pointed.
 *
 * Returns the option's actual `value` (not the input), so a stored key that
 * is only canonically equal to an option still grades against the value the
 * UI submits.
 */
export function resolveQuizAnswerKey(
  answer: string,
  options: { value: string; label: string }[],
): string {
  if (options.length === 0) return answer;
  const ca = canonQuizAnswerKey(answer);
  const candidates = new Set<string>();
  for (const o of options) {
    if (canonQuizAnswerKey(o.value) === ca || canonQuizAnswerKey(o.label) === ca) {
      candidates.add(o.value);
    }
  }
  if (candidates.size === 1) return [...candidates][0];
  return answer;
}
