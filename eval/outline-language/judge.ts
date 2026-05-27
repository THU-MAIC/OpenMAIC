import { generateText, type LanguageModel } from 'ai';
import type { JudgeResult } from './types';

const JUDGE_SYSTEM_PROMPT = `You are evaluating whether a language directive for an AI course generation system is reasonable given the expected behavior.

You will be given:
1. The original user requirement
2. The generated language directive
3. The ground truth description of expected behavior

Evaluation criteria — the directive should:
- Use the correct primary teaching language
- Handle terminology in a reasonable way for the subject and audience
- For cross-language scenarios (foreign language learning, cross-language PDF), acknowledge both languages

Be LENIENT in your evaluation:
- The directive does NOT need to match the ground truth word-for-word
- Different but equally valid approaches should PASS
- If the teaching language is correct and the overall approach is reasonable, it should PASS
- Only FAIL if the directive is clearly WRONG (e.g., wrong teaching language, completely ignoring a cross-language situation)

Respond with ONLY a JSON object:
{"pass": true/false, "reason": "brief explanation (1-2 sentences)"}`;

/**
 * Ask an LLM-as-judge whether `directive` is a reasonable language directive
 * for `requirement` given `groundTruth`. Lenient rubric — see system prompt.
 */
export async function judgeDirective(
  judgeModel: LanguageModel,
  requirement: string,
  directive: string,
  groundTruth: string,
): Promise<JudgeResult> {
  const result = await generateText({
    model: judgeModel,
    system: JUDGE_SYSTEM_PROMPT,
    prompt: `Requirement: "${requirement}"\n\nGenerated directive: "${directive}"\n\nGround truth: "${groundTruth}"`,
    temperature: 0,
  });

  try {
    const text = result.text.replace(/```json\s*|\s*```/g, '').trim();
    return JSON.parse(text) as JudgeResult;
  } catch {
    return { pass: false, reason: `Failed to parse judge response: ${result.text}` };
  }
}
