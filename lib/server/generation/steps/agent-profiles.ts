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
  const voiceListStr =
    availableVoices && availableVoices.length > 0
      ? JSON.stringify(
          availableVoices.map((v) => ({
            id: advertisedVoiceToken(v),
            name: v.voiceName,
            language: v.voiceLanguage || 'unknown',
          })),
        )
      : '';

  const voicePrompt = voiceListStr
    ? narratorBinding
      ? `- The teacher agent's voice is FIXED to the narrator voice "${advertisedVoiceToken(narratorBinding)}" — set by the system, so omit the "voice" field for the teacher
  - Every OTHER agent must still be assigned a voice from this list: ${voiceListStr}
  - Prefer a voice whose language matches the course language directive
  - Pick a voice that suits each agent's personality and role (e.g. lively voice for energetic student)
  - Try to use different voices for each non-teacher agent
  - Never assign the fixed teacher narrator voice to any other agent`
      : `- Each agent should be assigned a voice that matches their persona from this list: ${voiceListStr}
  - Prefer a voice whose language matches the course language directive
  - Pick a voice that suits the agent's personality and role (e.g. authoritative voice for teacher, lively voice for energetic student)
  - Try to use different voices for each agent`
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
- Each agent needs a "voiceDesign" object describing their VOCAL identity (not personality), written following the language directive and consistent with the persona, as three short comma-free phrases:
  - "identity": gender + age + role (e.g. "middle-aged male teacher")
  - "texture": pitch + vocal quality (e.g. "warm low-pitched slightly husky")
  - "delivery": emotion + pace (e.g. "calm measured encouraging")
${voicePrompt}

Return a JSON object with this exact structure:
{
  "agents": [
    {
      "name": "string",
      "role": "teacher" | "assistant" | "student",
      "persona": "string (2-3 sentences)",
      "voiceDesign": { "identity": "string", "texture": "string", "delivery": "string" },
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

  log.info(`Successfully generated ${agents.length} agent profiles for "${stageInfo.name}"`);
  return agents;
}
