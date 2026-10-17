/**
 * Agent profiles: generate the classroom's agents (one teacher, plus
 * assistants and students) for a course from its name and scene outlines,
 * binding each to an advertised voice. The teacher speaks with the user's
 * narrator voice whenever that voice is usable. The logic of 1.1.x's
 * POST /api/generate/agent-profiles.
 */
import { nanoid } from 'nanoid';
import { callLLM } from '@/lib/ai/llm';
import { AGENT_COLOR_PALETTE } from '@/lib/constants/agent-defaults';
import { normalizeVoiceDesign } from '@/lib/audio/voice-design';
import { isQwenCloneVoice, resolveTTSModelForVoice } from '@/lib/audio/constants';

import { StepRefusal, type StepContext, type StepLanguageModel } from './context';

export interface AgentProfilesInput {
  stageInfo: { name: string; description?: string };
  sceneOutlines?: { title: string; description?: string }[];
  languageDirective: string;
  availableAvatars: string[];
  avatarDescriptions?: Array<{ path: string; desc: string }>;
  availableVoices?: Array<{
    providerId: string;
    modelId?: string;
    voiceId: string;
    voiceName: string;
    voiceLanguage?: string;
    /** Catalog gender, when the provider lists one. */
    gender?: 'male' | 'female' | 'neutral';
  }>;
  /** The user's globally selected TTS voice; the teacher/narrator must use it. */
  narratorVoice?: {
    providerId: string;
    voiceId: string;
    modelId?: string;
  };
  /** The agent-profiles stage's model. */
  model: StepLanguageModel;
}

/** The model's answer could not be read, or did not make a valid classroom. */
type AgentProfilesRefusal = 'unparseable' | 'too-few-agents' | 'teacher-count';

type AdvertisedVoice = NonNullable<AgentProfilesInput['availableVoices']>[number];

/** A provider/voice binding (same shape as the agent's voiceConfig). */
export interface VoiceBinding {
  providerId: string;
  modelId?: string;
  voiceId: string;
}

export interface GeneratedAgentProfile {
  id: string;
  name: string;
  role: string;
  persona: string;
  avatar: string;
  color: string;
  priority: number;
  voiceConfig?: VoiceBinding;
  voiceDesign?: NonNullable<ReturnType<typeof normalizeVoiceDesign>>;
}

function advertisedVoiceToken(voice: VoiceBinding): string {
  return voice.modelId
    ? `${voice.providerId}::${voice.modelId}::${voice.voiceId}`
    : `${voice.providerId}::${voice.voiceId}`;
}

function findAdvertisedVoice(
  token: string,
  availableVoices: AdvertisedVoice[] | undefined,
): AdvertisedVoice | undefined {
  const exactMatch = availableVoices?.find((voice) => advertisedVoiceToken(voice) === token);
  if (exactMatch) return exactMatch;

  const parts = token.split('::');
  if (parts.length !== 2 && parts.length !== 3) return undefined;
  const providerId = parts[0];
  const voiceId = parts.at(-1);
  if (!providerId || !voiceId || (parts.length === 3 && !parts[1])) return undefined;

  // The voice is authoritative for its model. The optional model segment is
  // accepted for compatibility but never allowed to override the advertised binding.
  return availableVoices?.find(
    (voice) => voice.providerId === providerId && voice.voiceId === voiceId,
  );
}

/**
 * Resolve the narrator (teacher) voice from the user's explicit global choice.
 * It is honored only when the provider/voice is present in the advertised list
 * (which contains only enabled providers) or when it is a self-contained Qwen
 * clone. The binding always carries the advertised entry's model resolution so
 * provider/model/voice stay bound together (model follows voice).
 */
function resolveNarratorVoice(
  narratorVoice: NonNullable<AgentProfilesInput['narratorVoice']>,
  availableVoices: AdvertisedVoice[] | undefined,
): VoiceBinding | undefined {
  if (!narratorVoice.providerId || !narratorVoice.voiceId?.trim()) return undefined;

  const advertised = availableVoices?.find(
    (voice) =>
      voice.providerId === narratorVoice.providerId && voice.voiceId === narratorVoice.voiceId,
  );
  if (advertised) {
    return {
      providerId: advertised.providerId,
      ...(advertised.modelId ? { modelId: advertised.modelId } : {}),
      voiceId: advertised.voiceId,
    };
  }

  // Qwen clone IDs are account-scoped and self-contained: local profile storage
  // is not authoritative, so honor them even when not advertised and let the
  // model follow the voice.
  if (narratorVoice.providerId === 'qwen-tts' && isQwenCloneVoice(narratorVoice.voiceId)) {
    return {
      providerId: narratorVoice.providerId,
      modelId: resolveTTSModelForVoice(
        narratorVoice.providerId,
        narratorVoice.voiceId,
        narratorVoice.modelId,
      ),
      voiceId: narratorVoice.voiceId,
    };
  }

  return undefined;
}

type BinaryVoiceGender = 'male' | 'female';

/**
 * English "male" / "female" only. voiceDesign.identity follows the course
 * language, so a localized identity (neither word) is left unchanged.
 */
function identityGender(identity: string | undefined): BinaryVoiceGender | undefined {
  if (!identity) return undefined;
  const female = /\bfemale\b/i.test(identity);
  const male = /\bmale\b/i.test(identity);
  if (female === male) return undefined;
  return female ? 'female' : 'male';
}

/** Explicit voiceDesign.gender wins. A missing field keeps the English identity fallback. */
function profileGender(agent: {
  voiceDesign?: { identity?: string; gender?: unknown };
}): BinaryVoiceGender | undefined {
  const explicit = agent.voiceDesign?.gender;
  if (explicit === 'male' || explicit === 'female') return explicit;
  return identityGender(agent.voiceDesign?.identity);
}

function pickMatchingGenderVoice(
  voices: AdvertisedVoice[],
  wanted: BinaryVoiceGender,
  preferredLanguage: string | undefined,
  usage: Map<string, number>,
  reserved: string | undefined,
  occupied: Set<string>,
  stuck: Set<string>,
): AdvertisedVoice | undefined {
  const matches = voices.filter((voice) => {
    if (voice.gender !== wanted) return false;
    const key = advertisedVoiceToken(voice);
    if (reserved !== undefined && key === reserved) return false;
    return (usage.get(key) ?? 0) <= 0;
  });
  // Same language and nobody holds it, then same language held only by an
  // agent who can still move, then another language nobody holds, then
  // another language held only by an agent who can still move, then a voice
  // whose holder is stuck. Stuck means a holder will not leave: failed move,
  // narrator, already matching, or no possible destination yet.
  const rank = (voice: AdvertisedVoice): number => {
    const key = advertisedVoiceToken(voice);
    const sameLanguage = !preferredLanguage || voice.voiceLanguage === preferredLanguage;
    const held = occupied.has(key);
    if (sameLanguage && !held) return 0;
    if (sameLanguage && held && !stuck.has(key)) return 1;
    if (!held) return 2;
    if (held && !stuck.has(key)) return 3;
    return 4;
  };
  let best: AdvertisedVoice | undefined;
  let bestRank = 5;
  for (const voice of matches) {
    const voiceRank = rank(voice);
    if (voiceRank < bestRank) {
      best = voice;
      bestRank = voiceRank;
    }
  }
  return best;
}

/** True when this agent is on a male/female voice of the other gender. */
function hasOppositeVoiceGender(
  agent: GeneratedAgentProfile,
  availableVoices: AdvertisedVoice[],
): boolean {
  if (!agent.voiceConfig) return false;
  const wanted = profileGender(agent);
  if (!wanted) return false;
  const current = findAdvertisedVoice(advertisedVoiceToken(agent.voiceConfig), availableVoices);
  if (!current || (current.gender !== 'male' && current.gender !== 'female')) return false;
  return current.gender !== wanted;
}

/**
 * Voices currently held, and those a holder will not leave. A mismatched
 * holder with no destination is stuck before they try, so their voice is not
 * taken ahead of a free one. When several movable holders would claim the same
 * sole destination, earlier holders reserve it in this pass so later ones are
 * stuck if they have no alternative. Repeat until a holder whose only hope was
 * that voice is stuck too.
 */
function voiceHolds(
  agents: GeneratedAgentProfile[],
  availableVoices: AdvertisedVoice[],
  usage: Map<string, number>,
  reserved: string | undefined,
  canMove: (agent: GeneratedAgentProfile) => boolean,
  gaveUp: ReadonlySet<GeneratedAgentProfile>,
): { occupied: Set<string>; stuck: Set<string> } {
  const occupied = new Set<string>();
  const stuck = new Set<string>();
  const immovable = new Set<GeneratedAgentProfile>();
  for (const holder of agents) {
    if (!holder.voiceConfig) continue;
    const key = advertisedVoiceToken(holder.voiceConfig);
    occupied.add(key);
    if (!canMove(holder) || gaveUp.has(holder)) {
      stuck.add(key);
      immovable.add(holder);
    }
  }

  let changed = true;
  while (changed) {
    changed = false;
    // Movable holders that share one sole destination must not all look free to
    // leave: earlier holders claim that destination for this pass so later ones
    // are stuck when they have no alternative.
    const claimedDestinations = new Map<string, number>();
    for (const holder of agents) {
      if (immovable.has(holder) || !holder.voiceConfig) continue;
      const wanted = profileGender(holder);
      const current = findAdvertisedVoice(
        advertisedVoiceToken(holder.voiceConfig),
        availableVoices,
      );
      const usageWithClaims = new Map(usage);
      for (const [key, count] of claimedDestinations) {
        usageWithClaims.set(key, (usageWithClaims.get(key) ?? 0) + count);
      }
      const destination =
        wanted && current
          ? pickMatchingGenderVoice(
              availableVoices,
              wanted,
              current.voiceLanguage,
              usageWithClaims,
              reserved,
              occupied,
              stuck,
            )
          : undefined;
      if (!destination) {
        immovable.add(holder);
        stuck.add(advertisedVoiceToken(holder.voiceConfig));
        changed = true;
      } else {
        const destKey = advertisedVoiceToken(destination);
        claimedDestinations.set(destKey, (claimedDestinations.get(destKey) ?? 0) + 1);
      }
    }
  }
  return { occupied, stuck };
}

/**
 * Move agents off an opposite male or female voice when the catalogue has a
 * free voice of their identity gender. Already-matching voices, unknown and
 * neutral genders, and the fixed narrator binding stay put and are not stolen.
 * A failed move keeps the current voice and does not mark it used. Prefer a
 * same-language voice nobody holds, then a same-language voice held only by
 * an agent who can still move, then an other-language voice nobody holds,
 * then an other-language voice held only by an agent who can still move,
 * then a voice whose holder is stuck. A voice is stuck when its holder will not leave.
 */
function reconcileOppositeVoiceGenders(
  agents: GeneratedAgentProfile[],
  availableVoices: AdvertisedVoice[] | undefined,
  narratorBinding: VoiceBinding | undefined,
): void {
  if (!availableVoices?.length) return;
  const reserved = narratorBinding ? advertisedVoiceToken(narratorBinding) : undefined;
  const canMove = (agent: GeneratedAgentProfile) => {
    if (narratorBinding && agent.role === 'teacher') return false;
    return hasOppositeVoiceGender(agent, availableVoices);
  };

  // Agents we will not move keep their voices. Mismatched agents release
  // theirs up front; a later swap must not be what frees the voice an
  // earlier agent needed.
  const usage = new Map<string, number>();
  for (const agent of agents) {
    if (!agent.voiceConfig || canMove(agent)) continue;
    const key = advertisedVoiceToken(agent.voiceConfig);
    usage.set(key, (usage.get(key) ?? 0) + 1);
  }

  // A miss does not put the old voice back into `usage`. That holder will
  // not leave, so later picks in this pass treat the voice as stuck. Repeat
  // until a pass moves nobody.
  let progressed = true;
  while (progressed) {
    progressed = false;
    const gaveUp = new Set<GeneratedAgentProfile>();
    for (const agent of agents) {
      if (!canMove(agent) || !agent.voiceConfig) continue;
      const wanted = profileGender(agent);
      const current = findAdvertisedVoice(advertisedVoiceToken(agent.voiceConfig), availableVoices);
      if (!wanted || !current) continue;

      const { occupied, stuck } = voiceHolds(
        agents,
        availableVoices,
        usage,
        reserved,
        canMove,
        gaveUp,
      );
      const replacement = pickMatchingGenderVoice(
        availableVoices,
        wanted,
        current.voiceLanguage,
        usage,
        reserved,
        occupied,
        stuck,
      );
      if (!replacement) {
        gaveUp.add(agent);
        continue;
      }
      agent.voiceConfig = {
        providerId: replacement.providerId,
        ...(replacement.modelId ? { modelId: replacement.modelId } : {}),
        voiceId: replacement.voiceId,
      };
      const replacementKey = advertisedVoiceToken(replacement);
      usage.set(replacementKey, (usage.get(replacementKey) ?? 0) + 1);
      progressed = true;
    }
  }
}

function stripCodeFences(text: string): string {
  let cleaned = text.trim();
  // Remove markdown code fences (```json ... ``` or ``` ... ```)
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  }
  return cleaned.trim();
}

export async function generateAgentProfiles(
  input: AgentProfilesInput,
  ctx: StepContext,
): Promise<GeneratedAgentProfile[]> {
  const {
    stageInfo,
    sceneOutlines,
    languageDirective,
    availableAvatars,
    avatarDescriptions,
    availableVoices,
    narratorVoice,
  } = input;
  const { model: languageModel, modelString, thinkingConfig, serverManaged } = input.model;
  const { log } = ctx;

  // ── Build prompt ──
  const sceneSummary = sceneOutlines?.length
    ? sceneOutlines
        .map((s, i) => `${i + 1}. ${s.title}${s.description ? ` — ${s.description}` : ''}`)
        .join('\n')
    : null;

  // The teacher must speak with the user's explicitly selected global voice
  // whenever it is usable; otherwise keep the old behavior (LLM-assigned).
  const narratorBinding = narratorVoice
    ? resolveNarratorVoice(narratorVoice, availableVoices)
    : undefined;

  const systemPrompt = `You are an expert instructional designer. Generate agent profiles for a multi-agent classroom simulation. Decide the appropriate number of agents (typically 3-5) based on the course content and complexity. Return ONLY valid JSON, no markdown or explanation.`;

  // Build voice list for prompt (if available)
  const binaryGenderListed = availableVoices?.some(
    (voice) => voice.gender === 'male' || voice.gender === 'female',
  );
  // Neutral-only catalogues (google-tts, VoxCPM voxcpm:auto) have nothing to
  // match. Asking the model to align identity, name, and persona would collapse
  // them onto "neutral".
  const genderMatchRules = binaryGenderListed
    ? `  - The voice's gender must match the agent's voiceDesign.gender
  - The voice's gender must match the agent's voiceDesign.identity
  - Keep the agent's name and persona consistent with that gender
  - Only a voice labeled male or female takes part in that match. A neutral voice, or a voice with no gender, is not mismatched and must not change the agent's name, persona, or identity
`
    : '';

  const voiceListStr =
    availableVoices && availableVoices.length > 0
      ? JSON.stringify(
          availableVoices.map((v) => ({
            id: advertisedVoiceToken(v),
            name: v.voiceName,
            language: v.voiceLanguage || 'unknown',
            ...(v.gender ? { gender: v.gender } : {}),
          })),
        )
      : '';

  const voicePrompt = voiceListStr
    ? narratorBinding
      ? `- The teacher agent's voice is FIXED to the narrator voice "${advertisedVoiceToken(narratorBinding)}" — set by the system, so omit the "voice" field for the teacher
  - Every OTHER agent must still be assigned a voice from this list: ${voiceListStr}
  - Prefer a voice whose language matches the course language directive
  - Pick a voice that suits each agent's personality and role (e.g. lively voice for energetic student)
${genderMatchRules}  - Try to use different voices for each non-teacher agent
  - Never assign the fixed teacher narrator voice to any other agent`
      : `- Each agent should be assigned a voice that matches their persona from this list: ${voiceListStr}
  - Prefer a voice whose language matches the course language directive
  - Pick a voice that suits the agent's personality and role (e.g. authoritative voice for teacher, lively voice for energetic student)
${genderMatchRules}  - Try to use different voices for each agent`
    : '';

  // The schema example must always be an ADVERTISED token (findAdvertisedVoice
  // only resolves advertised voices), never the narrator token — a ghost clone
  // not in the advertised list would poison the example for non-teacher agents.
  const voiceJsonField = voiceListStr
    ? narratorBinding
      ? `,\n      "voice": "string (voice id from available list, e.g. '${advertisedVoiceToken(availableVoices![0])}'; omit for the teacher — its voice is fixed)"`
      : `,\n      "voice": "string (voice id from available list, e.g. '${advertisedVoiceToken(availableVoices![0])}')"`
    : '';

  const userPrompt = `Generate agent profiles for the following course:

Course name: ${stageInfo.name}
${stageInfo.description ? `Course description: ${stageInfo.description}` : ''}
${sceneSummary ? `\nScene outlines:\n${sceneSummary}\n` : ''}
Requirements:
- Decide the appropriate number of agents based on the course content (typically 3-5)
- Exactly 1 agent must have role "teacher", the rest can be "assistant" or "student"
- Priority values: teacher=10 (highest), assistant=7, student=4-6
- Each agent needs: name, role, persona (2-3 sentences describing personality and teaching/learning style)
- Language directive for this course: ${languageDirective}
  Agent names and personas must follow this language directive.
- Each agent must be assigned one avatar from this list: ${JSON.stringify(avatarDescriptions && avatarDescriptions.length > 0 ? avatarDescriptions.map((a) => ({ path: a.path, description: a.desc })) : availableAvatars)}
  - Pick an avatar that visually matches the agent's personality and role
  - Try to use different avatars for each agent
  - Use the "path" value as the avatar field in the output
- Each agent must be assigned one color from this list: ${JSON.stringify(AGENT_COLOR_PALETTE)}
  - Each agent must have a different color
- Each agent needs a "voiceDesign" object describing their VOCAL identity (not personality), consistent with the persona:
  - "identity": gender + age + role as one short comma-free phrase in the course language (e.g. "middle-aged male teacher" when the course language is English)
  - "gender": "male" or "female" only. These two English words, never a translation, naming the same gender as identity. voiceDesign.gender is language-independent
  - "texture": pitch + vocal quality as one short comma-free phrase (e.g. "warm low-pitched slightly husky")
  - "delivery": emotion + pace as one short comma-free phrase (e.g. "calm measured encouraging")
${voicePrompt}

Return a JSON object with this exact structure:
{
  "agents": [
    {
      "name": "string",
      "role": "teacher" | "assistant" | "student",
      "persona": "string (2-3 sentences)",
      "voiceDesign": { "identity": "string", "gender": "male" | "female", "texture": "string", "delivery": "string" },
      "avatar": "string (from available list)",
      "color": "string (hex color from palette)",
      "priority": number (10 for teacher, 7 for assistant, 4-6 for student)${voiceJsonField}
    }
  ]
}`;

  log.info(`Generating agent profiles for "${stageInfo.name}" [model=${modelString}]`);

  const rawResult = (
    await callLLM(
      {
        model: languageModel,
        abortSignal: ctx.signal,
        system: systemPrompt,
        prompt: userPrompt,
      },
      'agent-profiles',
      undefined,
      thinkingConfig,
      { serverManaged },
    )
  ).text;

  // ── Parse LLM response ──
  const rawText = stripCodeFences(rawResult);
  let parsed: {
    agents: Array<{
      name: string;
      role: string;
      persona: string;
      avatar: string;
      color: string;
      priority: number;
      voice?: unknown;
      voiceDesign?: unknown;
    }>;
  };

  try {
    parsed = JSON.parse(rawText);
  } catch {
    log.error('Failed to parse LLM response as JSON:', rawText.substring(0, 500));
    throw new StepRefusal<AgentProfilesRefusal>(
      'unparseable',
      'Failed to parse agent profiles from LLM response',
    );
  }

  // ── Validate parsed structure ──
  if (!parsed.agents || !Array.isArray(parsed.agents) || parsed.agents.length < 2) {
    log.error(`Expected at least 2 agents, got ${parsed.agents?.length ?? 0}`);
    throw new StepRefusal<AgentProfilesRefusal>(
      'too-few-agents',
      `Expected at least 2 agents but LLM returned ${parsed.agents?.length ?? 0}`,
    );
  }

  const teacherCount = parsed.agents.filter((a) => a.role === 'teacher').length;
  if (teacherCount !== 1) {
    log.error(`Expected exactly 1 teacher, got ${teacherCount}`);
    throw new StepRefusal<AgentProfilesRefusal>(
      'teacher-count',
      `Expected exactly 1 teacher but LLM returned ${teacherCount}`,
    );
  }

  // ── Build output with IDs ──
  const agents = parsed.agents.map((agent, index): GeneratedAgentProfile => {
    // The teacher speaks with the user's explicitly selected narrator voice —
    // the LLM must never reassign it. Everyone else resolves only an
    // advertised voice token so provider/model/voice remain bound together.
    let voiceConfig: VoiceBinding | undefined;
    if (agent.role === 'teacher' && narratorBinding) {
      voiceConfig = narratorBinding;
    } else if (agent.voice !== undefined && agent.voice !== null) {
      const advertised =
        typeof agent.voice === 'string'
          ? findAdvertisedVoice(agent.voice, availableVoices)
          : undefined;
      if (advertised) {
        voiceConfig = {
          providerId: advertised.providerId,
          ...(advertised.modelId ? { modelId: advertised.modelId } : {}),
          voiceId: advertised.voiceId,
        };
      } else {
        console.warn(
          '[AgentProfiles] Dropped voice token not present in the advertised list:',
          agent.voice,
        );
      }
    }

    const voiceDesign = normalizeVoiceDesign(agent.voiceDesign);

    return {
      id: `gen-${nanoid(8)}`,
      name: agent.name,
      role: agent.role,
      persona: agent.persona,
      avatar: agent.avatar || availableAvatars[index % availableAvatars.length],
      color: agent.color || AGENT_COLOR_PALETTE[index % AGENT_COLOR_PALETTE.length],
      priority:
        agent.priority ?? (agent.role === 'teacher' ? 10 : agent.role === 'assistant' ? 7 : 5),
      ...(voiceConfig ? { voiceConfig } : {}),
      ...(voiceDesign ? { voiceDesign } : {}),
    };
  });

  reconcileOppositeVoiceGenders(agents, availableVoices, narratorBinding);

  log.info(`Successfully generated ${agents.length} agent profiles for "${stageInfo.name}"`);
  return agents;
}
