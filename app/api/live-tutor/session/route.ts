/**
 * Live Camera Tutor Session API
 *
 * POST: Negotiates the best available real-time multimodal tutor transport for
 * the caller's configured classroom model:
 *  - When the classroom slot resolves to Google Gemini on the official endpoint,
 *    mints a single-use short-lived v1alpha `auth_tokens` ephemeral token so the
 *    browser connects directly to `BidiGenerateContentConstrained` without ever
 *    exposing the server's API key.
 *  - For all other providers (OpenAI, Anthropic, Qwen, DeepSeek, Ollama, or
 *    custom relays), returns `{ mode: 'turn-based' }` so the client uses
 *    `/api/live-tutor/turn` with provider-neutral vision + TTS.
 */
import { NextRequest } from 'next/server';
import { createLogger } from '@/lib/logger';
import { apiError, apiSuccess, modelAuthorizationResponse } from '@/lib/server/api-response';
import { resolveModelFromRequest } from '@/lib/server/resolve-model';
import type { LiveTutorSessionResponse } from '@/lib/live-tutor/types';

const log = createLogger('LiveTutorSession');

const DEFAULT_GEMINI_LIVE_MODEL = 'models/gemini-3.8-live';
const GOOGLE_DEFAULT_ORIGIN = 'https://generativelanguage.googleapis.com';

function normalizeLiveModelName(raw: string | undefined): string {
  const trimmed = raw?.trim();
  if (!trimmed) return DEFAULT_GEMINI_LIVE_MODEL;
  return trimmed.startsWith('models/') ? trimmed : `models/${trimmed}`;
}

function isOfficialGoogleOrigin(baseUrl: string | undefined): boolean {
  if (!baseUrl) return true;
  try {
    const parsed = new URL(baseUrl);
    return parsed.hostname === 'generativelanguage.googleapis.com';
  } catch {
    return false;
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const resolved = await resolveModelFromRequest(req, body, 'chat-adapter');

    if (
      resolved.providerId === 'google' &&
      resolved.apiKey &&
      isOfficialGoogleOrigin(resolved.baseUrl)
    ) {
      const now = Date.now();
      const expireTime = new Date(now + 30 * 60 * 1000).toISOString();
      const newSessionExpireTime = new Date(now + 2 * 60 * 1000).toISOString();
      const liveModel = normalizeLiveModelName(process.env.GEMINI_LIVE_MODEL);

      try {
        const tokenResp = await fetch(
          `${GOOGLE_DEFAULT_ORIGIN}/v1alpha/auth_tokens?key=${encodeURIComponent(resolved.apiKey)}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              uses: 1,
              expireTime,
              newSessionExpireTime,
            }),
          },
        );

        if (tokenResp.ok) {
          const tokenData = (await tokenResp.json()) as { name?: string };
          if (tokenData.name) {
            const wsUrl = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained?access_token=${encodeURIComponent(tokenData.name)}`;
            const payload: LiveTutorSessionResponse = {
              mode: 'gemini-live',
              wsUrl,
              model: liveModel,
              expiresAt: expireTime,
            };
            return apiSuccess(payload);
          }
        } else {
          log.warn(
            `Gemini ephemeral token request returned HTTP ${tokenResp.status}; falling back to turn-based mode.`,
          );
        }
      } catch (tokenErr) {
        log.warn('Failed to mint Gemini Live ephemeral token; using turn-based mode:', tokenErr);
      }
    }

    const fallbackPayload: LiveTutorSessionResponse = {
      mode: 'turn-based',
      providerId: resolved.providerId,
      modelId: resolved.modelId,
    };
    return apiSuccess(fallbackPayload);
  } catch (error) {
    const authorization = modelAuthorizationResponse(error);
    if (authorization) return authorization;
    log.error('Failed to initialize live tutor session:', error);
    return apiError('INTERNAL_ERROR', 500, 'Failed to initialize live tutor session');
  }
}
