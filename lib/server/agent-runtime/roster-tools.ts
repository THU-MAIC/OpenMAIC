/**
 * Classroom roster tools: `set_roster` and `list_voices`.
 *
 * The roster is the single source of truth for "who teaches this stage": it
 * lands in the stage document as `stage.generatedAgentConfigs` (the same slot
 * the classic generation pipeline writes), and `stage.agentIds` points at the
 * generated ids — mirroring the client-side generation flow. `set_roster`
 * replaces the retired `generate_roster`: the model writes the roster itself,
 * settled with the user in chat.
 *
 * Voice bindings are validated against the deployment's actual voice catalog —
 * the exact list `list_voices` reports — so a binding that passes here is
 * guaranteed synthesizable:
 *
 *  - presets of every served, keyed provider, excluding providers flagged
 *    `excludeFromAgentVoiceCatalog` (paid showcase presets must never reach
 *    the agent, even when configured);
 *  - voices registered THIS session by `register_voice` (voice cloning is an
 *    in-session loop; the roster keeps the durable record), visible when the
 *    deployment has a registration backend.
 *
 * The store passed in is the owner-bound document store of the run's session
 * owner (see `runner.ts`), so a foreign or missing stage reads as absent and
 * cannot be written — the same fail-closed owner probe every other stage tool
 * relies on.
 */
import { nanoid } from 'nanoid';
import { Type, type Static } from 'typebox';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { DocumentStore, MaicDocument } from '@openmaic/storage';
import type { GeneratedAgentConfig, Stage } from '@openmaic/dsl';

import type { Scene } from '@/lib/types/stage';
import { normalizeVoiceDesign } from '@/lib/audio/voice-design';
import { TTS_PROVIDERS } from '@/lib/audio/constants';
import {
  buildVoiceCatalog,
  type CatalogVoice,
  type RegisteredVoiceInfo,
  type VoiceCatalogProvider,
} from '@/lib/audio/voice-catalog';
import { supportsVoiceRegistration } from '@/lib/audio/voice-registration';
import { AGENT_COLOR_PALETTE, AGENT_DEFAULT_AVATARS } from '@/lib/constants/agent-defaults';
import { enabledServerTTSProviderIds, resolveTTSApiKey } from '@/lib/server/provider-config';
import type { CheckpointInfo } from './course-tools';
import { COURSE_STAGE_ID_DESCRIPTION } from './course-stage';
import { markDocumentWritersSequential } from './course-tools';
import { runStageMutation } from './mutation-fence';

export type CourseDocument = MaicDocument<Scene, Stage>;
export type CourseStore = DocumentStore<Scene, Stage>;

export interface RosterToolDeps {
  /** The owner-bound document store of the run's session owner. */
  store: CourseStore;
  /** Emitted after a successful roster write (the durable `checkpoint` event). */
  onCheckpoint: (info: CheckpointInfo) => void;
  /** The session id, recorded as the producer reference on the document. */
  sessionId?: string;
  /**
   * Session-scoped voices registered by `register_voice` (not persisted —
   * voice cloning is an in-session loop). `list_voices` and `set_roster`'s
   * binding validation read this; the runner threads ONE array into both
   * `buildVoiceCloneTools` and `buildRosterTools`.
   */
  registeredVoices?: RegisteredVoiceInfo[];
}

// ── Roster helpers ──────────────────────────────────────────────────────────

/** Parse an LLM-emitted `providerId::voiceId` binding, or undefined. */
export function parseVoiceConfig(
  voice?: string,
): { providerId: string; voiceId: string } | undefined {
  if (!voice || !voice.includes('::')) return undefined;
  const [providerId, voiceId] = voice.split('::');
  if (!providerId || !voiceId) return undefined;
  return { providerId, voiceId };
}

/**
 * The agent-facing voice catalog for this deployment: presets of every served,
 * keyed provider (excluding providers flagged off the agent catalog and
 * keyless providers synthesis would silently skip), plus voices registered
 * this session by `register_voice`.
 *
 * A served provider whose presets are excluded from the agent catalog still
 * contributes its session-registered clones: its preset list is offered empty
 * and the adapter seam decides what can be registered on it, so the
 * register → list → bind loop never dead-ends on an id the agent was shown.
 *
 * `list_voices` reports exactly this list, and `set_roster`'s binding
 * validation requires membership in it, so the agent can only ever bind a
 * voice it was actually shown (or just registered). One shared implementation
 * for both.
 */
export function agentVoiceCatalog(registeredVoices: RegisteredVoiceInfo[] = []): CatalogVoice[] {
  const providers: VoiceCatalogProvider[] = [];
  for (const id of enabledServerTTSProviderIds()) {
    const config = TTS_PROVIDERS[id as keyof typeof TTS_PROVIDERS];
    if (!config) continue;
    if (config.excludeFromAgentVoiceCatalog === true) {
      // Paid showcase presets never reach the agent, but a clone registered
      // this session through the provider's registration adapter must stay
      // bindable — offer the provider with an empty preset list.
      if (config.requiresApiKey && !resolveTTSApiKey(id)) continue;
      if (!supportsVoiceRegistration(id)) continue;
      providers.push({ id, voices: [] });
      continue;
    }
    if (config.requiresApiKey && !resolveTTSApiKey(id)) continue;
    providers.push(config);
  }
  // A registration backend means clone-kind registered voices are
  // synthesizable and therefore bindable (the session loop is live).
  return buildVoiceCatalog(providers, registeredVoices, {
    supportsClone: providers.some((provider) => supportsVoiceRegistration(provider.id)),
  });
}

/**
 * Shared persistence for a roster: write `stage.generatedAgentConfigs` (the
 * single source of truth) and point `stage.agentIds` at the generated ids.
 */
async function persistRoster(
  store: CourseStore,
  doc: CourseDocument,
  roster: GeneratedAgentConfig[],
  signal?: AbortSignal,
): Promise<void> {
  const now = Date.now();
  const stage: Stage = {
    ...doc.stage,
    generatedAgentConfigs: roster,
    agentIds: roster.map((agent) => agent.id),
    updatedAt: now,
  };
  await runStageMutation(signal, () =>
    store.saveDocument({
      stage,
      scenes: doc.scenes,
      outline: doc.outline,
    }),
  );
}

// ── Tool parameter schemas ──────────────────────────────────────────────────

/** list_voices is deployment-level — no stage scope, no parameters. */
const LIST_VOICES_PARAMS = Type.Object({});

const SET_ROSTER_AGENT_PARAMS = Type.Object({
  id: Type.Optional(
    Type.String({ description: 'Stable agent id; a `gen-<8-char>` id is minted when omitted.' }),
  ),
  name: Type.String({ description: 'Display name, in the stage language.' }),
  role: Type.String({ description: '"teacher" | "assistant" | "student"' }),
  persona: Type.String({
    description:
      "2-3 concrete sentences naming the agent's personality and teaching/learning style, written in the stage language — not a role label. A teacher persona names how they teach (questioning, example-led, strict-but-fair); a student persona names how they learn (curious, hesitant, fast).",
  }),
  avatar: Type.Optional(
    Type.String({ description: 'Avatar path; cycled from the default pool when omitted.' }),
  ),
  color: Type.Optional(
    Type.String({ description: 'Hex color; cycled from the palette when omitted.' }),
  ),
  priority: Type.Optional(
    Type.Number({
      description: 'teacher=10, assistant=7, student=4-6; derived from role when omitted.',
    }),
  ),
  voice: Type.Optional(
    Type.String({
      description:
        'TTS voice binding as a `providerId::voiceId` pair, e.g. "tts-provider::voice-name". Call list_voices first and bind exactly one pair from its return; a cloned voice binds the exact pair register_voice returned. Never invent an id. Omit to leave the voice unbound, which falls back to the provider default at call time.',
    }),
  ),
  voiceDesign: Type.Optional(
    Type.Object({
      identity: Type.String({
        description: 'gender + age + role, e.g. "middle-aged male teacher"',
      }),
      texture: Type.String({
        description: 'pitch + vocal quality, e.g. "warm low-pitched slightly husky"',
      }),
      delivery: Type.String({ description: 'emotion + pace, e.g. "calm measured encouraging"' }),
    }),
  ),
});

const SET_ROSTER_PARAMS = Type.Object({
  stageId: Type.String({ description: COURSE_STAGE_ID_DESCRIPTION }),
  agents: Type.Array(SET_ROSTER_AGENT_PARAMS, {
    description:
      'The explicit roster: exactly 1 teacher and at least 2 agents total. Written to stage.generatedAgentConfigs verbatim (voiceDesign kept; `voice` is bound when supplied).',
  }),
});

// ── Tools ───────────────────────────────────────────────────────────────────

/** Build the typed classroom-roster tools for the session runner. */
export function buildRosterTools(deps: RosterToolDeps): AgentTool<never, never>[] {
  const listVoices: AgentTool<typeof LIST_VOICES_PARAMS, unknown> = {
    name: 'list_voices',
    label: 'List available voices',
    description:
      'List every TTS voice this deployment actually serves and can bind to the roster: one flat entry per `providerId::voiceId` pair, with display name, language and gender. ' +
      'Call this BEFORE set_roster and bind `voice` from exactly one returned pair — never invent an id. ' +
      'A cloned voice registered this session with register_voice appears here too.',
    parameters: LIST_VOICES_PARAMS,
    async execute() {
      const catalog = agentVoiceCatalog(deps.registeredVoices);
      const voices = catalog.map((voice) => ({
        binding: voice.binding,
        providerId: voice.providerId,
        voiceId: voice.id,
        name: voice.name,
        language: voice.language,
        ...(voice.gender ? { gender: voice.gender } : {}),
      }));
      const text =
        voices.length > 0
          ? JSON.stringify(voices, null, 2)
          : 'This deployment serves no bindable TTS voices. Omit `voice` in set_roster; narration will be skipped or fall back to the deployment default.';
      return {
        content: [{ type: 'text', text }],
        details: { voices },
      };
    },
  };

  const setRoster: AgentTool<typeof SET_ROSTER_PARAMS, unknown> = {
    name: 'set_roster',
    label: 'Set classroom roster',
    description:
      'Write the classroom roster as you and the user settled it in chat: pass every agent (exactly ONE teacher, at least 2 agents total) with name/role/persona and optional avatar/color/priority/voiceDesign. ' +
      'Personas are 2-3 concrete sentences naming personality and teaching/learning style, in the stage language. ' +
      'Bind `voice` as a `providerId::voiceId` pair from the list_voices result (or the exact pair register_voice returned for a cloned voice); never invent an id, and omit voice when no usable voice exists (narration then falls back to the provider default). ' +
      'Persists `stage.generatedAgentConfigs` and drives scene/discussion generation from then on; re-calling replaces the roster.',
    parameters: SET_ROSTER_PARAMS,
    async execute(_id, params: Static<typeof SET_ROSTER_PARAMS>, signal) {
      if (signal?.aborted) throw new Error('aborted');
      const stageId = params.stageId;
      if (signal?.aborted) throw new Error('aborted');
      if (!params.agents || params.agents.length < 2) {
        return {
          content: [
            {
              type: 'text',
              text: `set_roster needs at least 2 agents, got ${params.agents?.length ?? 0}.`,
            },
          ],
          details: { error: 'at-least-2-agents' },
          isError: true,
        };
      }
      const teacherCount = params.agents.filter((agent) => agent.role === 'teacher').length;
      if (teacherCount !== 1) {
        return {
          content: [
            {
              type: 'text',
              text: `set_roster needs exactly 1 teacher, got ${teacherCount}. Roles: ${params.agents
                .map((agent) => `${agent.name}:${agent.role}`)
                .join(', ')}.`,
            },
          ],
          details: { error: 'teacher-count', teacherCount },
          isError: true,
        };
      }

      const doc = await deps.store.loadDocument(stageId);
      if (signal?.aborted) throw new Error('aborted');
      if (!doc) {
        return {
          content: [
            {
              type: 'text',
              text: 'No stage document yet — call create_stage first, then set_roster.',
            },
          ],
          details: { blocked: 'no-document' },
          isError: true,
        };
      }

      // A binding is only worth persisting when synthesis can actually honour
      // it. It must be one of the voices list_voices reports — the deployment's
      // served, keyed providers' presets plus voices registered this session —
      // so the agent binds only what it was shown (or just registered).
      // `agentVoiceCatalog` already excludes unserved providers, keyless
      // providers (whose bindings synthesis would silently drop) and paid
      // showcase presets, so a binding that passes here is guaranteed
      // synthesizable. A voice registered in an earlier session is NOT in the
      // catalog (registration is session-scoped by design): re-register it,
      // bind a catalog voice, or omit `voice`.
      const catalog = agentVoiceCatalog(deps.registeredVoices);
      const catalogBindings = new Set(catalog.map((voice) => voice.binding));
      const unusableBinding = params.agents
        .map((agent) => parseVoiceConfig(agent.voice))
        .find(
          (config) => config && !catalogBindings.has(`${config.providerId}::${config.voiceId}`),
        );
      if (unusableBinding) {
        return {
          content: [
            {
              type: 'text',
              text:
                `set_roster got voice "${unusableBinding.providerId}::${unusableBinding.voiceId}", which is not in this deployment's available voice catalog. ` +
                `Call list_voices for the exact bindable pairs (a cloned voice appears there only after register_voice returns it), or omit \`voice\` to leave the agent unbound.`,
            },
          ],
          details: {
            error: 'voice-not-in-catalog',
            voice: `${unusableBinding.providerId}::${unusableBinding.voiceId}`,
            availableBindings: [...catalogBindings],
          },
          isError: true,
        };
      }

      const roster: GeneratedAgentConfig[] = params.agents.map((agent, index) => {
        const voiceDesign = normalizeVoiceDesign(agent.voiceDesign);
        const voiceConfig = parseVoiceConfig(agent.voice);
        return {
          id: agent.id?.trim() || `gen-${nanoid(8)}`,
          name: agent.name,
          role: agent.role,
          persona: agent.persona,
          avatar: agent.avatar || AGENT_DEFAULT_AVATARS[index % AGENT_DEFAULT_AVATARS.length],
          color: agent.color || AGENT_COLOR_PALETTE[index % AGENT_COLOR_PALETTE.length],
          priority:
            agent.priority ?? (agent.role === 'teacher' ? 10 : agent.role === 'assistant' ? 7 : 5),
          ...(voiceConfig ? { voiceConfig } : {}),
          ...(voiceDesign ? { voiceDesign } : {}),
        };
      });

      if (signal?.aborted) throw new Error('aborted');
      await persistRoster(deps.store, doc, roster, signal);
      deps.onCheckpoint({
        tool: 'set_roster',
        stageId,
        detail: `roster set by name: ${roster.length} agents (1 teacher)`,
      });

      const teacher = roster.find((agent) => agent.role === 'teacher');
      // Report the binding in the roster summary: a summary that omits it makes
      // a silently-unbound voice indistinguishable from a bound one in the trace.
      const summary = roster
        .map(
          (agent) =>
            `${agent.name} [${agent.role}]${
              agent.voiceConfig?.providerId && agent.voiceConfig?.voiceId
                ? ` (${agent.voiceConfig.providerId}::${agent.voiceConfig.voiceId})`
                : ''
            }`,
        )
        .join(' | ');
      return {
        content: [
          {
            type: 'text',
            text: `Classroom roster set: ${roster.length} agents, teacher "${teacher?.name}". ${summary}.`,
          },
        ],
        details: { roster },
      };
    },
  };

  return markDocumentWritersSequential([listVoices, setRoster] as unknown as AgentTool<
    never,
    never
  >[]);
}

export const ROSTER_TOOL_NAMES = ['list_voices', 'set_roster'] as const;

/** Roster guidance layered into every runner prompt (the tools are always registered). */
export const ROSTER_TOOLS_PROMPT = [
  'The classroom roster is written with set_roster: pass every agent (exactly ONE teacher, at least 2 agents total) with name/role/persona and optional avatar/color/priority/voiceDesign. It persists stage.generatedAgentConfigs and drives scene/discussion generation; re-calling replaces the roster.',
  'To bind a roster voice, call list_voices first and use exactly one returned `providerId::voiceId` pair; never invent a voice id.',
  'A cloned voice registered this session with register_voice appears in list_voices and can be bound with the exact pair register_voice returned; a voice from an earlier session is not enumerable — re-register it, bind a catalog voice, or omit voice.',
  'Omit `voice` when no usable voice exists: narration falls back to the provider default.',
].join(' ');
