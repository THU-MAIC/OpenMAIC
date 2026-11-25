import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { PPTElement } from '@openmaic/dsl';
import {
  buildNativeWhiteboardTools,
  NATIVE_WHITEBOARD_ACTION_NAMES,
} from '@/lib/chat/pi/tools/native-whiteboard';
import { CHILD_STATE_PREFIX, summarizeChildElement } from '@/lib/chat/pi/child-tail-state';
import type { WhiteboardRuntimeService } from '@/lib/whiteboard/runtime/store';
import type { SendEvent } from '@/lib/chat/pi/types';

class PBLWhiteboardToolError extends Error {
  constructor(code: string) {
    super(JSON.stringify({ ok: false, error: code, lastSeq: null }));
  }
}

// Shared by all tool sets/turns for a board. Reserve the slot synchronously,
// before any read or argument preparation can yield to Pi's parallel executor.
const queues = new Map<string, Promise<void>>();
function serial<T>(key: string, work: () => Promise<T>): Promise<T> {
  const pending = (queues.get(key) ?? Promise.resolve()).then(work);
  const settled = pending.then(
    () => {},
    () => {},
  );
  queues.set(key, settled);
  void settled.then(() => {
    if (queues.get(key) === settled) queues.delete(key);
  });
  return pending;
}

/** Includes edit-code's union branches. Native validation follows host injection. */
function withoutExpectedLastSeq<T>(schema: T): T {
  const copy = structuredClone(schema);
  function visit(value: unknown) {
    if (!value || typeof value !== 'object') return;
    const node = value as Record<string, unknown>;
    if (node.properties && typeof node.properties === 'object')
      delete (node.properties as Record<string, unknown>).expectedLastSeq;
    if (Array.isArray(node.required))
      node.required = node.required.filter((key) => key !== 'expectedLastSeq');
    for (const child of Object.values(node)) {
      if (Array.isArray(child)) child.forEach(visit);
      else visit(child);
    }
  }
  visit(copy);
  return copy;
}

function whiteboardElementBounds(e: PPTElement) {
  let x = e.left,
    y = e.top;
  const width = e.type === 'line' ? Math.abs(e.end[0] - e.start[0]) : e.width;
  const height = e.type === 'line' ? Math.abs(e.end[1] - e.start[1]) : e.height;
  if (e.type === 'line') {
    x += Math.min(e.start[0], e.end[0]);
    y += Math.min(e.start[1], e.end[1]);
  }
  const rad = ((('rotate' in e ? e.rotate : 0) ?? 0) * Math.PI) / 180;
  const w = Math.abs(width * Math.cos(rad)) + Math.abs(height * Math.sin(rad));
  const h = Math.abs(width * Math.sin(rad)) + Math.abs(height * Math.cos(rad));
  return { x: x + (width - w) / 2, y: y + (height - h) / 2, width: w, height: h };
}

type Box = { x: number; y: number; width: number; height: number };

/**
 * The space an element really takes. Text flows from its top edge inside 10 of padding at 1.5
 * line height and is never clipped, so its drawn height comes from its content, not from the
 * height it was given.
 */
export function whiteboardElementExtent(e: PPTElement): Box {
  const box = whiteboardElementBounds(e);
  if (e.type !== 'text') return box;
  const fontSize = Number(/font-size:\s*([\d.]+)px/.exec(e.content)?.[1] ?? 18);
  const room = Math.max(e.width - 20, fontSize);
  const lines = e.content
    .replace(/<br\s*\/?>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .split('\n')
    .reduce((count, line) => {
      // A full-width character is about one font size wide; others about half.
      const width = Array.from(line).reduce(
        (sum, char) => sum + (/[\u2e80-\uffef]/u.test(char) ? fontSize : fontSize * 0.55),
        0,
      );
      return count + Math.max(1, Math.ceil(width / room));
    }, 0);
  return { ...box, height: Math.max(box.height, 20 + lines * fontSize * 1.5) };
}

/**
 * What the role cannot see without looking: a change that left the canvas or landed on
 * another block. It is told in the result, so it can move or shorten what it just drew.
 */
export function whiteboardLayoutWarnings(
  element: PPTElement,
  others: readonly PPTElement[],
  canvas: { width: number; height: number },
) {
  const box = whiteboardElementExtent(element);
  const warnings: string[] = [];
  const right = Math.round(box.x + box.width - canvas.width),
    bottom = Math.round(box.y + box.height - canvas.height);
  if (box.x < 0 || box.y < 0) warnings.push('It starts outside the canvas.');
  if (right > 0) warnings.push(`It runs ${right} past the right edge of the canvas.`);
  if (bottom > 0)
    warnings.push(
      `It runs ${bottom} below the bottom of the canvas (height ${Math.round(canvas.height)}), where the learner cannot see it.`,
    );
  if (element.type === 'text' && box.height > element.height + 8)
    warnings.push(
      `Its text needs about ${Math.round(box.height)} of height, not the ${Math.round(element.height)} given; what you place below it must start lower.`,
    );
  // Labels sit on shapes and lines touch what they join by design; blocks of content do not.
  const content = (e: PPTElement) => e.type !== 'shape' && e.type !== 'line';
  if (content(element))
    for (const other of others) {
      if (other.id === element.id || !content(other)) continue;
      const against = whiteboardElementExtent(other);
      const x = Math.min(box.x + box.width, against.x + against.width) - Math.max(box.x, against.x);
      const y =
        Math.min(box.y + box.height, against.y + against.height) - Math.max(box.y, against.y);
      if (x > 12 && y > 12) {
        warnings.push(
          `It overlaps element ${other.id} by ${Math.round(x)} x ${Math.round(y)}; that element occupies x ${Math.round(against.x)}-${Math.round(against.x + against.width)}, y ${Math.round(against.y)}-${Math.round(against.y + against.height)}.`,
        );
        break;
      }
    }
  return warnings.length
    ? [...warnings, 'Delete or move this element before going on; do not leave it as it is.']
    : [];
}

export function createPBLWhiteboardTools(opts: {
  service: WhiteboardRuntimeService;
  stageId: string;
  learnerKey: string;
  sessionId: string;
  messageId: string;
  send?: SendEvent;
  onWrite?: () => Promise<void>;
  withExecution?: <T>(work: () => Promise<T>, signal?: AbortSignal) => Promise<T>;
  onExecution?: (event: {
    name: string;
    callId: string;
    suppliedLastSeq: number | null;
    committedLastSeq: number | null;
  }) => void;
}): AgentTool[] {
  const nativeTools = buildNativeWhiteboardTools({
    ...opts,
    send: opts.send ?? (async () => {}),
    requestStartManualVisibilityRevision: 0,
    agent: {
      id: 'pbl-tutor',
      name: 'PBL tutor',
      role: 'teacher',
      persona: '',
      avatar: '',
      color: '#3366ff',
      priority: 10,
      createdAt: new Date(0),
      updatedAt: new Date(0),
      isDefault: true,
      allowedActions: [...NATIVE_WHITEBOARD_ACTION_NAMES],
    },
  });
  const key = JSON.stringify([opts.stageId, opts.learnerKey, opts.sessionId]);
  return nativeTools
    .filter((tool) => !['wb_open', 'wb_close'].includes(tool.name))
    .map((native) => ({
      ...native,
      executionMode: 'sequential',
      parameters: withoutExpectedLastSeq(native.parameters),
      description:
        native.description
          .replace(
            / using nextMutation\.expectedLastSeq from the latest successful wb_read or mutation result/g,
            '',
          )
          .replace(/ Copy nextMutation\.expectedLastSeq[^.]*\./g, '')
          .replace(/ For a user-visible drawing request,[\s\S]*$/, '') +
        ' PBL board is always visible. The complete current board is supplied at the request tail; no preliminary wb_read is needed. Submit independent board calls together; the host executes them in listed order and supplies the current version.',
      prepareArguments: (args: unknown) => args,
      execute: (callId, raw, signal) =>
        serial(key, () =>
          (opts.withExecution ?? ((work) => work()))(async () => {
            signal?.throwIfAborted();
            const before = await opts.service.read(opts.stageId);
            // wb_read has no browser visibility to query in the PBL workbench.
            if (native.name === 'wb_read') {
              const compact = {
                ok: true,
                lastSeq: before.lastSeq,
                elements: (before.whiteboard?.elements ?? []).map(summarizeChildElement),
              };
              return {
                content: [{ type: 'text' as const, text: JSON.stringify(compact) }],
                details: compact,
              };
            }
            try {
              const injected = { ...(raw as object), expectedLastSeq: before.lastSeq };
              const prepared = native.prepareArguments
                ? await native.prepareArguments(injected)
                : injected;
              const result = (await native.execute(callId, prepared, signal)) as Awaited<
                ReturnType<typeof native.execute>
              > & { isError?: boolean };
              const details = result.details as {
                code?: string;
                lastSeq?: number | null;
                affected?: { element?: PPTElement; elementId?: string };
              };
              const failed = !!result.isError;
              const lastSeq = failed ? null : (details.lastSeq ?? before.lastSeq);
              let element = details.affected?.element;
              const id =
                element?.id ??
                details.affected?.elementId ??
                (raw as { elementId?: string })?.elementId;
              if (!failed && !element && id) {
                const state =
                  native.name === 'wb_delete' ? before : await opts.service.read(opts.stageId);
                element = state.whiteboard?.elements.find((candidate) => candidate.id === id);
              }
              opts.onExecution?.({
                name: native.name,
                callId,
                suppliedLastSeq: before.lastSeq,
                committedLastSeq: lastSeq,
              });
              // RuntimeStore has settled before waking the learning SSE. Notifications
              // are best effort, like the native projection; a lost wakeup is polled.
              if (!failed && lastSeq !== before.lastSeq) await opts.onWrite?.().catch(() => {});
              // Pi 0.80.3 ignores a returned result.isError. Throw so both the
              // durable tool event and the model's toolResult record a failure.
              if (failed) throw new PBLWhiteboardToolError(details.code ?? 'TOOL_REJECTED');
              let warnings: string[] = [];
              if (element && native.name.startsWith('wb_draw_')) {
                const after = await opts.service.read(opts.stageId);
                const width = after.whiteboard?.viewportSize ?? 1000;
                warnings = whiteboardLayoutWarnings(element, after.whiteboard?.elements ?? [], {
                  width,
                  height: width * (after.whiteboard?.viewportRatio ?? 0.5625),
                });
              }
              const compact = {
                ok: true,
                lastSeq,
                elements: element
                  ? [{ id, bounds: whiteboardElementExtent(element) }]
                  : id
                    ? [{ id }]
                    : [],
                ...(warnings.length ? { warnings } : {}),
              };
              return {
                content: [{ type: 'text' as const, text: JSON.stringify(compact) }],
                details: compact,
              };
            } catch (error) {
              signal?.throwIfAborted();
              if (error instanceof PBLWhiteboardToolError) throw error;
              throw new PBLWhiteboardToolError('WHITEBOARD_TOOL_FAILED');
            }
          }, signal),
        ),
    }));
}

export async function pblWhiteboardTail(service: WhiteboardRuntimeService, stageId: string) {
  const state = await service.read(stageId);
  const width = state.whiteboard?.viewportSize ?? 1000;
  return (
    CHILD_STATE_PREFIX +
    JSON.stringify({
      whiteboard: {
        status: 'ok',
        source: 'learner_runtime_store',
        stageId,
        sessionId: state.sessionId,
        boardId: state.whiteboard?.id ?? null,
        exists: state.lastSeq !== null,
        lastSeq: state.lastSeq,
        canvas: { width, height: width * (state.whiteboard?.viewportRatio ?? 0.5625) },
        elements: (state.whiteboard?.elements ?? []).map(summarizeChildElement),
        truncated: false,
      },
    })
  );
}
