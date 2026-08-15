import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type, type Static } from 'typebox';
import { nanoid } from 'nanoid';
import type { AgentConfig } from '@/lib/orchestration/registry/types';
import type { SendEvent } from '../types';

const NativeSpotlightParams = Type.Object({
  elementId: Type.String({ minLength: 1 }),
  dimOpacity: Type.Optional(Type.Number()),
});

type NativeSpotlightParams = Static<typeof NativeSpotlightParams>;

export interface NativeSpotlightDetails {
  actionId: string;
  actionName: 'spotlight';
  params: NativeSpotlightParams;
  dispatchedAction: true;
}

function abortError(signal: AbortSignal): DOMException {
  return new DOMException(
    typeof signal.reason === 'string' ? signal.reason : 'Operation aborted',
    'AbortError',
  );
}

async function dispatchWithAbort(
  dispatch: () => Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  if (!signal) {
    await dispatch();
    return;
  }
  if (signal.aborted) throw abortError(signal);

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      callback();
    };
    const onAbort = () => settle(() => reject(abortError(signal)));
    signal.addEventListener('abort', onAbort, { once: true });

    let operation: Promise<void>;
    try {
      operation = Promise.resolve(dispatch());
    } catch (error) {
      settle(() => reject(error));
      return;
    }
    void operation.then(
      () => settle(resolve),
      (error) => settle(() => reject(error)),
    );
  });
}

export function buildNativeSpotlightTool(opts: {
  agent: AgentConfig;
  messageId: string;
  send: SendEvent;
  authorizedElementIds: ReadonlySet<string>;
}): AgentTool<typeof NativeSpotlightParams, NativeSpotlightDetails> {
  const assertAuthorizedTarget = (elementId: string) => {
    if (!opts.authorizedElementIds.has(elementId)) {
      throw new Error(
        `Spotlight target ${JSON.stringify(elementId)} is not authorized by request-start current-Scene evidence.`,
      );
    }
  };

  return {
    name: 'spotlight',
    label: 'Spotlight slide element',
    description:
      'Focus attention on one exact elementId from the attached request-start current-scene evidence.',
    parameters: NativeSpotlightParams,
    executionMode: 'sequential',
    prepareArguments: (args) => {
      if (
        args &&
        typeof args === 'object' &&
        !Array.isArray(args) &&
        typeof (args as { elementId?: unknown }).elementId === 'string' &&
        (args as { elementId: string }).elementId.length > 0
      ) {
        assertAuthorizedTarget((args as { elementId: string }).elementId);
      }
      return args as NativeSpotlightParams;
    },
    execute: async (_toolCallId, params, signal) => {
      // Recheck at the effect boundary; prompt text and preflight are not authority.
      assertAuthorizedTarget(params.elementId);
      const actionId = nanoid();
      await dispatchWithAbort(
        () =>
          opts.send({
            type: 'action',
            data: {
              actionId,
              actionName: 'spotlight',
              params: {
                elementId: params.elementId,
                ...(params.dimOpacity === undefined ? {} : { dimOpacity: params.dimOpacity }),
              },
              agentId: opts.agent.id,
              messageId: opts.messageId,
            },
          }),
        signal,
      );
      return {
        content: [{ type: 'text', text: 'Spotlight was accepted for best-effort dispatch.' }],
        details: {
          actionId,
          actionName: 'spotlight',
          params,
          dispatchedAction: true,
        },
      };
    },
  };
}
