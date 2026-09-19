/**
 * Forced skill loading — a `/handle` the user typed is LOADED, not suggested.
 *
 * ## The gap this closes
 *
 * A skill is text in the composer (`lib/workbench/composer-skills`): the `/`
 * menu writes `/pro-editing ` into the draft and that is all a skill is on the
 * wire. Nothing in the system prompt says "a handle you see must be loaded", so
 * whether the skill's instructions ever reached the model came down to whether
 * the model felt like issuing a `read`. ONE position was exempt: a session's
 * first prompt had its LEADING handle's SKILL.md pasted inline by pi's
 * `formatSkillInvocation`. Everything else — a second handle in that first
 * message, and EVERY handle in every later message — was a hint and nothing
 * more. `pro-editing`'s whole purpose is editing a course that already exists,
 * so its natural use is a follow-up in an existing conversation: it landed in
 * the gap every single time.
 *
 * The exemption was its own bug. Two positions in the same input box behaved
 * differently, and only one of them drew a loading row, so the first message and
 * the fifth disagreed about what `/stage-design` even does. An input box is an
 * input box: every skill of every turn now takes the one path below, and
 * `skillInvocationPrompt` is no longer on the runner's path at all.
 *
 * ## How it works: a read that already happened
 *
 * The turn is delivered as `user → assistant(toolCall read) → toolResult(SKILL.md)`
 * — the exact shape the transcript would have if the model had chosen to read the
 * skill itself. Nothing new is invented:
 *
 *  - pi's `agent.prompt()` accepts an array and emits `message_start`/`message_end`
 *    for each element, so the runner's existing subscriber persists all three into
 *    the entry tree with no new event type and no new storage;
 *  - the workbench paints a "skill loaded" card for a `read` of `<dir>/SKILL.md`,
 *    so the user sees the same loading row they see when the model reads a skill;
 *  - the dedupe can therefore read a preload exactly as it reads a model-issued
 *    read, which is what makes "don't load it twice" a question about the
 *    transcript plus the file's current content, never about a new column;
 *  - and the body arrives as a TOOL RESULT, not as user speech. That matters most
 *    for a user-authored skill: its `wrapUserSkillContent` demotion preamble is
 *    preserved, and 64KiB of user-controlled text does not get promoted into the
 *    user turn where it would read as an instruction.
 *
 * ## Crash consistency: one fact, not two writes
 *
 * The load is three separately fenced entry appends on the runner's ordered write
 * chain, and any of them can be the last one that lands. THE CARD IS NOT A FOURTH
 * AND FIFTH WRITE. The workbench derives the "skill loaded" row from the durable
 * message frames themselves — an assistant `read` of `<dir>/SKILL.md` opens the
 * card, its tool result closes it — so the card's existence and the transcript's
 * are the SAME fact. A truncated write cannot leave a card whose call is nowhere
 * in the transcript, nor a card claiming "loaded" over a body that never arrived,
 * because there is nothing left to disagree.
 *
 * What survives is the part that was never about events. Every prefix short of the
 * tool result leaves a turn whose body never arrived — and worse than absent,
 * because an unanswered read is materialized as "This tool call was interrupted",
 * which tells the model the read FAILED. So the resume asks the turn's own question
 * again and answers it with THIS SAME builder: the transcript dedupe is the
 * idempotence judge, so a load that did land is a no-op and one that did not is
 * delivered exactly as it would have been. One mechanism, not one patch per prefix.
 *
 * WHAT COUNTS AS ALREADY LOADED is a three-condition table, not a path match, and
 * it lives with the evidence it reads (`readProvesCoverage` in skills.ts): the read
 * must be proven to start at line 1, to reach the end of the file, and to describe
 * the file AS IT IS NOW (a content hash — a skill edited by a release or by
 * `patch_skill` is a different file whose new instructions have never been in the
 * context). Unprovable means NOT loaded in every case. That is why the dedupe reads
 * each named skill's current bytes before deciding: coverage is a claim about the
 * file now, and the same read serves the injection.
 *
 * WHERE THE INTENT COMES FROM MATTERS. The resume reads the turn's text from the
 * DURABLE `user_message` rows (or the session's own `prompt`), never from the
 * compaction view: native compaction may split inside the active turn, summarizing
 * the user frame away while keeping the assistant/tool suffix — and then a
 * transcript-derived intent reads as empty at exactly the moment the body has also
 * been dropped. The compaction view is still the right source for the OTHER
 * question ("is the body currently in the model's context?"), which is what the
 * dedupe asks it.
 *
 * ## What it deliberately does not do
 *
 *  - **No new `user` message, ever.** The runner's follow-up delivery cursor is
 *    "how many `user` messages are in the transcript" (`deliveredFollowUps`). A
 *    fourth message with `role: 'user'` would advance that cursor by one and a real
 *    user message would be silently marked delivered and dropped. The synthesized
 *    pair is `assistant` + `toolResult` and the caller passes exactly ONE user
 *    message — the user's own.
 *  - **No orphaned tool call.** Each synthesized `toolCall` ships with its matching
 *    `toolResult` immediately after it, so `repairOrphanedToolCalls` finds a
 *    contiguous, complete group and changes nothing. An orphan here would wedge a
 *    session forever.
 *  - **No mid-run injection.** `agent.steer()` takes ONE message, so a handle typed
 *    while a run is live cannot be delivered as a three-message group without
 *    pushing an assistant frame through the steering queue. That is not attempted:
 *    a steered handle stays a hint for the model, exactly as today. The same
 *    limitation covers one crash prefix: an ORPHANED takeover whose user message
 *    never reached the tree continues the old transcript and injects that message
 *    by steering. The escape is that the runner's undelivered-message check
 *    requeues the row, so the next attempt takes the prompt path and does load the
 *    skill — asserted in the matrix rather than assumed.
 */
import { randomBytes } from 'node:crypto';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { AssistantMessage, ToolResultMessage } from '@earendil-works/pi-ai';

import {
  readProvesCoverage,
  readSkillFileText,
  skillReadRecordsInTranscript,
  skillSourceHash,
  skillsNamedInText,
  type LoadedSkill,
} from './skills';

/**
 * How many skills one message may force-load.
 *
 * A ceiling exists because `/a /b /c /d /e` is one keystroke away and a shipped
 * skill runs from 3KB to 66KB. Three is the working number: enough for the real
 * combinations (a planning skill + a style skill + a DSL reference) without a
 * single turn being able to spend most of the window before the model has said
 * anything.
 */
export const SKILL_PRELOAD_MAX_COUNT = 3;

/**
 * The byte budget one message's preloads share.
 *
 * Counted on the actual SKILL.md text, because count alone is the wrong unit when
 * `slide-dsl` is 66KB and `deep-interactive` is 2.8KB. ~60KB is roughly 15–20k
 * tokens against the driver's 128k floor — a large but recoverable bite, and
 * compaction still has room to work.
 *
 * The FIRST named skill is admitted whatever its size. A budget that could refuse
 * the only skill the user asked for would make `/slide-dsl` silently do nothing,
 * which is the bug this file exists to fix.
 */
export const SKILL_PRELOAD_MAX_BYTES = 60_000;

export interface SkillPreload {
  /**
   * The user text to send. Identical to the input unless something was deferred,
   * in which case a note naming those skills and their locations is appended.
   */
  text: string;
  /**
   * `assistant(toolCall)` + `toolResult` pairs, in order. NEVER contains a
   * message with `role: 'user'` — see the header.
   */
  messages: AgentMessage[];
  /**
   * EVERY installed skill this turn names — forced plus handles, deduplicated, in
   * order — before the transcript dedupe and the caps have their say. This is
   * "what the user chose", which is a different question from "what this turn had
   * to paste in", and the constraint pointer is about the first one.
   */
  requested: LoadedSkill[];
  /** Skills whose SKILL.md is in `messages`, in injection order. */
  injected: LoadedSkill[];
  /** Skills the user named that a cap pushed out; named in `text` instead. */
  deferred: LoadedSkill[];
}

const EMPTY_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
} as const;

/**
 * Tool-call ids for the synthesized reads.
 *
 * Random, and prefixed so a wedged session can be traced back to this file. It
 * must be unique against every id in the conversation because `toolCallId` is the
 * pairing key for `repairOrphanedToolCalls` / `trackToolCallMessage`; 96 random
 * bits inside a per-session transcript makes a collision unreachable, and the
 * `call_` shape matches what OpenAI-compatible gateways expect to echo back.
 */
const TOOL_CALL_ID_PREFIX = 'call_sklpre_';

function defaultToolCallId(): string {
  return `${TOOL_CALL_ID_PREFIX}${randomBytes(12).toString('hex')}`;
}

/** The note that carries a deferred skill: its name, and where to read it. */
function deferredNote(deferred: readonly LoadedSkill[], injectedCount: number): string {
  const list = deferred.map((skill) => `\`/${skill.name}\` (${skill.filePath})`).join(', ');
  const why =
    injectedCount > 0
      ? `this turn already preloaded ${injectedCount}`
      : 'their instructions could not be loaded here';
  return [
    `[The user also named these skills, whose instructions were NOT preloaded because`,
    `${why}: ${list}.`,
    `Read the ones you need with the \`read\` tool before acting on them.]`,
  ].join(' ');
}

/**
 * Turn the skills of one outgoing turn into reads that already happened.
 *
 * TWO SOURCES, ONE PATH. `text` supplies the `/handle`s the user typed; `forced`
 * supplies a skill the turn carries STRUCTURALLY, with no handle in the text to
 * find — the session's own `skillId`, which a launch link sets from the URL
 * rather than from anything the user wrote. They merge into one ordered,
 * id-deduplicated list with `forced` first, so the same caps, the same
 * idempotence judge and the same three-message shape apply to a skill however it
 * was chosen. There is deliberately no separate "explicit choice" delivery: an
 * input box is an input box, and the first message of a session must produce the
 * same loading row as the fifth.
 *
 * `transcript` is the context the model will see (post-compaction), and it is the
 * idempotence judge: a skill already loaded there is skipped — including a
 * `forced` one, so a session's skill is loaded once and not on every later run.
 *
 * Never throws for a content reason. An unknown handle is not a skill, a skill
 * whose file cannot be read is reported as deferred (the model can still read it,
 * or fail visibly doing so), and a turn with no skills at all returns its own
 * text with an empty plan.
 */
export async function buildSkillPreload(input: {
  text: string;
  skills: readonly LoadedSkill[];
  transcript: readonly AgentMessage[];
  /**
   * Skills this turn loads regardless of what the text says, ahead of any
   * handle. The session's frozen `skillId` — the only source a `?skill=` link
   * has.
   */
  forced?: readonly LoadedSkill[];
  /** Stamped onto the synthesized assistant frames; the run's own driver model. */
  model: { api: string; provider: string; id: string };
  maxCount?: number;
  maxBytes?: number;
  now?: () => number;
  newToolCallId?: () => string;
  readSkillFile?: (skill: LoadedSkill) => Promise<string>;
  onSkipped?: (skill: LoadedSkill, reason: string) => void;
}): Promise<SkillPreload> {
  const empty: SkillPreload = {
    text: input.text,
    messages: [],
    requested: [],
    injected: [],
    deferred: [],
  };
  if (input.skills.length === 0) return empty;
  const requested: LoadedSkill[] = [];
  const seen = new Set<string>();
  for (const skill of [...(input.forced ?? []), ...skillsNamedInText(input.text, input.skills)]) {
    if (seen.has(skill.id)) continue;
    seen.add(skill.id);
    requested.push(skill);
  }
  if (requested.length === 0) return empty;
  // From here on every exit reports what the turn NAMED, even when nothing had to
  // be pasted in: a skill already loaded earlier is still the user's choice, and
  // dropping it here is how the constraint pointer used to get stolen by a
  // constraint-free skill that merely happened to be the new one.
  const named: SkillPreload = { ...empty, requested };

  const maxCount = input.maxCount ?? SKILL_PRELOAD_MAX_COUNT;
  const maxBytes = input.maxBytes ?? SKILL_PRELOAD_MAX_BYTES;
  const readFile = input.readSkillFile ?? readSkillFileText;
  const newToolCallId = input.newToolCallId ?? defaultToolCallId;
  const now = input.now ?? Date.now;

  // Read every named skill's CURRENT content once, before deciding anything.
  // Coverage is a claim about the file as it is now, not about the numbers a past
  // read happened to report (`readProvesCoverage`), so the dedupe needs the same
  // bytes the injection would use — and reading them once serves both.
  const sources = new Map<string, { text: string } | { error: unknown }>();
  for (const skill of requested) {
    try {
      sources.set(skill.id, { text: await readFile(skill) });
    } catch (error) {
      sources.set(skill.id, { error });
    }
  }
  const records = skillReadRecordsInTranscript(input.transcript, input.skills);
  const candidates = requested.filter((skill) => {
    const source = sources.get(skill.id);
    // Unreadable: cannot prove coverage, so it stays a candidate and fails
    // visibly in the loop below rather than being silently treated as loaded.
    if (!source || 'error' in source) return true;
    const currentHash = skillSourceHash(source.text);
    return !(records.get(skill.id) ?? []).some((record) => readProvesCoverage(record, currentHash));
  });
  if (candidates.length === 0) return named;

  const messages: AgentMessage[] = [];
  const injected: LoadedSkill[] = [];
  const deferred: LoadedSkill[] = [];
  let spent = 0;

  for (const skill of candidates) {
    if (injected.length >= maxCount) {
      deferred.push(skill);
      continue;
    }
    const source = sources.get(skill.id);
    if (!source || 'error' in source) {
      // A skill that will not load is a degraded turn, never a failed one: the
      // location is still named for the model, and the run continues.
      input.onSkipped?.(
        skill,
        `unreadable: ${String(source && 'error' in source ? source.error : 'missing')}`,
      );
      deferred.push(skill);
      continue;
    }
    const body = source.text;
    // The WHOLE file, and the args say so with an explicit `limit`.
    //
    // This used to take pi's default 2000-line slice, reasoning that a preloaded
    // body should never be more of the file than a model-issued read. That was
    // the wrong invariant to protect: a model CAN read a whole file by passing a
    // larger `limit`, so full coverage is a legal read shape — just not the
    // default one. Taking the default slice instead made a skill longer than
    // 2000 lines permanently half-loaded: the record says `lines < totalLines`,
    // so `readProvesCoverage` correctly refuses it, and the NEXT turn injects the
    // very same prefix again. The tail never arrived and every turn paid for the
    // head twice. No shipped builtin is that long (`slide-dsl`, the largest, is
    // 892 lines), but a user skill is capped in BYTES — 64KiB of short lines is
    // thousands of them.
    //
    // The byte budget below is what bounds size, and it now weighs what is
    // actually injected rather than a truncated prefix.
    const lines = body.split(/\r?\n/);
    const text = body;
    const bytes = Buffer.byteLength(text, 'utf8');
    // The first admission ignores the budget on purpose (see SKILL_PRELOAD_MAX_BYTES).
    if (injected.length > 0 && spent + bytes > maxBytes) {
      input.onSkipped?.(skill, `over the ${maxBytes}-byte preload budget`);
      deferred.push(skill);
      continue;
    }
    spent += bytes;

    const toolCallId = newToolCallId();
    const timestamp = now();
    const args = { path: skill.filePath, limit: lines.length };
    const result = {
      content: [{ type: 'text' as const, text }],
      details: {
        path: skill.filePath,
        offset: 1,
        lines: lines.length,
        totalLines: lines.length,
        skill: skill.id,
        // Identity of the WHOLE file, so a LATER turn can tell whether this load
        // still describes the skill as it is then (`readProvesCoverage`).
        sourceHash: skillSourceHash(body),
      },
    };
    messages.push({
      role: 'assistant',
      content: [{ type: 'toolCall', id: toolCallId, name: 'read', arguments: args }],
      api: input.model.api,
      provider: input.model.provider,
      model: input.model.id,
      usage: { ...EMPTY_USAGE, cost: { ...EMPTY_USAGE.cost } },
      stopReason: 'toolUse',
      timestamp,
    } as AssistantMessage as AgentMessage);
    messages.push({
      role: 'toolResult',
      toolCallId,
      toolName: 'read',
      content: result.content,
      details: result.details,
      isError: false,
      timestamp,
    } as ToolResultMessage as AgentMessage);
    injected.push(skill);
  }

  if (injected.length === 0) {
    // Nothing loadable. Still name what was asked for — a silent no-op is the
    // behaviour this file replaces.
    return {
      ...named,
      text: deferred.length ? `${input.text}\n\n${deferredNote(deferred, 0)}` : input.text,
      deferred,
    };
  }
  return {
    text: deferred.length
      ? `${input.text}\n\n${deferredNote(deferred, injected.length)}`
      : input.text,
    messages,
    requested,
    injected,
    deferred,
  };
}

/**
 * The one user message of a preloaded turn, in pi's own `prompt()` shape.
 *
 * Exported so the runner never hand-rolls a second definition: the array form of
 * `agent.prompt()` skips pi's string normalization, and this is that
 * normalization (`normalizePromptInput`) for the single text case.
 */
export function preloadUserMessage(text: string, now: () => number = Date.now): AgentMessage {
  return {
    role: 'user',
    content: [{ type: 'text', text }],
    timestamp: now(),
  } as AgentMessage;
}

/**
 * Which of the turn's skills the outline constraint check should point at.
 *
 * TAKES WHAT THE TURN NAMED, not what it happened to inject. Those differ: a skill
 * already loaded earlier in the conversation is deduped out of `injected` while
 * remaining entirely the user's choice, so scoping this to `injected` let a
 * constraint-free skill steal the pointer just by being the new one — write
 * `/lecture-style` once, then `/lecture-style /slide-dsl`, and the constraints
 * vanished on the second message.
 *
 * NOT simply the last one either. Only some skills carry a machine-checkable
 * constraint file: taking the last would point the constraint check at
 * `slide-dsl`, which has none, so the constraints the user ALSO asked for would be
 * silently skipped while the guardrail looked like it ran. The last CONSTRAINED
 * skill keeps the check pointed at something checkable; with none, the last named
 * skill stands so the pointer still follows the user's most recent choice.
 *
 * The constraint file is checked against the PERSISTED stage and does not depend on
 * the model having read the body, so a named skill the caps deferred is still a
 * legitimate target.
 */
export function preloadConstraintTarget(named: readonly LoadedSkill[]): LoadedSkill | undefined {
  return named.findLast((skill) => skill.constraints !== null) ?? named.at(-1);
}
