/**
 * PBL v2 — Simulator agent (SCENARIO ONLY).
 *
 * Drives one in-character role-play turn for a scenario project's
 * `scenarioStage === 'roleplay'` milestone. It is a deliberately thin
 * sibling of `runInstructorTurn`:
 *
 *   - zero teaching rules / tools (no observation / closing-check /
 *     synthesis / advance) — the character only role-plays;
 *   - its own SSE contract identical to the Instructor route (token
 *     deltas + a final `message` project_patch + `done`), so the
 *     existing client stream loop handles it unchanged;
 *   - all messages it emits carry `roleType: 'simulator'` (the speaking
 *     character, with `characterId`) or `roleType: 'system'` (neutral
 *     scene narration), and land on the dedicated Simulator thread
 *     (`PBL_SIMULATOR_AGENT_ID`) — never the Instructor thread.
 *
 * It is ONLY reached for scenario projects in a roleplay stage; every
 * entry point is gated. Ordinary projects never invoke it.
 *
 * Scope (increment 3): in-character conversation + deterministic
 * scene-entry narration. Beat advancement / evidence gating are
 * intentionally NOT here — they land in increment 4.
 */

import { streamText, generateText } from 'ai';
import type { LanguageModel } from 'ai';

import { createLogger } from '@/lib/logger';
import { resolveThinkingProviderOptions } from '@/lib/ai/llm';
import type { ThinkingConfig } from '@/lib/types/provider';
import { loadPBLV2Prompt } from '../prompts/loader';

import type {
  PBLProjectV2,
  PBLMilestone,
  PBLMicrotask,
  PBLChatMessage,
  PBLScenarioCharacter,
  PBLAgentThread,
} from '../types';
import type { PBLSSEEvent } from '../api/sse';
import { recordEvent } from '../operations/engagement';
import {
  currentMicrotask,
  normalizeProjectRuntime,
  PBL_SIMULATOR_AGENT_ID,
} from '../operations/progress';

const log = createLogger('PBL v2 Simulator');

/** Generous safety ceiling on the role-play context window. A scenario is a
 *  bounded, single-sitting session (finite beats/stages), so this is large
 *  enough that real scenarios send their FULL history with NOTHING dropped —
 *  the character never "forgets" the early scene. Unlike the Instructor there
 *  is deliberately NO summary-compaction here (would need a roleplay-specific
 *  digest); the ceiling only guards against a pathological, unbounded thread. */
const MAX_HISTORY_MESSAGES = 300;

export type SimulatorPhase = 'greeting' | 'instructing';

function genMessageId(): string {
  return 'msg_' + Date.now().toString(16) + Math.random().toString(16).slice(2, 6);
}

/** SCENARIO ONLY. The character who speaks this turn. First showcase is
 *  single-character, so the speaker is the (only) cast member; richer
 *  multi-character turn-taking is a later iteration. */
function speakingCharacter(project: PBLProjectV2): PBLScenarioCharacter | undefined {
  return project.scenario?.characters?.[0];
}

/** Who is going to READ this history. The two role-play voices must NOT see
 *  the conversation the same way:
 *
 *   - 'character' — the in-scene character. It must see ONLY spoken dialogue
 *     (its own past lines as `assistant`, the learner as `user`). System
 *     narration is DELIBERATELY EXCLUDED: feeding the narrator's third-person
 *     prose (stage directions, "他皱了皱眉…") into the character's context
 *     teaches it to imitate that voice — it starts narrating itself in the
 *     third person and paraphrasing the narration. A live A/B/contagion
 *     experiment confirmed this is the ROOT CAUSE of the role-bleed bug:
 *     excluding narration yields clean first-person dialogue, including it
 *     produces stage directions + repetition. The character does not NEED the
 *     narration — the concrete scene facts already live in its system prompt
 *     ('Established facts of THIS exact moment').
 *
 *   - 'director' — the director/narrator pass. It DOES see narration as
 *     `(Scene: …)` so its scene-keeping stays continuous turn to turn.
 */
export type SimulatorAudience = 'character' | 'director';

/** Map the Simulator thread into LLM messages for a given audience. Character
 *  lines are the assistant voice; learner lines are user; neutral system
 *  narration is passed as scene context ONLY to the director (see
 *  `SimulatorAudience`). */
export function buildSimulatorHistory(
  thread: PBLAgentThread | undefined,
  audience: SimulatorAudience,
): Array<{ role: 'system' | 'user' | 'assistant'; content: string }> {
  const out: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [];
  if (!thread) return out;
  if (thread.earlierSummary) {
    out.push({ role: 'system', content: `## Earlier in the scene\n${thread.earlierSummary}` });
  }
  for (const m of thread.messages.slice(-MAX_HISTORY_MESSAGES)) {
    const content = m.content.trim();
    if (!content) continue;
    if (m.roleType === 'user') out.push({ role: 'user', content });
    else if (m.roleType === 'simulator') out.push({ role: 'assistant', content });
    else if (m.roleType === 'system' && audience === 'director') {
      // ONLY the director sees prior narration — never the character (it would
      // imitate the third-person prose and bleed it into its spoken line).
      out.push({ role: 'system', content: `(Scene: ${content})` });
    }
  }
  return out;
}

/** Build the Simulator system prompt: static role-play rules + the
 *  concrete scene/cast/beat context for this project. Exported for unit
 *  tests. */
export function buildSimulatorSystemPrompt(
  project: PBLProjectV2,
  milestone: PBLMilestone,
  microtask: PBLMicrotask | undefined,
): string {
  const scenario = project.scenario;
  const language = project.language || 'the learner’s language';
  const base = loadPBLV2Prompt('simulator-system', { language });
  if (!scenario) return base;

  const lines: string[] = ['## The scene', `Setting: ${scenario.setting}`];
  if (scenario.rules) lines.push(`Rules of this world: ${scenario.rules}`);
  if (scenario.learnerRole) {
    lines.push(`Who the learner is (the person you are talking to): ${scenario.learnerRole}`);
  }
  lines.push(`Current scene: ${milestone.title}`);
  if (milestone.briefing?.trim())
    lines.push(`What is happening right now: ${milestone.briefing.trim()}`);
  // Established facts of the current beat — the system narrator delivers
  // these to the learner; the character must stay 100% consistent with
  // them and must NEVER invent or contradict positions / cards / who did
  // what / whose turn it is. Pulls from the beat's narration + description
  // (the same concrete setup the learner sees), so the character can never
  // drift to a different version of the situation.
  const established = [microtask?.narration?.trim(), microtask?.description?.trim()]
    .filter(Boolean)
    .join(' ');
  if (established) {
    lines.push(
      `Established facts of THIS exact moment (the narrator has already told the learner this — stay fully consistent, NEVER invent or contradict any position / card / bet / whose turn it is): ${established}`,
    );
  }
  // NOTE: the beat's `completionCriteria` / `successWhen` is the pedagogical
  // judge, authored in a coaching voice. It is deliberately NOT fed to the
  // character — telling an immersive character to "steer the scene toward
  // {learning goal}" is exactly what turns it into a coach (eliciting/evaluating
  // the learner's reasoning). In the act model the character never advances
  // anything; the learner ends the act manually and checkpoint coverage is
  // judged later for scoring only.

  lines.push('', '## You are playing');
  const cast = scenario.characters ?? [];
  for (const c of cast) {
    const parts: string[] = [];
    if (c.persona?.trim()) parts.push(c.persona.trim());
    if (c.situation?.trim()) parts.push(`Current situation: ${c.situation.trim()}`);
    if (c.boundaries?.trim())
      parts.push(`Hard boundaries you must never cross: ${c.boundaries.trim()}`);
    lines.push(`- **${c.name}** — ${parts.join(' | ')}`);
  }
  if (cast.length === 1) {
    lines.push('', `You are **${cast[0].name}**. Speak only as them.`);
  } else if (cast.length > 1) {
    lines.push(
      '',
      'Speak as ONE character at a time — whoever would naturally respond. Prefix nothing; just speak as them.',
    );
  }

  // B1′: the beat's authored character drive — a PRIVATE in-scene goal that
  // makes the character pursue something, so the scene has momentum instead
  // of flat Q&A. It is a motive to act on, NEVER a line to say, narrate,
  // evaluate, or coach (that would break role purity).
  const objective = microtask?.characterObjective?.trim();
  if (objective) {
    lines.push(
      '',
      `## Your private aim this beat`,
      `You privately want: ${objective}. Pursue it naturally through what you say and do in character — but NEVER announce it, narrate it, evaluate the learner on it, or coach them toward it.`,
    );
  }

  return `${base}\n\n${lines.join('\n')}`;
}

/** Build the SCENE NARRATOR system prompt (SCENARIO ONLY). A separate,
 *  pure-narrator persona — never a character, never a coach — so the
 *  in-character Simulator stays untouched and there is no role bleed.
 *  Exported for unit tests. */
export function buildNarratorSystemPrompt(
  project: PBLProjectV2,
  milestone: PBLMilestone,
  microtask: PBLMicrotask | undefined,
): string {
  const scenario = project.scenario;
  const language = project.language || 'the learner’s language';
  const base = loadPBLV2Prompt('simulator-narrator-system', { language });
  if (!scenario) return base;

  const lines: string[] = ['## The scene', `Setting: ${scenario.setting}`];
  if (scenario.rules) lines.push(`Rules of this world: ${scenario.rules}`);
  if (scenario.learnerRole) lines.push(`The learner's role in the scene: ${scenario.learnerRole}`);
  lines.push(`Current scene: ${milestone.title}`);
  if (milestone.briefing?.trim()) lines.push(`What is happening: ${milestone.briefing.trim()}`);
  const established = [microtask?.narration?.trim(), microtask?.description?.trim()]
    .filter(Boolean)
    .join(' ');
  if (established) {
    lines.push(
      `Established facts of this beat (your narration must stay consistent with these): ${established}`,
    );
  }
  if (microtask?.completionCriteria?.trim()) {
    lines.push(
      `This beat is resolved once the following is true — let the world keep moving naturally, but NEVER announce it, evaluate the learner, or coach/hint them toward it: ${microtask.completionCriteria.trim()}`,
    );
  }
  const castNames = (scenario.characters ?? []).map((c) => c.name).join('、');
  if (castNames) {
    lines.push(
      `The named characters of this scene: ${castNames}. You MAY describe their visible actions, reactions, expressions and body language (that is part of the scene), but NEVER speak for them or summarize/paraphrase what they SAY — their words come only from their own turn. If the only thing happening next is one of them speaking, output NONE.`,
    );
  }
  return `${base}\n\n${lines.join('\n')}`;
}

/** Result of one director-narrator pass. */
/** Run the director-narrator pass: a short, non-streamed system-voice
 *  narration that sets / develops the scene. In the ACT model the director has
 *  NO progression role — a roleplay act is one continuous scene and only the
 *  learner advances it (by clicking "finish this act"). The director purely
 *  narrates: visible scene changes + characters' NON-VERBAL reactions, never
 *  their words.
 *
 *  On `instructing` it runs AFTER the character has spoken, so it narrates the
 *  character's real, visible non-verbal reaction to what it actually said —
 *  never a hallucinated one. Best-effort: errors / NONE → no narration, never
 *  blocks the turn. Returns the narration chunks (one neutral bubble each). */
async function runDirectorNarratorPass(args: {
  project: PBLProjectV2;
  milestone: PBLMilestone;
  microtask: PBLMicrotask;
  phase: SimulatorPhase;
  thread: PBLAgentThread | undefined;
  languageModel: LanguageModel;
  thinkingConfig?: ThinkingConfig;
  signal?: AbortSignal;
  /** SCENARIO ACT MODEL. On a greeting, whether this is the FIRST entry into the
   *  whole scene (no prior act) vs entering a LATER act (the shared Simulator
   *  thread already holds the previous act). Drives whether the opening nudge
   *  warns against re-describing what the prior act already covered. */
  firstEntry?: boolean;
}): Promise<string[]> {
  const { project, milestone, microtask, phase, thread, languageModel, signal, firstEntry } = args;
  const system = buildNarratorSystemPrompt(project, milestone, microtask);
  const history = buildSimulatorHistory(thread, 'director');
  const greetingNudge = firstEntry
    ? '(The learner is just entering the scene. Set the opening: describe, clearly and atmospherically, the setting and situation they walk into so the background is established. You may describe the character’s visible demeanour, but do NOT speak their words.)'
    : // Entering a LATER act of the same ongoing scene (the thread above holds the
      // previous act). Open the NEW act without re-narrating what just happened.
      '(A NEW act of this same ongoing scene is beginning now. You DO know everything that happened in the previous act above — keep this opening continuous and consistent with it so the scene flows naturally. But open the NEW situation: describe what is DIFFERENT or what moves the scene into this new act (a shift in setting/topic/mood/time). Do NOT re-describe or re-state the character’s reaction or posture from the end of the previous act — that already happened; do not repeat it. You may describe the character’s visible demeanour as it is NOW, but do NOT speak their words. If nothing new is worth showing, output EXACTLY NONE and let the character open.)';
  const nudge =
    phase === 'greeting'
      ? greetingNudge
      : "(The character has just spoken (their line is the latest assistant message above). Narrate only what is VISIBLE beyond their words: a genuine shift in the setting/scene mechanics (the next card is dealt, a new phase begins, time passes) AND/OR the character's notable NON-VERBAL reaction (a gesture, expression, posture) to what was just said. NEVER voice, restate or summarize what the character SAID. If nothing visible changed and there is no notable reaction, output EXACTLY NONE.)";
  const messages = [...history, { role: 'user' as const, content: nudge }];

  try {
    const result = await generateText({
      model: languageModel,
      system,
      messages,
      ...(signal ? { abortSignal: signal } : {}),
    });
    const text = (result.text ?? '').trim();
    if (!text) return [];
    // Sentinel: model says nothing happened → no narration this turn.
    if (/^none[.。!！\s]*$/i.test(text)) return [];
    // The narrator may emit several distinct beats (blank-line separated)
    // → render one neutral 'system' bubble each.
    return text
      .split(/\n{2,}/)
      .map((s) => s.trim())
      .filter(Boolean);
  } catch (err) {
    log.warn(
      `Director-narrator pass failed (skipping): ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }
}

interface RunSimulatorTurnArgs {
  project: PBLProjectV2;
  userMessage: string;
  phase: SimulatorPhase;
  languageModel: LanguageModel;
  thinkingConfig?: ThinkingConfig;
  signal?: AbortSignal;
}

/** True when the scene has NOT actually started yet in the Simulator thread —
 *  i.e. there are no character (`simulator`) or learner (`user`) messages. Any
 *  `system` message (narration) does NOT count: it only marks "the scene
 *  already started" if a character or the learner has actually spoken, so a
 *  fresh act whose thread holds only neutral narration still delivers the
 *  authored opening line. Exported for tests. */
export function isFirstSceneEntry(messages: readonly PBLChatMessage[] | undefined): boolean {
  return !(messages ?? []).some((m) => m.roleType === 'user' || m.roleType === 'simulator');
}

/** SCENARIO ACT MODEL. A roleplay milestone is ONE continuous scene whose beats
 *  are background checkpoints, not sequentially-advanced units. So the
 *  character/narrator must be grounded in the WHOLE act, not just the first
 *  beat `currentMicrotask` happens to return. This builds a synthetic
 *  "act-level" microtask that:
 *   - keeps beat 1's `narration`/`description` as the OPENING scene facts (so
 *     the scene doesn't dump later developments up front — later beats unfold
 *     naturally as the learner drives the conversation);
 *   - merges every beat's private `characterObjective` (the character privately
 *     holds the whole act's drives + facts-to-uncover, revealed only when
 *     probed — never narrated/coached, exactly as before);
 *   - drops per-beat `successWhen`/`completionCriteria` (no runtime advance in
 *     the act model — progression is the learner's "finish this act" click).
 *  The returned object carries the FIRST beat's `id` so emitted messages stay
 *  correctly tagged. Non-roleplay / single-beat acts collapse to the beat
 *  itself. */
function buildActContext(milestone: PBLMilestone, current: PBLMicrotask): PBLMicrotask {
  if (milestone.scenarioStage !== 'roleplay') return current;
  const beats = milestone.microtasks;
  if (beats.length <= 1) return current;
  const objectives = beats.map((b) => b.characterObjective?.trim()).filter((s): s is string => !!s);
  return {
    ...current,
    // Opening scene = first beat's authored facts only (avoid front-loading
    // later beats' developments). `current` is the first non-terminal beat,
    // which at act entry is beat 1.
    characterObjective:
      objectives.length > 0 ? objectives.join(' ｜ ') : current.characterObjective,
  };
}

/** Run one Simulator turn, yielding SSE events. */
export async function* runSimulatorTurn(
  args: RunSimulatorTurnArgs,
): AsyncGenerator<PBLSSEEvent, void, void> {
  const { project, userMessage, phase, languageModel, thinkingConfig, signal } = args;

  // Guarantees the Simulator thread exists (scenario projects only).
  normalizeProjectRuntime(project);

  // Defensive gates — the client only routes here for a scenario
  // roleplay stage, but never trust the wire.
  if (!project.scenario) {
    yield { type: 'error', code: 'NOT_A_SCENARIO', message: 'Not a scenario project.' };
    yield { type: 'done' };
    return;
  }
  const current = currentMicrotask(project);
  if (!current || current.milestone.scenarioStage !== 'roleplay') {
    yield {
      type: 'error',
      code: 'NOT_IN_ROLEPLAY',
      message: 'The simulator only runs during a roleplay stage.',
    };
    yield { type: 'done' };
    return;
  }
  const { milestone, microtask } = current;
  // ACT MODEL: ground the character/narrator in the whole act, not just the
  // first beat (beats are background checkpoints, not advanced units).
  const actCtx = buildActContext(milestone, microtask);
  const character = speakingCharacter(project);
  if (!character) {
    yield { type: 'error', code: 'NO_CHARACTER', message: 'No scenario character to play.' };
    yield { type: 'done' };
    return;
  }
  const thread = project.threads.find((t) => t.agentId === PBL_SIMULATOR_AGENT_ID);

  // ---- GREETING: scene entry ----
  if (phase === 'greeting') {
    // Whether this is the FIRST entry into the whole scene vs a roleplay→roleplay
    // advance into a later stage. Captured BEFORE the narrator pass appends, and
    // it ignores any `system` divider already pushed by the handover, so the
    // authored `openingLine` is delivered on a true first entry (later stages
    // just get fresh beat narration + a natural in-character line).
    const firstEntry = isFirstSceneEntry(thread?.messages);
    // 1) The SYSTEM narrator opens the scene — proper third-person scene
    //    setting (grounded in the beat facts), shown as neutral background.
    //    The character never states scene facts; the narrator does. On scene
    //    ENTRY the narrator runs FIRST (there is no character line to react to
    //    yet); on a learner turn it runs AFTER the character (see below).
    yield { type: 'sim_phase', phase: 'narration' };
    const openingNarration = await runDirectorNarratorPass({
      project,
      milestone,
      microtask,
      phase: 'greeting',
      thread,
      languageModel,
      thinkingConfig,
      signal,
      firstEntry,
    });
    for (const chunk of openingNarration) {
      const narration: PBLChatMessage = {
        id: genMessageId(),
        agentId: PBL_SIMULATOR_AGENT_ID,
        roleType: 'system',
        content: chunk,
        ts: new Date().toISOString(),
        microtaskId: microtask.id,
      };
      thread?.messages.push(narration);
      yield { type: 'project_patch', patch: { kind: 'message', message: narration } };
    }
    // 2) An authored opening line is delivered verbatim on the FIRST scene
    //    entry (reproducible packaged scene); on a later-stage advance, or when
    //    none is authored, the LLM generates a fresh in-character line below.
    if (character.openingLine?.trim() && firstEntry) {
      const opening: PBLChatMessage = {
        id: genMessageId(),
        agentId: PBL_SIMULATOR_AGENT_ID,
        roleType: 'simulator',
        characterId: character.id,
        content: character.openingLine.trim(),
        ts: new Date().toISOString(),
        microtaskId: microtask.id,
      };
      thread?.messages.push(opening);
      yield { type: 'project_patch', patch: { kind: 'message', message: opening } };
      yield { type: 'done' };
      return;
    }
  } else {
    // ---- INSTRUCTING: record the learner's turn for the data pipeline
    // (keeps completion turn-counts honest; §8 of the design). ----
    const ev = recordEvent(project, 'learner_turn', {
      microtaskId: microtask.id,
      milestoneId: milestone.id,
    });
    yield {
      type: 'project_patch',
      patch: {
        kind: 'engagement_event',
        event: ev,
        eventKind: 'learner_turn',
        microtaskId: ev.microtaskId,
        milestoneId: ev.milestoneId,
        ts: ev.ts,
        payload: ev.payload,
      },
    };
    // On a learner turn the order is CHARACTER FIRST, then the director-narrator
    // (it must see the character's REAL spoken line to narrate the true visible
    // reaction). The character stream + the director-narrator pass happen below.
    // No beat advancement here — the act model advances only when the learner
    // clicks "finish this act".
  }

  // ---- Stream the character's line (pure first-person dialogue, NO tools) ----
  // The immersed character ONLY speaks. Beat advancement and all narration are
  // the omniscient director-narrator's job (it runs after this on a learner
  // turn). Giving the character zero tools — and a history WITHOUT the
  // third-person narration (see `buildSimulatorHistory('character')`) — is what
  // keeps its output clean first-person speech: no stage directions, no
  // narration bleed.
  yield { type: 'sim_phase', phase: 'character' };
  const system = buildSimulatorSystemPrompt(project, milestone, actCtx);
  const history = buildSimulatorHistory(thread, 'character');
  const messages =
    phase === 'greeting'
      ? [
          ...history,
          {
            role: 'user' as const,
            content:
              '(The learner has just arrived in the scene. Speak first, in character, with a natural opening line that fits the situation. Do not narrate.)',
          },
        ]
      : history.length > 0
        ? history
        : [{ role: 'user' as const, content: userMessage.trim() || '…' }];

  // One streaming attempt of the character line. Yields token deltas as they
  // arrive and returns the accumulated text (trimmed). Throws on stream error
  // so the caller can decide retry vs surface.
  async function* streamCharacterLine(): AsyncGenerator<PBLSSEEvent, string, void> {
    let acc = '';
    const stream = streamText({
      model: languageModel,
      system,
      messages,
      ...(thinkingConfig
        ? { providerOptions: resolveThinkingProviderOptions(languageModel, thinkingConfig) }
        : {}),
      ...(signal ? { abortSignal: signal } : {}),
    });
    for await (const part of stream.fullStream) {
      if (part.type === 'text-delta') {
        const delta =
          (part as unknown as { text?: string; textDelta?: string }).text ??
          (part as unknown as { textDelta?: string }).textDelta ??
          '';
        if (delta) {
          acc += delta;
          yield { type: 'token', delta };
        }
      }
    }
    return acc.trim();
  }

  let assistantText = '';
  try {
    assistantText = yield* streamCharacterLine();
    // Empty-output safety net: a one-shot retry before giving up. Treats the
    // common transient empty turn (thinking model hiccup, safety filter, a
    // dropped stream) as recoverable rather than a hard error — the learner
    // never sees a raw error code or an empty screen (root cause P0-1 /
    // EXP-P1-5). NOTE: the retry re-yields tokens; the client renders the
    // streaming draft, so a retry simply replaces the (empty) draft.
    if (!assistantText) {
      assistantText = yield* streamCharacterLine();
    }
  } catch (err) {
    log.warn(`Simulator stream failed: ${err instanceof Error ? err.message : String(err)}`);
    yield {
      type: 'error',
      code: 'STREAM_ERROR',
      message: err instanceof Error ? err.message : String(err),
    };
    yield { type: 'done' };
    return;
  }

  if (assistantText) {
    const message: PBLChatMessage = {
      id: genMessageId(),
      agentId: PBL_SIMULATOR_AGENT_ID,
      roleType: 'simulator',
      characterId: character.id,
      content: assistantText,
      ts: new Date().toISOString(),
      microtaskId: microtask.id,
    };
    thread?.messages.push(message);
    yield { type: 'project_patch', patch: { kind: 'message', message } };
  } else {
    // Both attempts came back empty. Surface a soft, in-fiction-neutral notice
    // (tolerated by the client stream loop) rather than a hard error — the turn
    // still ends cleanly and the learner can simply try again.
    yield {
      type: 'error',
      code: 'EMPTY_LLM_OUTPUT',
      message: '角色这一轮没有说话，请再试一次。',
    };
    yield { type: 'done' };
    return;
  }

  // ---- Director-narrator pass (AFTER the character spoke) ----
  // The omniscient director-narrator now sees the character's real line. On a
  // learner turn it narrates the visible non-verbal reaction / scene change (or
  // NONE). It has NO progression role in the act model — a roleplay act is one
  // continuous scene; only the learner advances it (the "finish this act"
  // sidebar button). On greeting the opening narration already ran first.
  if (phase === 'instructing') {
    yield { type: 'sim_phase', phase: 'narration' };
    const narrationChunks = await runDirectorNarratorPass({
      project,
      milestone,
      microtask,
      phase: 'instructing',
      thread,
      languageModel,
      thinkingConfig,
      signal,
    });
    for (const chunk of narrationChunks) {
      const narration: PBLChatMessage = {
        id: genMessageId(),
        agentId: PBL_SIMULATOR_AGENT_ID,
        roleType: 'system',
        content: chunk,
        ts: new Date().toISOString(),
        microtaskId: microtask.id,
      };
      thread?.messages.push(narration);
      yield { type: 'project_patch', patch: { kind: 'message', message: narration } };
    }
  }

  // NOTE: no beat advancement here. In the act model the scene never
  // auto-advances mid-act — the learner clicks "finish this act" in the
  // sidebar (→ /task/update `complete_act`) when they are done, which
  // deterministically completes the whole act.

  yield { type: 'done' };
}
