import type { LearningBoardDisplay, LearningConversationEntry } from './conversation';

type Part = LearningConversationEntry['parts'][number];
export type ToolPart = Extract<Part, { kind: 'tool' }>;
export type NarrationTarget = NonNullable<LearningBoardDisplay['target']>;

/**
 * One item of a reply as it is told. Each step is one part of the conversation stream, in
 * stream order: the bubble tells what the conversation lists. `part` is the step's place among
 * the reply's parts, which is what identifies it: a part's id changes when the stream finishes it.
 */
export type NarrationStep = { id: string; part: number } & (
  | { kind: 'say'; text: string; streaming: boolean }
  /**
   * A whiteboard call: its elements appear when the performance reaches it, and the board
   * comes into view with it, or goes out of view when the role puts it away.
   */
  | {
      kind: 'board';
      ids: string[];
      /** Elements this call took off the board. */
      removes?: string[];
      show?: boolean;
      clear?: boolean;
      tool: ToolPart;
    }
  /** A pointer on code or the running application, held while what follows is said. */
  | { kind: 'point'; target: NarrationTarget; tool: ToolPart }
  | { kind: 'tool'; tool: ToolPart }
);

/** Speech reads plain words: links keep their label, emphasis and code marks go. */
function spokenText(text: string) {
  return text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`#>]+/g, '')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

/** The stream parts of one reply as steps; thinking is never told. */
export function narrationSteps(entry: LearningConversationEntry): NarrationStep[] {
  return entry.parts.flatMap((part, index): NarrationStep[] => {
    const at = { id: part.id, part: index };
    if (part.kind === 'text') {
      const text = spokenText(part.text);
      return text ? [{ ...at, kind: 'say', text, streaming: !!part.streaming }] : [];
    }
    if (part.kind !== 'tool') return [];
    const display = (
      part.action === 'board' ? (part.display ?? {}) : {}
    ) as Partial<LearningBoardDisplay>;
    if (display.target && part.status === 'succeeded')
      return [{ ...at, kind: 'point', target: display.target, tool: part }];
    if (part.action === 'board' && display.op !== 'read')
      return [
        {
          ...at,
          kind: 'board',
          ids: display.ids ?? [],
          // Wiping the board is not a reason to look at it: an empty board stays away.
          show: display.op === 'close' ? false : display.op === 'clear' ? undefined : true,
          ...(display.op === 'clear' && part.status === 'succeeded' ? { clear: true } : {}),
          ...(display.removes?.length ? { removes: display.removes } : {}),
          tool: part,
        },
      ];
    return [{ ...at, kind: 'tool', tool: part }];
  });
}

/** The pointer in force at a step: the last one set, until the board is written again. */
export function pointerAt(steps: readonly NarrationStep[], index: number) {
  for (let at = Math.min(index, steps.length - 1); at >= 0; at--) {
    const step = steps[at];
    if (step.kind === 'point') return step;
    if (step.kind === 'board') return undefined;
  }
  return undefined;
}

/**
 * What the learner just said, while it is the latest thing said: from the moment it is sent
 * until the role's reply has its first words. The bubble holds it so a send is seen to land.
 */
export function learnerTurn(
  conversation: readonly LearningConversationEntry[],
  pending?: LearningConversationEntry | null,
) {
  const text = (entry?: LearningConversationEntry | null) =>
    entry?.parts.flatMap((part) => (part.kind === 'text' ? [part.text] : [])).join('\n') ||
    undefined;
  if (pending) return text(pending);
  const turns = conversation.filter((entry) => !entry.boundary);
  const last = turns.at(-1);
  if (last?.speaker === 'user') return text(last);
  const before = turns.at(-2);
  return last?.status === 'running' &&
    before?.speaker === 'user' &&
    !narrationSteps(last).some((step) => step.kind === 'say')
    ? text(before)
    : undefined;
}

/** Whether the role has the whiteboard in view at a step: its last board call decides. */
export function boardAt(steps: readonly NarrationStep[], index: number) {
  for (let at = Math.min(index, steps.length - 1); at >= 0; at--) {
    const step = steps[at];
    if (step.kind === 'board' && step.show !== undefined && step.tool.status === 'succeeded')
      return step;
  }
  return undefined;
}

/**
 * Replies the role offered with its last word, for the learner to pick from: only while
 * that reply is the latest thing said and nothing is being produced.
 */
export function suggestedReplies(conversation: readonly LearningConversationEntry[]) {
  const last = conversation.filter((entry) => !entry.boundary).at(-1);
  if (!last || last.speaker === 'user' || last.status !== 'succeeded') return [];
  const cue = last.parts.findLast(
    (part) => part.kind === 'tool' && part.name === 'cue_user' && part.status === 'succeeded',
  );
  const options =
    (cue?.kind === 'tool' ? (cue.args as { options?: unknown })?.options : undefined) ?? [];
  return Array.isArray(options)
    ? options
        .flatMap((option) => (typeof option === 'string' && option.trim() ? [option.trim()] : []))
        .slice(0, 4)
    : [];
}

/**
 * A reply as the bubble shows it: one piece of text and the tool calls that follow it, until
 * the next piece of text begins the next bubble. Tool calls made before any text open the
 * reply as a segment with no text.
 */
export interface NarrationSegment {
  /** Step range in the reply, both ends included. */
  from: number;
  to: number;
  say?: Extract<NarrationStep, { kind: 'say' }>;
  tools: ToolPart[];
}

export function narrationSegments(steps: readonly NarrationStep[]): NarrationSegment[] {
  const segments: NarrationSegment[] = [];
  steps.forEach((step, index) => {
    if (step.kind === 'say' || !segments.length)
      segments.push({
        from: index,
        to: index,
        tools: [],
        ...(step.kind === 'say' ? { say: step } : {}),
      });
    const segment = segments.at(-1)!;
    segment.to = index;
    if (step.kind !== 'say') segment.tools.push(step.tool);
  });
  return segments;
}

/**
 * Whiteboard changes in the order they were made, each with the step that made it: what was
 * put on the board, or the board being wiped.
 */
export function boardWrites(steps: readonly NarrationStep[]) {
  return steps.flatMap((step, index) =>
    step.kind === 'board' && (step.ids.length || step.clear)
      ? [{ index, ids: step.ids, clear: !!step.clear }]
      : [],
  );
}

/** How far a reply has been told: the part the playhead is on, and how much of its text. */
export interface NarrationProgress {
  /** The reply. */
  id: string;
  /** The place, among the reply's parts, of the step being told. */
  part: number;
  /** How much of that part's text is out, from 0 to 1. */
  said: number;
}

/**
 * The conversation as far as it has been told: the reply being told stops at the playhead,
 * with the text under it out as far as it has been said. Whatever shows the conversation
 * shows this, so going between the bubble and the pane never changes what has been said.
 */
export function toldConversation(
  conversation: readonly LearningConversationEntry[],
  told: NarrationProgress | null,
): readonly LearningConversationEntry[] {
  if (!told) return conversation;
  return conversation.map((entry) => {
    if (entry.id !== told.id) return entry;
    const parts = entry.parts.slice(0, told.part + 1).map((part, index) =>
      index === told.part && part.kind === 'text'
        ? {
            ...part,
            text: part.text.slice(0, Math.ceil(part.text.length * told.said)),
            streaming: true,
          }
        : part,
    );
    return { ...entry, parts };
  });
}
