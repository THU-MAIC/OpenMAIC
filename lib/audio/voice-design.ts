/**
 * Provider-neutral per-agent voice design.
 *
 * A `VoiceDesign` describes an agent's vocal identity (not personality) as a
 * 3-layer recipe. It is consumed by any TTS provider: as an inline voice
 * prompt where supported, or as the seed for a registered/cloned voice
 * (see `voice-registration.ts`). Nothing here is VoxCPM-specific.
 */

export interface VoiceDesign {
  identity: string; // gender / age / role
  texture: string; // pitch / vocal quality
  delivery: string; // emotion / pace
}

const VOICE_DESIGN_PROMPT_MAX_CHARS = 200;

/** Prefix for deterministic auto-voice ids (provider-neutral, backend-name-safe). */
export const AUTO_VOICE_ID_PREFIX = 'auto-' as const;

function sanitizeVoiceDesignPart(value?: string): string {
  return (
    (value || '')
      .replace(/[\p{C}]+/gu, ' ')
      // Strip parentheses: VoxCPM uses `(prompt)text` delimiters, so a paren in the
      // descriptor/persona would corrupt the bootstrap synthesis prompt.
      .replace(/[()（）]/gu, ' ')
      .replace(/\s+/gu, ' ')
      .trim()
      .slice(0, VOICE_DESIGN_PROMPT_MAX_CHARS)
      .trim()
  );
}

/** Compose the 3 layers into one comma-joined prompt, dropping blank layers. */
export function buildVoiceDesignPrompt(design: VoiceDesign): string {
  return [design.identity, design.texture, design.delivery]
    .map((part) => sanitizeVoiceDesignPart(part))
    .filter(Boolean)
    .join(', ');
}

/** Coerce an arbitrary (LLM-produced) value into a VoiceDesign, or undefined. */
export function normalizeVoiceDesign(raw: unknown): VoiceDesign | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const record = raw as Record<string, unknown>;
  const pick = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
  const design = {
    identity: pick(record.identity),
    texture: pick(record.texture),
    delivery: pick(record.delivery),
  };
  if (!design.identity && !design.texture && !design.delivery) return undefined;
  return design;
}

/**
 * Deterministic voice id derived from the descriptor (+ provider + model).
 * Stable across re-synthesis, recomputable anywhere from the descriptor on the
 * agent, and namespaced by provider so a shared registry can't collide.
 *
 * Note: language is intentionally NOT part of the id — the descriptor text is
 * already written in the course language, and language only selects the one-time
 * bootstrap sample sentence (which affects neither output language nor timbre).
 * Keeping it out means every TTS path (narration passes a directive, discussion
 * passes a locale) resolves to the SAME id for the same agent.
 */
export async function getDeterministicVoiceId(
  design: VoiceDesign,
  opts: { providerId?: string; model?: string } = {},
): Promise<string> {
  const seed = [
    opts.providerId || '',
    design.identity,
    design.texture,
    design.delivery,
    opts.model || '',
  ].join('|');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(seed));
  const hex = Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  return `${AUTO_VOICE_ID_PREFIX}${hex.slice(0, 16)}`;
}
