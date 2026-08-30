const ORIGINAL_CHOICE_LINE = /^\s*([A-F])[.)\uFF0E\uFF09\u3001:\uFF1A]\s*(\S(?:.*\S)?)\s*$/u;

export interface StructuredOriginalQuestion {
  question: string;
  options?: { id: string; text: string }[];
}

/** Parse only an unambiguous trailing A-F choice block without inventing structure. */
export function structuredOriginalQuestionFromText(
  questionText: string,
): StructuredOriginalQuestion {
  const lines = questionText.replace(/\r\n?/gu, '\n').split('\n');
  while (lines.length > 0 && lines.at(-1)?.trim().length === 0) lines.pop();

  const reversedOptions: { id: string; text: string }[] = [];
  let optionStart = lines.length;
  while (optionStart > 0) {
    const match = ORIGINAL_CHOICE_LINE.exec(lines[optionStart - 1]!);
    if (!match) break;
    reversedOptions.push({ id: match[1]!, text: match[2]! });
    optionStart -= 1;
  }

  const options = reversedOptions.reverse();
  const sequential =
    options.length >= 3 &&
    options.length <= 6 &&
    options.every((option, index) => option.id === String.fromCharCode('A'.charCodeAt(0) + index));
  const stem = lines.slice(0, optionStart).join('\n').trim();
  if (!sequential || stem.length === 0) return { question: questionText };
  return { question: stem, options };
}
