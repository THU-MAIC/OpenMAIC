import { fromMarkdown } from 'mdast-util-from-markdown';
import type { LearningBoardDisplay, LearningConversationEntry } from './conversation';
import { parseFileReference } from './file-reference';

type Part = LearningConversationEntry['parts'][number];
export type ToolPart = Extract<Part, { kind: 'tool' }>;
export type NarrationTarget = NonNullable<LearningBoardDisplay['target']>;
type Point = { id: string; target: NarrationTarget };
type PointStep = Extract<NarrationStep, { kind: 'point' }>;

/**
 * One item of a reply as it is told. Each step is one part of the conversation stream, in
 * stream order: the bubble tells what the conversation lists. `part` is the step's place among
 * the reply's parts, which is what identifies it: a part's id changes when the stream finishes it.
 */
export type NarrationStep = { id: string; part: number } & (
  | {
      kind: 'say';
      text: string;
      streaming: boolean;
      /** A paragraph of a multi-location explanation, within the original Markdown part. */
      passage?: { from: number; to: number; point: Point | null };
    }
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
  | { kind: 'point'; target: NarrationTarget; tool: ToolPart; untilSpeech?: Point }
  | { kind: 'tool'; tool: ToolPart }
);

/** Speech reads plain words: links keep their label, emphasis and code marks go. */
export function spokenText(text: string, streaming = false) {
  // The playback buffer only appends. Consume complete links first and withhold a
  // possible final link (including an image's "!") until its label is stable.
  return text
    .replace(
      /!?\[([^\]]*)\]\([^)]*\)|!?\[[^\]]*(?:\](?:\([^)]*)?)?$|!$/gu,
      (match, label: string | undefined) => label ?? (streaming ? '' : match),
    )
    .replace(/[*_`#>]+/g, '')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

/** A legacy receipt can republish speech after it was voiced, then append a new direction. */
export function unspokenReceipt(text: string, delivered: Iterable<string>) {
  let rest = text;
  for (const previous of delivered) {
    if (rest === previous) return '';
    if (!previous || !rest.startsWith(previous)) continue;
    const suffix = rest.slice(previous.length);
    // A longer number, filename or unfinished word is a different statement.
    if (/^\s/u.test(suffix) || /[。！？]$/u.test(previous)) rest = suffix.trimStart();
  }
  return rest;
}

type MarkdownBlock = ReturnType<typeof fromMarkdown>['children'][number];

/** Resolve only locations the role actually pointed at before this explanation. */
function passagePoint(block: MarkdownBlock, points: readonly Point[]) {
  const links: string[] = [];
  function visit(node: MarkdownBlock) {
    if (node.type === 'link') links.push(node.url);
    else if ('children' in node) node.children.forEach(visit);
  }
  visit(block);
  let cited: Point | undefined;
  for (const href of links) {
    const ref = parseFileReference(href);
    if (!ref?.line) continue;
    const line = ref.line;
    const end = ref.end ?? line;
    const containing = points.filter(
      ({ target }) =>
        'path' in target &&
        target.path === ref.path &&
        target.line <= line &&
        (target.end ?? target.line) >= end,
    );
    const exact = containing.findLast(
      ({ target }) =>
        'path' in target && target.line === line && (target.end ?? target.line) === end,
    );
    const point = exact ?? (containing.length === 1 ? containing[0] : undefined);
    if (!point || (cited && point !== cited)) return null;
    cited = point;
  }
  return cited ?? points.at(-1)!;
}

// A receipt with a source frame may be all that fits on a history page. It is
// readable evidence of earlier speech, never a new utterance for the playhead.
function isSpokenReceipt(part: Extract<Part, { kind: 'text' }>) {
  return part.spokenAt !== undefined && part.id.startsWith('question-');
}

/** The stream parts of one reply as steps; thinking is never told. */
export function narrationSteps(
  entry: LearningConversationEntry,
  nextInstruction?: string,
  afterMention?: { label: string; confirmation: string },
): NarrationStep[] {
  let namedNextAction = false;
  let announcedCompletion = false;
  let pendingPoints: PointStep[] = [];
  let explanationPoints: PointStep[] = [];
  // Later cues should not flash past the first location before its explanation starts.
  function holdForSpeech(points: PointStep[]) {
    for (const next of points.slice(1)) next.untilSpeech = points[0];
  }
  const steps = entry.parts.flatMap((part, index): NarrationStep[] => {
    const at = { id: part.id, part: index };
    if (part.kind === 'text') {
      if (isSpokenReceipt(part)) return [];
      const text = spokenText(part.text, part.streaming);
      if (!text) return [];
      if (afterMention?.label && text.includes(afterMention.label)) namedNextAction = true;
      // A model can explain one batch of cues in several consecutive text parts.
      // A new pointing sequence or a whiteboard change starts a new explanation.
      if (pendingPoints.length) {
        explanationPoints = pendingPoints;
        holdForSpeech(explanationPoints);
        pendingPoints = [];
      }
      if (explanationPoints.length < 2)
        return [{ ...at, kind: 'say', text, streaming: !!part.streaming }];

      // Each paragraph gets its own voice segment. Its target changes at the same playhead
      // as the words, including when muted or paused. Keep the transcript in source coordinates.
      const blocks = fromMarkdown(part.text).children.flatMap<MarkdownBlock>((block) =>
        block.type === 'list' ? block.children : [block],
      );
      const steps: NarrationStep[] = [];
      for (const block of blocks) {
        const start = block.position!.start.offset!;
        const end = block.position!.end.offset!;
        // The next delta may finish a link or its paragraph. Do not voice a partial cue.
        if (part.streaming && block === blocks.at(-1)) break;
        const words = spokenText(part.text.slice(start, end));
        if (!words) continue;
        steps.push({
          ...at,
          id: `${part.id}:passage-${start}`,
          kind: 'say',
          text: words,
          streaming: false,
          passage: {
            from: start / part.text.length,
            to: end / part.text.length,
            point: passagePoint(block, explanationPoints),
          },
        });
      }
      return steps;
    }
    if (part.kind !== 'tool') return [];
    const display = (
      part.action === 'board' ? (part.display ?? {}) : {}
    ) as Partial<LearningBoardDisplay>;
    if (display.target && part.status === 'succeeded') {
      const point: PointStep = { ...at, kind: 'point', target: display.target, tool: part };
      explanationPoints = [];
      if ('path' in display.target) pendingPoints.push(point);
      else pendingPoints = [];
      return [point];
    }
    if (
      part.action === 'board' &&
      part.status === 'succeeded' &&
      display.op !== 'read' &&
      display.op !== 'close'
    ) {
      pendingPoints = [];
      explanationPoints = [];
    }
    if (part.action === 'board' && display.op !== 'read' && display.op !== 'point')
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
    const tool: NarrationStep = { ...at, kind: 'tool', tool: part };
    // The same successful completion that enables the next button owns its instruction.
    // A failed attempt, a review question and the final project recap have no such handoff.
    if (
      nextInstruction &&
      !announcedCompletion &&
      part.action === 'complete' &&
      part.status === 'succeeded' &&
      part.readyForStudentConfirmation &&
      !part.projectCompleted
    ) {
      announcedCompletion = true;
      const instruction =
        afterMention && namedNextAction ? afterMention.confirmation : nextInstruction;
      return [
        tool,
        { ...at, kind: 'say', id: part.id + ':continue', text: instruction, streaming: false },
      ];
    }
    return [tool];
  });
  // While the stream is open there may still be speech. A finished, tool-only sequence
  // retains its individual actions, including its final location.
  if (entry.status === 'running') holdForSpeech(pendingPoints);
  return steps;
}

/** The pointer in force at a step: the last one set, until the board is written again. */
export function pointerAt(steps: readonly NarrationStep[], index: number) {
  let closed = false;
  for (let at = Math.min(index, steps.length - 1); at >= 0; at--) {
    const step = steps[at];
    if (step.kind === 'say' && step.passage) return step.passage.point ?? undefined;
    if (step.kind === 'point')
      return closed && 'selector' in step.target ? undefined : (step.untilSpeech ?? step);
    if (step.kind !== 'board' || step.tool.status !== 'succeeded') continue;
    if (step.show !== false) return undefined;
    closed = true;
  }
  return undefined;
}

/** A successful tool-only retry displays the committed handoff without queuing speech again. */
export function recoveredReviewSpeech(entry?: LearningConversationEntry) {
  if (!entry || (entry.status !== undefined && entry.status !== 'succeeded')) return;
  const closing = entry.parts.findLast((part) => part.kind === 'text' && part.text.trim());
  if (closing?.kind === 'text') {
    if (isSpokenReceipt(closing)) return { id: closing.id, text: spokenText(closing.text) };
    if (!closing.id.startsWith('question-')) return;
  }
  if (entry.restingHandoff) return { id: entry.id, text: spokenText(entry.restingHandoff) };
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
