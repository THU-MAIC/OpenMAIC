/**
 * LLM-as-judge for the agent answer-content eval.
 *
 * Given the student's latest message and the AI teacher's reply, decides:
 *   - leads_with_answer : does the FIRST sentence already address the literal
 *                         question / request? (this is the bug we hunt —
 *                         "first sentence drifts, a later one answers")
 *   - answered_anywhere : does the reply address it AT ALL, even if late?
 *
 * The gap (answered_anywhere && !leads_with_answer) is exactly the
 * "drift-then-answer" pathology this eval targets.
 *
 * Unlike the director routing eval (deterministic TEACHER/USER/END check),
 * answer quality is not mechanically decidable, so we use an LLM judge —
 * mirroring eval/outline-language/judge.ts.
 */

import { generateText, type LanguageModel } from 'ai';

/** Accept only a real boolean or the exact strings "true"/"false" (case-insensitive).
 * Anything else (e.g. a stray string, number, undefined) returns null so the caller
 * flags the sample as malformed instead of silently coercing it to a pass/fail. */
function asStrictBool(v: unknown): boolean | null {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (s === 'true') return true;
    if (s === 'false') return false;
  }
  return null;
}

export interface AnswerVerdict {
  /** First sentence(s) already address the literal question/request. */
  leads_with_answer: boolean;
  /** The reply addresses it at all, even if buried after a lead that drifts. */
  answered_anywhere: boolean;
  reason: string;
  /** Set when the judge response could not be parsed. */
  error?: boolean;
}

const JUDGE_SYSTEM_PROMPT = `You evaluate whether an AI teacher's reply ANSWERS the student's most recent message in a live classroom.

You are given:
1. The student's latest message
2. An "answer key" describing what a correct reply must do
3. The AI's FIRST sentence(s) (its opening)
4. The AI's FULL reply

A reply "addresses" the message when it does what the answer key asks: gives the specific value/formula/yes-no/definition/steps; OR for a vague request, asks ONE specific clarifying question; OR for an error report, acknowledges/corrects it; OR for a format/capability request (e.g. "in Chinese", "make a video", "skip the page"), honors it or directly says it cannot / what it will do instead.

Fairness for specific request types:
- LANGUAGE / FORMAT requests are satisfied when the reply is PRIMARILY in the requested language/format. Keeping individual technical terms, proper nouns, or formulas in their standard (often English) form is normal and still counts as honoring the request — do not penalize that code-switching.
- SLIDE-NAVIGATION requests ("skip to the next page", "go back a slide"): the agent has NO action to change the slide, so a correct reply ACKNOWLEDGES the request and is HONEST that it cannot directly change the slide — offering to continue with the next point verbally, or telling the user how to navigate (e.g. the slide controls). Pretending it flipped the slide, or silently narrating the current slide as if nothing was asked, does NOT count. (Pure pacing like "slow down" / "go deeper" — which the agent CAN do by adjusting its narration — is satisfied by doing so.)

A reply does NOT address it when it instead: greets ("Welcome!"), launches an opening lecture ("Today we examine…"), pivots to an adjacent (non-requested) topic, reacts to peers, asks a rhetorical lead-in unrelated to the request, or answers a different question than the one asked.

Judge TWO things independently:
- leads_with_answer: does the literal question/request get addressed in the OPENING (field 3 — the first sentence or two)? A brief acknowledgement of the user's message before the answer is fine and still counts as leading (e.g. "好的" / "Sorry, let me clarify" / "Good catch" / "Sharp eye, Tom!"). But a greeting ("Welcome!" / "同学们好"), a self-introduction, or a topic/lecture preamble ("Today we'll discuss parabolas…") before the answer means it does NOT lead — even if the answer comes right after.
- answered_anywhere: is it addressed ANYWHERE in the FULL reply (field 4), even if the opening drifted?

Be reasonable, not pedantic about wording. A correct answer phrased differently from the answer key still passes. Judge substance, not politeness.

Respond with ONLY a JSON object, no code fences:
{"leads_with_answer": true/false, "answered_anywhere": true/false, "reason": "1-2 sentences"}`;

export async function judgeAnswer(
  judgeModel: LanguageModel,
  studentMessage: string,
  answerKey: string,
  leadReply: string,
  fullReply: string,
): Promise<AnswerVerdict> {
  const result = await generateText({
    model: judgeModel,
    system: JUDGE_SYSTEM_PROMPT,
    prompt: `Student's latest message: "${studentMessage}"

Answer key (what a correct reply must do): "${answerKey}"

AI's FIRST sentence(s): "${leadReply || '(no text — only actions / empty)'}"

AI's FULL reply: "${fullReply || '(no text — only actions / empty)'}"`,
    temperature: 0,
  });

  try {
    const text = result.text.replace(/```json\s*|\s*```/g, '').trim();
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const leads = asStrictBool(parsed.leads_with_answer);
    const answered = asStrictBool(parsed.answered_anywhere);
    if (leads === null || answered === null) {
      return {
        leads_with_answer: false,
        answered_anywhere: false,
        reason: `Malformed judge booleans: ${result.text.slice(0, 200)}`,
        error: true,
      };
    }
    return {
      leads_with_answer: leads,
      answered_anywhere: answered,
      reason: typeof parsed.reason === 'string' ? parsed.reason : '',
    };
  } catch {
    return {
      leads_with_answer: false,
      answered_anywhere: false,
      reason: `Failed to parse judge response: ${result.text.slice(0, 200)}`,
      error: true,
    };
  }
}
