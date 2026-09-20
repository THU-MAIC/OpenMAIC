/**
 * Client-safe clarification Q/A helpers.
 *
 * This module has NO Node.js imports (no prompt loader, no fs): it is safe to
 * bundle into client components. Prompt construction and model parsing live in
 * `clarify.ts`, which stays server-side.
 */

/** One selectable answer offered for a clarification question. */
export interface AskUserOption {
  id: string;
  label: string;
}

/**
 * One structured question the model may ask before outline generation.
 * Mirrors the Pro workbench `AskUserQuestion` shape (question + optional
 * options + optional free text) without depending on agent-runtime code.
 */
export interface AskUserQuestion {
  id: string;
  question: string;
  options?: AskUserOption[];
  multiSelect?: boolean;
  allowFreeText?: boolean;
}

/** One answered question, ready to inject into the outline prompt. */
export interface ClarificationQA {
  question: string;
  answer: string;
}

/** The user's answer to one clarification question. */
export interface ClarificationAnswer {
  optionIds?: string[];
  freeText?: string;
}

/**
 * Resolve option ids + free text into prompt-ready Q/A pairs.
 * Questions the user left unanswered are omitted.
 */
export function buildClarificationQA(
  questions: AskUserQuestion[],
  answers: Record<string, ClarificationAnswer>,
): ClarificationQA[] {
  const pairs: ClarificationQA[] = [];

  for (const question of questions) {
    const answer = answers[question.id];
    if (!answer) continue;

    const labels = (answer.optionIds ?? [])
      .map((id) => question.options?.find((option) => option.id === id)?.label)
      .filter((label): label is string => !!label);
    const freeText = answer.freeText?.trim();

    const parts = [...labels];
    if (freeText) parts.push(freeText);
    if (parts.length === 0) continue;

    pairs.push({ question: question.question, answer: parts.join('; ') });
  }

  return pairs;
}

/** Render Q/A pairs as stable numbered lines for prompt injection. */
export function formatClarificationQAForPrompt(pairs: ClarificationQA[]): string {
  return pairs
    .map((pair, index) => `Q${index + 1}: ${pair.question}\nA${index + 1}: ${pair.answer}`)
    .join('\n');
}
