import { it, expect, afterEach, beforeEach, vi } from 'vitest';
import { sampleInteractiveState } from '@/lib/interactive/chat-observation';
import { useWidgetIframeStore } from '@/lib/store/widget-iframe';
import type { ObservationSnapshot } from '@/lib/interactive/observation-bridge';

const source = '<main id="experiment"><script data-maic-observation></script></main>';
const legacy = '<main id="experiment">Default 1000</main>';
const store = { currentSceneId: 's', scenes: [{ id: 's', content: { html: source } }] };
const signal = () => new AbortController().signal;

function snapshot(value: number, sceneId = 's'): ObservationSnapshot {
  return {
    source: 'browser-reported',
    identity: { sceneId, scopeId: 'experiment', documentId: 'd' },
    requestedAt: 1,
    receivedAt: 2,
    status: 'available',
    observation: {
      summary: `The number is ${value}.`,
      state: { number: value },
    },
  };
}

const unavailable = (
  reason: ObservationSnapshot & { status: 'unavailable' } extends never
    ? never
    : 'not-ready' | 'scope-changed' | 'timeout' | 'cancelled',
): ObservationSnapshot => ({
  source: 'browser-reported',
  identity: { sceneId: 's', scopeId: 'experiment', documentId: 'd' },
  requestedAt: 1,
  receivedAt: 2,
  status: 'unavailable',
  reason,
});

function knownValue(packet: { snapshot: ObservationSnapshot } | undefined) {
  const current = packet?.snapshot;
  if (!current || current.status === 'unavailable') return undefined;
  return (current.observation as { state: { number: number } }).state.number;
}

const GATE = 'NEXT_PUBLIC_COURSEWARE_REFERENCE_ENABLED';
let previousGate: string | undefined;

beforeEach(() => {
  previousGate = process.env[GATE];
  // Sampling is part of the courseware-reference feature and follows its gate.
  process.env[GATE] = 'true';
});

afterEach(() => {
  if (previousGate === undefined) delete process.env[GATE];
  else process.env[GATE] = previousGate;
  useWidgetIframeStore.setState({ captureByScene: {} });
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it('does not sample while the courseware-reference gate is disabled', async () => {
  // Regression: an ungated packet made the Host reject an ordinary Pi question
  // with 400 even though Pi chat is independently enabled.
  delete process.env[GATE];
  let calls = 0;
  useWidgetIframeStore.getState().registerObservation('s', async () => {
    calls++;
    return snapshot(5);
  });
  expect(await sampleInteractiveState(store, signal())).toBeUndefined();
  expect(calls).toBe(0);
});

it('samples the current Scene on a send that carries no reference at all', async () => {
  let calls = 0;
  useWidgetIframeStore.getState().registerObservation('s', async (html) => {
    expect(html).toBe(source);
    calls++;
    return snapshot(7);
  });
  // No reference argument exists: sampling follows the Scene, not a draft selection.
  const packet = await sampleInteractiveState(store, signal());
  expect(calls).toBe(1);
  expect(knownValue(packet)).toBe(7);
  expect(packet?.snapshot.identity.scopeId).toBe('experiment');
  expect(Object.isFrozen(packet?.snapshot)).toBe(true);
});

it('re-samples on an unreferenced follow-up instead of reusing the first answer', async () => {
  const values = [10, 0];
  let call = 0;
  useWidgetIframeStore.getState().registerObservation('s', async () => snapshot(values[call++]));
  expect(knownValue(await sampleInteractiveState(store, signal()))).toBe(10);
  // Second send: still no reference, and the earlier value must not be reused.
  expect(knownValue(await sampleInteractiveState(store, signal()))).toBe(0);
  expect(call).toBe(2);
});

it('reports a later unknown sample as unknown rather than keeping the known value', async () => {
  const replies: ObservationSnapshot[] = [snapshot(4), unavailable('not-ready')];
  let call = 0;
  useWidgetIframeStore.getState().registerObservation('s', async () => replies[call++]);
  expect(knownValue(await sampleInteractiveState(store, signal()))).toBe(4);
  const second = await sampleInteractiveState(store, signal());
  expect(second?.snapshot).toMatchObject({ status: 'unavailable', reason: 'not-ready' });
  expect(knownValue(second)).toBeUndefined();
});

it('follows a scene switch and never answers with the previous scene', async () => {
  useWidgetIframeStore.getState().registerObservation('s', async () => snapshot(1));
  useWidgetIframeStore.getState().registerObservation('other', async () => snapshot(2, 'other'));
  const switched = {
    currentSceneId: 'other',
    scenes: [
      { id: 's', content: { html: source } },
      { id: 'other', content: { html: source } },
    ],
  };
  const packet = await sampleInteractiveState(switched, signal());
  expect(packet?.snapshot.identity.sceneId).toBe('other');
  expect(knownValue(packet)).toBe(2);
});

it('reports document-changed when the live document cannot answer after a reload', async () => {
  // A reloaded document drops its registration until the new session is created.
  const packet = await sampleInteractiveState(store, signal());
  expect(packet?.snapshot).toMatchObject({ status: 'unavailable', reason: 'document-changed' });
  expect(packet?.sourceHtmlHash).toHaveLength(64);
});

it('propagates cancellation instead of sending a half-collected sample', async () => {
  const controller = new AbortController();
  useWidgetIframeStore.getState().registerObservation('s', async () => {
    controller.abort();
    return snapshot(3);
  });
  await expect(sampleInteractiveState(store, controller.signal)).rejects.toMatchObject({
    name: 'AbortError',
  });
});

it('asks the reader on courseware without the interface and relays its own answer', async () => {
  // The reader is installed in every pooled document, so the source is no longer
  // pre-screened by a substring match: a page that declares no outlet says so
  // itself. Whether that answer becomes evidence is the Host's decision, pinned
  // by `element-reference-route-l2`, not this module's.
  let calls = 0;
  useWidgetIframeStore.getState().registerObservation('s', async () => {
    calls++;
    return { ...snapshot(9), status: 'unavailable' as const, reason: 'no-interface' as const };
  });
  const packet = await sampleInteractiveState(
    { currentSceneId: 's', scenes: [{ id: 's', content: { html: legacy } }] },
    signal(),
  );
  expect(packet?.snapshot).toMatchObject({ status: 'unavailable', reason: 'no-interface' });
  expect(calls).toBe(1);
});

it('omits runtime evidence when the browser rejects hashing', async () => {
  vi.stubGlobal('crypto', {
    ...globalThis.crypto,
    subtle: {
      digest: () => Promise.reject(new Error('insecure context')),
    },
    randomUUID: () => 'id',
  });
  expect(await sampleInteractiveState(store, signal())).toBeUndefined();
});
