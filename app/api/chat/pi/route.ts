/**
 * Pi Director Chat API Endpoint
 *
 * POST /api/chat/pi - parallel PoC path for running the in-class multi-agent
 * chain as a single server-side pi agent loop.
 */

import { NextRequest } from 'next/server';
import { isProviderKeyRequired } from '@/lib/ai/providers';
import {
  isPiChatEnabled,
  isPiNativeChildRuntimeEnabled,
  isPiNativeChildSpotlightEnabled,
} from '@/lib/config/feature-flags';
import { createLogger } from '@/lib/logger';
import {
  getPiMaxActionsPerAgent,
  getPiMaxAgentTurns,
  resolveAgentConfigs,
} from '@/lib/chat/pi/config';
import { runPiDirectorLoop } from '@/lib/chat/pi/director-loop';
import type { SendEvent } from '@/lib/chat/pi/types';
import { resolveModel } from '@/lib/server/resolve-model';
import { apiError } from '@/lib/server/api-response';
import type { ThinkingConfig } from '@/lib/types/provider';
import type { StatelessChatRequest } from '@/lib/types/chat';
import { resolveClassroomWebSearchConfig } from '@/lib/server/web-search-config';
import { authenticatePersistenceHeaders } from '@/lib/persistence/server-auth';
import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';
import { createWhiteboardRuntimeService } from '@/lib/whiteboard/runtime/store';
import { hasNativeWhiteboardAction } from '@/lib/chat/pi/tools/native-whiteboard';
import {
  ELEMENT_REFERENCE_ACCEPTED_HEADER,
  ElementReferenceValidationError,
  resolveSlideElementReference,
} from '@/lib/chat/pi/element-reference';

const log = createLogger('Pi Chat API');

export const maxDuration = 300;

export async function POST(req: NextRequest) {
  if (!isPiChatEnabled()) {
    return apiError('INVALID_REQUEST', 404, 'Pi chat runtime is disabled');
  }

  const encoder = new TextEncoder();
  let chatModel: string | undefined;
  let chatMessageCount: number | undefined;

  try {
    const body: StatelessChatRequest = await req.json();
    chatModel = body.model;
    chatMessageCount = body.messages?.length;

    if (!body.messages || !Array.isArray(body.messages)) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'Missing required field: messages');
    }

    if (!body.storeState) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'Missing required field: storeState');
    }

    if (!body.config || body.config.agentIds == null) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'Missing required field: config.agentIds');
    }

    let elementReference;
    try {
      elementReference = resolveSlideElementReference(body);
    } catch (error) {
      if (error instanceof ElementReferenceValidationError) {
        return apiError('INVALID_REQUEST', 400, error.message);
      }
      throw error;
    }

    const agentIds = body.config.agentIds;
    if (
      !Array.isArray(agentIds) ||
      agentIds.length === 0 ||
      agentIds.some((id) => typeof id !== 'string' || id.trim().length === 0 || id !== id.trim()) ||
      new Set(agentIds).size !== agentIds.length
    ) {
      return apiError(
        'INVALID_REQUEST',
        400,
        'config.agentIds must be a non-empty array of unique, non-empty strings',
      );
    }

    const {
      model: languageModel,
      apiKey: resolvedApiKey,
      providerId,
      modelInfo,
      thinkingConfig: resolvedThinkingConfig,
    } = await resolveModel({
      modelString: body.model,
      stage: 'chat-adapter',
      apiKey: body.apiKey,
      baseUrl: body.baseUrl,
      providerType: body.providerType,
      // Let resolveModel arbitrate thinking too: a routed chat-adapter's thinking
      // wins, an unrouted one honors this client thinking (see resolve-model.ts).
      thinkingConfig: body.thinkingConfig ?? body.thinking,
    });

    if (isProviderKeyRequired(providerId) && !resolvedApiKey) {
      return apiError('MISSING_API_KEY', 401, 'API Key is required');
    }

    const agentConfigs = resolveAgentConfigs(body);
    const resolvedAgentIds = new Set(agentConfigs.map((agent) => agent.id));
    const unresolvedAgentIds = agentIds.filter((id) => !resolvedAgentIds.has(id));
    if (unresolvedAgentIds.length > 0) {
      return apiError(
        'INVALID_REQUEST',
        400,
        `Unknown classroom agents in config.agentIds: ${unresolvedAgentIds.join(', ')}`,
      );
    }
    if (agentConfigs.length === 0) {
      return apiError(
        'INVALID_REQUEST',
        400,
        `No valid classroom agents found for config.agentIds: ${body.config.agentIds.join(', ')}`,
      );
    }

    const signal = req.signal;
    const abortController = new AbortController();
    signal.addEventListener('abort', () => abortController.abort(), { once: true });

    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();

    const send: SendEvent = async (event) => {
      await writer.write(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
    };

    const thinkingConfig: ThinkingConfig = resolvedThinkingConfig ?? {
      mode: 'disabled',
      enabled: false,
    };

    const maxAgentTurns = getPiMaxAgentTurns(body);
    const maxActionsPerAgent = getPiMaxActionsPerAgent(body);
    const enableWhiteboardTools = body.config.piEnableWhiteboardTools === true;
    const childRuntimeMode = isPiNativeChildRuntimeEnabled() ? 'native' : 'legacy';
    const enableNativeChildSpotlight = isPiNativeChildSpotlightEnabled();
    const requestStartStageId = body.storeState.stage?.id;
    const validRequestStartStageId =
      typeof requestStartStageId === 'string' &&
      requestStartStageId.length > 0 &&
      requestStartStageId === requestStartStageId.trim()
        ? requestStartStageId
        : undefined;
    const nativeWhiteboardRequested = agentConfigs.some((agent) =>
      hasNativeWhiteboardAction(agent.allowedActions),
    );
    let nativeWhiteboardService: ReturnType<typeof createWhiteboardRuntimeService> | undefined;
    let nativeWhiteboardLearnerKey: string | undefined;
    if (
      childRuntimeMode === 'native' &&
      enableWhiteboardTools &&
      nativeWhiteboardRequested &&
      validRequestStartStageId &&
      process.env.NEXT_PUBLIC_PERSISTENCE === '1' &&
      process.env.DATABASE_URL &&
      process.env.PERSISTENCE_DEV_TOKEN
    ) {
      const principal = authenticatePersistenceHeaders(req.headers);
      const learnerKey = principal?.learnerKey;
      if (learnerKey && learnerKey === learnerKey.trim()) {
        try {
          const provider = await getServerPersistenceProvider(process.env.DATABASE_URL);
          nativeWhiteboardLearnerKey = learnerKey;
          nativeWhiteboardService = createWhiteboardRuntimeService({
            store: provider.runtimeStore,
            resolveLearnerKey: () => learnerKey,
          });
        } catch {
          log.warn('Native whiteboard capability unavailable: persistence initialization failed');
        }
      }
    }
    let nativeWebSearchConfig: ReturnType<typeof resolveClassroomWebSearchConfig>;
    try {
      nativeWebSearchConfig =
        childRuntimeMode === 'native'
          ? resolveClassroomWebSearchConfig({
              webSearchProviderId: body.webSearchProviderId,
              webSearchApiKey: body.webSearchApiKey,
              webSearchBaseUrl: body.webSearchBaseUrl,
              webSearchModelId: body.webSearchModelId,
              baiduSubSources: body.baiduSubSources,
            })
          : undefined;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Invalid Web Search configuration';
      return apiError('INVALID_REQUEST', 400, message);
    }

    log.info(
      `Pi request agents=${body.config.agentIds.join(', ')} messages=${body.messages.length} maxAgentTurns=${maxAgentTurns}`,
    );

    (async () => {
      let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
      const startHeartbeat = () => {
        heartbeatTimer = setInterval(() => {
          writer.write(encoder.encode(`:heartbeat\n\n`)).catch(() => stopHeartbeat());
        }, 15_000);
      };
      const stopHeartbeat = () => {
        if (heartbeatTimer) {
          clearInterval(heartbeatTimer);
          heartbeatTimer = null;
        }
      };

      try {
        startHeartbeat();

        await runPiDirectorLoop({
          body,
          elementReference,
          agentConfigs,
          send,
          languageModel,
          thinkingConfig,
          maxOutputTokens: modelInfo?.outputWindow,
          contextWindow: modelInfo?.contextWindow,
          abortSignal: abortController.signal,
          signal,
          maxAgentTurns,
          maxActionsPerAgent,
          enableWhiteboardTools,
          childRuntimeMode,
          enableNativeChildSpotlight,
          nativeWebSearchConfig,
          nativeWhiteboardService,
          nativeWhiteboardStageId: nativeWhiteboardService ? validRequestStartStageId : undefined,
          nativeWhiteboardLearnerKey,
          requestStartManualVisibilityRevision:
            Number.isSafeInteger(body.storeState.whiteboardManualVisibilityRevision) &&
            (body.storeState.whiteboardManualVisibilityRevision ?? -1) >= 0
              ? body.storeState.whiteboardManualVisibilityRevision
              : 0,
        });

        if (signal.aborted) {
          stopHeartbeat();
          await writer.close();
          return;
        }

        stopHeartbeat();
        await writer.close();
      } catch (error) {
        stopHeartbeat();

        if (signal.aborted) {
          try {
            await writer.close();
          } catch {
            /* already closed */
          }
          return;
        }

        log.error('Pi chat stream error:', error);
        try {
          await send({
            type: 'error',
            data: { message: error instanceof Error ? error.message : String(error) },
          });
          await writer.close();
        } catch {
          /* writer may already be closed */
        }
      }
    })();

    return new Response(readable, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        ...(elementReference ? { [ELEMENT_REFERENCE_ACCEPTED_HEADER]: '1' } : {}),
      },
    });
  } catch (error) {
    log.error(
      `Pi chat request failed [model=${chatModel ?? 'unknown'}, messages=${chatMessageCount ?? 0}]:`,
      error,
    );
    return apiError(
      'INTERNAL_ERROR',
      500,
      error instanceof Error ? error.message : 'Failed to process request',
    );
  }
}
