/**
 * The request preview's SCHEDULER: a pure function of (track, clock) → view.
 *
 * The preview has a small, fixed palette of calm scenes, each standing for a
 * stretch of work that lasts seconds to minutes. Every action the stream can
 * report maps onto one of them (`sceneOfTool`); actions that take
 * milliseconds — a skill read, listing voices — never earn a scene of their
 * own and fold into whatever is showing. There is no assumed order between
 * the scenes: the view follows the stream.
 *
 *  - understanding  the model reading the request: thinking, replying, skill
 *                   and reference reads, any short or unknown tool.
 *  - researching    web search and page fetches.
 *  - asking         the agent waits on the user: an `ask_user` question,
 *                   whatever it is about, with what the agent wrote before it.
 *  - assembling     creating the course and casting its classroom.
 *  - generating     writing pages, their actions and narration.
 *
 * Rules:
 *  1. Understanding never pulls the view back: once another scene showed, the
 *     agent thinking or reading between steps stays inside it. The one way
 *     back is answering a question, which hands the request back to the agent
 *     to think.
 *  2. A scene holds the screen for at least `holdMs`. Changes that arrive
 *     sooner wait; at the switch the next scene in order is shown, unless the
 *     screen has fallen more than `maxLagMs` behind — then the newest. Once the
 *     roster exists, assembling also holds until its cards have flipped.
 *  3. A request that only talks stays quiet (the conversation shows it); one
 *     that ends without a page folds once its scene has been held; the first
 *     persisted page hands over to the classroom.
 *
 * No timers here: a live caller passes `Date.now()` (never earlier than the
 * track's newest timestamp) and re-renders at `nextChangeAt`.
 */
import type { RequestQuestion, RequestStep, RequestTrack } from './request-activity';
import { skillLoadId } from './skill-load';

export interface RequestScheduleOptions {
  /** Minimum time a scene stays on screen. */
  readonly holdMs: number;
  /** How far the screen may fall behind before it skips to the newest scene. */
  readonly maxLagMs: number;
}

/**
 * The classic roster reveal's pace (`components/agent/agent-reveal-modal.tsx`):
 * the first card after a short beat, then one every half second, then a beat
 * to take the last one in.
 */
export const ROSTER_REVEAL = { leadMs: 400, perCardMs: 500, tailMs: 600 } as const;

export function rosterRevealMs(count: number): number {
  if (count <= 0) return 0;
  return ROSTER_REVEAL.leadMs + (count - 1) * ROSTER_REVEAL.perCardMs + ROSTER_REVEAL.tailMs;
}

export const DEFAULT_REQUEST_SCHEDULE: RequestScheduleOptions = {
  holdMs: 2000,
  maxLagMs: 3000,
};

export const REQUEST_SCENES = [
  'understanding',
  'researching',
  'asking',
  'assembling',
  'generating',
] as const;

export type RequestSceneId = (typeof REQUEST_SCENES)[number];

const SEARCH_TOOLS = new Set(['web_search', 'fetch_url']);
const ASSEMBLY_TOOLS = new Set([
  'create_stage',
  'rename_stage',
  'create_folder',
  'move_to_folder',
  'set_roster',
  'list_voices',
  'register_voice',
]);
const PAGE_TOOLS = new Set([
  'generate_scene',
  // The pages' media: a real image takes tens of seconds, so it is page work,
  // not a quick read folded into whatever scene was showing.
  'generate_image',
  'generate_video',
  'generate_actions',
  'generate_tts',
  'clip_audio',
  'duplicate_scene',
  'patch_stage',
  'edit_deck',
  'render_scene_preview',
]);
const SPEECH_TOOLS = new Set(['generate_tts', 'generate_actions', 'clip_audio']);

/** The scene a tool call belongs to. Anything not listed is understanding. */
export function sceneOfTool(tool: string): RequestSceneId {
  if (SEARCH_TOOLS.has(tool)) return 'researching';
  if (ASSEMBLY_TOOLS.has(tool)) return 'assembling';
  if (PAGE_TOOLS.has(tool)) return 'generating';
  return 'understanding';
}

export type RequestPreviewMode =
  /** The request has only talked so far: the conversation shows that. */
  | 'quiet'
  /** A scene is on screen. */
  | 'scene'
  /** The request ended without a page: the panel folds away. */
  | 'collapsed'
  /** The first page exists: the classroom takes over. */
  | 'classroom';

export interface RequestPreviewView {
  readonly mode: RequestPreviewMode;
  readonly scene: RequestSceneId;
  /** The open question, while the agent waits on the user. */
  readonly question: RequestQuestion | null;
  /** The cast, once `set_roster` returned it: who the classroom's agents are. */
  readonly roster: readonly RosterAgent[] | null;
  /** The page being written, for the generating scene's caption. */
  readonly page: { readonly order: number; readonly step: RequestStep } | null;
  /** Narration or actions are being produced right now. */
  readonly speaking: boolean;
  /** The searches made so far, for the researching scene. */
  readonly searches: readonly RequestStep[];
  /** The skills the agent loaded for this request, by id, in load order. */
  readonly skills: readonly string[];
  /** When the next scheduled change falls due, or null. */
  readonly nextChangeAt: number | null;
}

/** One agent of the classroom, as `set_roster` returned it. */
export interface RosterAgent {
  readonly id: string;
  readonly name: string;
  readonly role: string;
  readonly persona: string;
  readonly avatar: string;
  readonly color: string;
}

const str = (value: unknown): string => (typeof value === 'string' ? value : '');

/** When the newest cast by `now` was set, or null: a later set_roster is a new cast. */
export function latestRosterAt(track: RequestTrack, now: number): number | null {
  return rosterOf(track.steps, now)?.at ?? null;
}

/** The newest roster a finished `set_roster` returned by `now`, and when. */
function rosterOf(
  steps: readonly RequestStep[],
  now: number,
): { readonly agents: RosterAgent[]; readonly at: number } | null {
  for (const step of [...steps].reverse()) {
    if (step.tool !== 'set_roster' || step.endedAt === undefined || step.endedAt > now) continue;
    const details = step.node.toolDetails as { roster?: unknown } | undefined;
    if (!Array.isArray(details?.roster)) continue;
    const agents = details.roster.flatMap((entry, index): RosterAgent[] => {
      const agent = (entry ?? {}) as Record<string, unknown>;
      const name = str(agent.name);
      if (!name) return [];
      return [
        {
          id: str(agent.id) || `agent-${index}`,
          name,
          // The roles the classroom (and the reveal card's copy) know; anything else is a student.
          role: ['teacher', 'assistant', 'student'].includes(str(agent.role))
            ? str(agent.role)
            : 'student',
          persona: str(agent.persona),
          avatar: str(agent.avatar),
          color: /^#[0-9a-f]{6}$/i.test(str(agent.color)) ? str(agent.color) : '#8b5cf6',
        },
      ];
    });
    if (agents.length > 0) return { agents, at: step.endedAt };
  }
  return null;
}

interface Signal {
  readonly ts: number;
  readonly scene: RequestSceneId;
  /** Takes effect even when it would pull the view back to understanding. */
  readonly force?: boolean;
  /** The user is waited on: shown at once, without the hold. */
  readonly urgent?: boolean;
  /** When the step behind this signal ended; open-ended otherwise. */
  readonly endedAt?: number;
}

/** A change whose steps were all over within this long is a passing moment. */
const BRIEF_MS = 1000;

interface SceneChange {
  readonly ts: number;
  readonly scene: RequestSceneId;
  readonly urgent?: boolean;
  /** When the last step of this stretch ended, or undefined while one runs or it is no step. */
  readonly endedAt?: number;
}

function sceneChanges(track: RequestTrack, now: number): SceneChange[] {
  const signals: Signal[] = [];
  for (const step of track.steps) {
    signals.push({ ts: step.ts, scene: sceneOfTool(step.tool), endedAt: step.endedAt });
  }
  for (const thought of track.thoughts) signals.push({ ts: thought.ts, scene: 'understanding' });
  for (const question of track.questions) {
    signals.push({ ts: question.ts, scene: 'asking', urgent: true });
    if (question.answeredAt !== null) {
      signals.push({ ts: question.answeredAt, scene: 'understanding', force: true });
    }
  }
  signals.sort((a, b) => a.ts - b.ts);

  const changes: SceneChange[] = [{ ts: track.startedAt, scene: 'understanding' }];
  for (const signal of signals) {
    if (signal.ts > now) break;
    const target = changes[changes.length - 1].scene;
    if (signal.scene === target) {
      // A question for the scene already waiting to show brings it forward.
      const last = changes[changes.length - 1];
      changes[changes.length - 1] = {
        ...last,
        urgent: last.urgent || (signal.urgent && changes.length > 1),
        endedAt:
          last.endedAt === undefined || signal.endedAt === undefined
            ? undefined
            : Math.max(last.endedAt, signal.endedAt),
      };
      continue;
    }
    if (signal.scene === 'understanding' && !signal.force) continue;
    changes.push({
      ts: signal.ts,
      scene: signal.scene,
      urgent: signal.urgent,
      endedAt: signal.endedAt,
    });
  }
  return changes;
}

const minDue = (a: number | null, b: number): number => (a === null ? b : Math.min(a, b));

/**
 * What this viewer has already seen. The stream says when the roster was set;
 * only the viewer knows when it first saw it — a page opened or reloaded after
 * `set_roster` replays straight into generation, and the cast would never be
 * revealed to it.
 */
export interface RequestViewerMemory {
  /** When this viewer first had the roster in hand, or null. */
  readonly rosterSeenAt: number | null;
}

export function scheduleRequestPreview(
  track: RequestTrack,
  now: number,
  options: RequestScheduleOptions = DEFAULT_REQUEST_SCHEDULE,
  viewer: RequestViewerMemory = { rosterSeenAt: null },
): RequestPreviewView {
  const { holdMs, maxLagMs } = options;
  const changes = sceneChanges(track, now);
  const roster = rosterOf(track.steps, now);

  // ── Which scene is on screen: hold, then the next one in order ───────────
  let shown = 0;
  let shownAt = changes[0].ts;
  let nextChangeAt: number | null = null;
  while (shown < changes.length - 1) {
    const next = changes[shown + 1];
    let switchAt = next.urgent ? next.ts : Math.max(next.ts, shownAt + holdMs);
    if (changes[shown].scene === 'assembling' && roster && roster.at <= switchAt && !next.urgent) {
      // Let the cards finish flipping before the classroom moves on.
      switchAt = Math.max(
        switchAt,
        Math.max(roster.at, shownAt) + rosterRevealMs(roster.agents.length),
      );
    }
    if (switchAt > now) {
      nextChangeAt = switchAt;
      break;
    }
    let newest = shown + 1;
    while (newest + 1 < changes.length && changes[newest + 1].ts <= switchAt) newest += 1;
    let target = switchAt - changes[newest].ts > maxLagMs ? newest : shown + 1;
    // A passing moment — a scene whose steps were all over within a second, with
    // something already after it — is not worth a scene: two millisecond calls
    // interleaved with a long one would otherwise flip the view back and forth.
    while (target < newest) {
      const change = changes[target];
      const brief =
        !change.urgent &&
        change.endedAt !== undefined &&
        change.endedAt - change.ts < BRIEF_MS &&
        !(roster && change.scene === 'assembling' && changes[target + 1].ts >= roster.at);
      if (!brief) break;
      target += 1;
    }
    // Catching up never skips the cast's reveal.
    if (roster) {
      for (let index = shown + 1; index < target; index += 1) {
        if (changes[index].scene === 'assembling' && changes[index + 1].ts >= roster.at) {
          target = index;
          break;
        }
      }
    }
    shown = target;
    shownAt = switchAt;
  }
  let scene = changes[shown].scene;

  // ── The cast's reveal runs from when this viewer first saw it ───────────
  // The cards flip from the moment the preview shows them: a viewer who
  // opened (or reopened a hidden preview) after set_roster, however soon,
  // keeps the scene until that reveal has finished.
  if (roster && viewer.rosterSeenAt !== null && scene !== 'asking') {
    const revealEnds = viewer.rosterSeenAt + rosterRevealMs(roster.agents.length);
    if (now < revealEnds && viewer.rosterSeenAt >= roster.at) {
      scene = 'assembling';
      nextChangeAt = minDue(nextChangeAt, revealEnds);
    }
  }

  // ── What the scene shows ─────────────────────────────────────────────────
  const visibleSteps = track.steps.filter((step) => step.ts <= now);
  const latestQuestion = track.question;
  const questionOpen =
    latestQuestion !== null && latestQuestion.ts <= now && latestQuestion.answeredAt === null;
  const question = scene === 'asking' && questionOpen ? latestQuestion : null;
  const pages = visibleSteps.filter(
    (step) => step.tool === 'generate_scene' && step.order !== undefined,
  );
  const latestPage = pages[pages.length - 1];
  const page = latestPage ? { order: latestPage.order as number, step: latestPage } : null;
  const generatingSteps = visibleSteps.filter((step) => sceneOfTool(step.tool) === 'generating');
  const latestGenerating = generatingSteps[generatingSteps.length - 1];
  const speaking =
    !!latestGenerating &&
    SPEECH_TOOLS.has(latestGenerating.tool) &&
    (latestGenerating.endedAt === undefined || latestGenerating.endedAt > now);
  const searches = visibleSteps.filter((step) => SEARCH_TOOLS.has(step.tool));
  // Skills the agent equipped for this request, in the order it loaded them.
  const skills = [
    ...new Set(
      visibleSteps.flatMap((step) => {
        const id = skillLoadId(step.node);
        return id ? [id] : [];
      }),
    ),
  ];
  const base = {
    scene,
    question,
    roster: roster?.agents ?? null,
    page,
    speaking,
    searches,
    skills,
  };

  if (track.firstSceneAt !== null && track.firstSceneAt <= now) {
    return { ...base, mode: 'classroom', nextChangeAt: null };
  }
  // ── Only talking so far ──────────────────────────────────────────────────
  if (visibleSteps.length === 0 && !track.questions.some((asked) => asked.ts <= now)) {
    return { ...base, mode: 'quiet', nextChangeAt };
  }
  // ── The request ended without a page ─────────────────────────────────────
  let mode: RequestPreviewMode = 'scene';
  if (!track.live) {
    const settleAt = Math.max(track.lastTs, shownAt + holdMs);
    if (settleAt <= now) mode = 'collapsed';
    else nextChangeAt = minDue(nextChangeAt, settleAt);
  }
  return { ...base, mode, nextChangeAt };
}
