export const EXAM_QUESTION_MARKER_MAX_SECTION_LABEL_LENGTH = 160;
export const EXAM_QUESTION_RESPONSE_LABEL_MAX_LENGTH = 64;

export interface ExamQuestionSectionRef {
  normalizedId: string;
  rawLabel: string;
}

export interface ExamQuestionLocator {
  sectionPath: readonly ExamQuestionSectionRef[];
  printedNumber: string;
  subquestionPath: readonly string[];
}

export interface NormalizedExamQuestionLocator {
  sectionPath: readonly string[];
  printedNumber: string;
  subquestionPath: readonly string[];
}

export type NormalizedExamQuestionMarker =
  | {
      kind: 'section';
      rawLabel: string;
      normalizedSectionId: string;
    }
  | {
      kind: 'question';
      rawLabel: string;
      printedNumber: string;
    }
  | {
      kind: 'question_subquestion';
      rawLabel: string;
      printedNumber: string;
      subquestionNumber: string;
    }
  | {
      kind: 'subquestion';
      rawLabel: string;
      subquestionNumber: string;
    };

export interface ParsedExamQuestionResponseLabel {
  rawLabel: string;
  printedNumber: string;
  subquestionPath: readonly string[];
}

const SECTION_KIND =
  /(?:选择题|填空题|解答题|计算题|证明题|作图题|综合题|阅读题|写作题|作文|判断题|简答题|实验题|应用题)/u;
const SECTION_LINE = /^\s*([一二三四五六七八九十百]{1,4})\s*[、.]\s*(\S.*)\s*$/u;
const COMBINED_LABEL = /^\s*([1-9]\d{0,2})\s*(?:[.、]\s*)?\(\s*([1-9]\d{0,2})\s*\)/u;
const QUESTION_LABEL = /^\s*([1-9]\d{0,2})\s*([.、])(?!\d)/u;
const SUBQUESTION_LABEL = /^\s*\(\s*([1-9]\d{0,2})\s*\)/u;
const RESPONSE_LABEL = /^([1-9]\d{0,2})(?:\(([1-9]\d{0,2})\))?$/u;
const MATH_CONTINUATION = /^[+\-*/=<>≤≥×÷^%]/u;

function chineseSectionNumber(value: string): number | undefined {
  const digit: Readonly<Record<string, number>> = {
    一: 1,
    二: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
  };
  if (value === '十') return 10;
  if (value === '百') return 100;
  const hundred = value.indexOf('百');
  if (hundred >= 0) {
    const hundreds = hundred === 0 ? 1 : digit[value[hundred - 1]!];
    if (!hundreds) return undefined;
    const remainder = value.slice(hundred + 1);
    const tail = remainder.length === 0 ? 0 : chineseSectionNumber(remainder);
    return tail === undefined ? undefined : hundreds * 100 + tail;
  }
  const ten = value.indexOf('十');
  if (ten >= 0) {
    const tens = ten === 0 ? 1 : digit[value[ten - 1]!];
    const onesText = value.slice(ten + 1);
    const ones = onesText.length === 0 ? 0 : digit[onesText];
    if (!tens || ones === undefined) return undefined;
    return tens * 10 + ones;
  }
  return digit[value];
}

function rawPrefix(raw: string, normalizedMatchLength: number): string {
  return raw.slice(0, normalizedMatchLength).trim();
}

function hasMathContinuation(normalizedLine: string, matchLength: number): boolean {
  return MATH_CONTINUATION.test(normalizedLine.slice(matchLength).trimStart());
}

/** Normalize only a bounded marker line. Source question text is never NFKC-normalized. */
export function normalizeExamQuestionMarker(value: string): NormalizedExamQuestionMarker | null {
  const rawLine = value.replace(/\r\n?/gu, '\n').split('\n', 1)[0] ?? '';
  if (!rawLine.trim()) return null;
  const markerPrefix = rawLine.slice(0, EXAM_QUESTION_MARKER_MAX_SECTION_LABEL_LENGTH);
  const line = markerPrefix.normalize('NFKC');
  const section =
    rawLine.length <= EXAM_QUESTION_MARKER_MAX_SECTION_LABEL_LENGTH
      ? SECTION_LINE.exec(line)
      : null;
  if (section && SECTION_KIND.test(section[2]!)) {
    const number = chineseSectionNumber(section[1]!);
    if (number !== undefined && number > 0) {
      return {
        kind: 'section',
        rawLabel: rawLine.trim(),
        normalizedSectionId: `section:${number}`,
      };
    }
  }

  const combined = COMBINED_LABEL.exec(line);
  if (combined && !hasMathContinuation(line, combined[0].length)) {
    return {
      kind: 'question_subquestion',
      rawLabel: rawPrefix(rawLine, combined[0].length),
      printedNumber: String(Number(combined[1]!)),
      subquestionNumber: String(Number(combined[2]!)),
    };
  }

  const question = QUESTION_LABEL.exec(line);
  if (question) {
    return {
      kind: 'question',
      rawLabel: rawPrefix(rawLine, question[0].length),
      printedNumber: String(Number(question[1]!)),
    };
  }

  const subquestion = SUBQUESTION_LABEL.exec(line);
  if (subquestion && !hasMathContinuation(line, subquestion[0].length)) {
    return {
      kind: 'subquestion',
      rawLabel: rawPrefix(rawLine, subquestion[0].length),
      subquestionNumber: String(Number(subquestion[1]!)),
    };
  }
  return null;
}

/** Parse a complete response label; prose, decimals, ranges, and page labels are rejected. */
export function parseExamQuestionResponseLabel(
  value: string,
): ParsedExamQuestionResponseLabel | null {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > EXAM_QUESTION_RESPONSE_LABEL_MAX_LENGTH ||
    value !== value.trim()
  ) {
    return null;
  }
  const match = RESPONSE_LABEL.exec(value.normalize('NFKC'));
  if (!match) return null;
  return {
    rawLabel: value,
    printedNumber: String(Number(match[1]!)),
    subquestionPath: match[2] === undefined ? [] : [String(Number(match[2]))],
  };
}

/** Semantic locator equality ignores the display-only raw section label. */
export function normalizeExamQuestionLocator(
  locator: ExamQuestionLocator,
): NormalizedExamQuestionLocator {
  return {
    sectionPath: locator.sectionPath.map((section) => section.normalizedId),
    printedNumber: locator.printedNumber,
    subquestionPath: [...locator.subquestionPath],
  };
}

export function examQuestionLocatorKey(locator: ExamQuestionLocator): string {
  return JSON.stringify(normalizeExamQuestionLocator(locator));
}

export function examQuestionTopLevelLocatorKey(locator: ExamQuestionLocator): string {
  return JSON.stringify({
    sectionPath: locator.sectionPath.map((section) => section.normalizedId),
    printedNumber: locator.printedNumber,
  });
}

export function sameExamQuestionTopLevel(
  left: ExamQuestionLocator,
  right: ExamQuestionLocator,
): boolean {
  return examQuestionTopLevelLocatorKey(left) === examQuestionTopLevelLocatorKey(right);
}
