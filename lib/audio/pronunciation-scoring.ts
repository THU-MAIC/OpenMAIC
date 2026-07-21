/**
 * Small, provider-independent pronunciation scorer for generated practice widgets.
 *
 * ASR is not a phoneme assessor: it can still return the expected sentence for a
 * poor accent. This scorer deliberately treats the ASR transcript as evidence,
 * not as a boolean answer, and compares words with an alignment so omissions and
 * substitutions are visible to the learner.
 */

export interface PronunciationScore {
  score: number;
  matchedWords: number;
  expectedWords: number;
  recognizedWords: number;
  transcript: string;
}

export function normalizePronunciationText(value: string): string[] {
  return value
    .toLocaleLowerCase('en-US')
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

export function scorePronunciation(
  expected: string,
  transcript: string,
  confidence?: number,
): PronunciationScore {
  const expectedWords = normalizePronunciationText(expected);
  const recognizedWords = normalizePronunciationText(transcript);
  if (expectedWords.length === 0 || recognizedWords.length === 0) {
    return {
      score: 0,
      matchedWords: 0,
      expectedWords: expectedWords.length,
      recognizedWords: recognizedWords.length,
      transcript,
    };
  }

  // Global alignment avoids the common bug where one omitted word shifts every
  // subsequent word and makes an otherwise good attempt score near zero.
  const rows = expectedWords.length + 1;
  const cols = recognizedWords.length + 1;
  const dp = Array.from({ length: rows }, () => Array<number>(cols).fill(0));
  for (let i = 1; i < rows; i++) dp[i][0] = i;
  for (let j = 1; j < cols; j++) dp[0][j] = j;
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (expectedWords[i - 1] === recognizedWords[j - 1] ? 0 : 1),
      );
    }
  }

  let i = expectedWords.length;
  let j = recognizedWords.length;
  let matchedWords = 0;
  while (i > 0 || j > 0) {
    if (
      i > 0 &&
      j > 0 &&
      dp[i][j] === dp[i - 1][j - 1] &&
      expectedWords[i - 1] === recognizedWords[j - 1]
    ) {
      matchedWords++;
      i--;
      j--;
    } else if (i > 0 && j > 0 && dp[i][j] === dp[i - 1][j - 1] + 1) {
      i--;
      j--;
    } else if (i > 0 && dp[i][j] === dp[i - 1][j] + 1) {
      i--;
    } else {
      j--;
    }
  }

  const wordAccuracy = matchedWords / expectedWords.length;
  const lengthPenalty = Math.min(1, Math.abs(expectedWords.length - recognizedWords.length) / expectedWords.length);
  let score = 100 * (0.85 * wordAccuracy + 0.15 * (1 - lengthPenalty));
  if (typeof confidence === 'number' && Number.isFinite(confidence) && confidence >= 0) {
    score *= 0.8 + 0.2 * Math.max(0, Math.min(1, confidence));
  }

  return {
    score: Math.round(Math.max(0, Math.min(100, score))),
    matchedWords,
    expectedWords: expectedWords.length,
    recognizedWords: recognizedWords.length,
    transcript,
  };
}

