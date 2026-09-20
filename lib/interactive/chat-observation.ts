import { isCoursewareReferenceEnabled } from '@/lib/config/feature-flags';
import { useWidgetIframeStore } from '@/lib/store/widget-iframe';
import {
  OBSERVATION_SCOPE_ID,
  freezeEvidence,
  supportsInteractiveObservation,
} from './observation';
import type { ObservationSnapshot } from './observation-bridge';

export interface InteractiveStateEvidence {
  sourceHtmlHash: string;
  snapshot: ObservationSnapshot;
}

/**
 * One awaited send-time sample of the current Scene's declared activity area.
 *
 * Sampling follows the Scene, not the draft reference: a follow-up question with
 * no reference still reports current facts, and sampling never creates, extends
 * or implies a component reference. No snapshot cache, no business-specific
 * collection, no tool permission.
 */
export async function sampleInteractiveState(
  storeState: { currentSceneId: string | null; scenes: unknown[] },
  signal: AbortSignal,
): Promise<InteractiveStateEvidence | undefined> {
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
  // The Host rejects any packet while the courseware-reference gate is off, so an
  // ungated sample would turn an ordinary Pi question into a 400.
  if (!isCoursewareReferenceEnabled()) return undefined;
  // An absent packet is explicitly unavailable at the Host; static identity still travels.
  if (!supportsInteractiveObservation()) return undefined;
  const sceneId = storeState.currentSceneId;
  if (!sceneId) return undefined;
  const scene = storeState.scenes.find(
    (value): value is { id: string; content: unknown } =>
      !!value &&
      typeof value === 'object' &&
      'id' in value &&
      value.id === sceneId &&
      'content' in value,
  );
  const content = scene?.content;
  if (
    !content ||
    typeof content !== 'object' ||
    !('html' in content) ||
    typeof content.html !== 'string'
  )
    return undefined;
  const sourceHtml = content.html;
  let hash: ArrayBuffer;
  try {
    hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(sourceHtml));
  } catch {
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    return undefined;
  }
  const sourceHtmlHash = Array.from(new Uint8Array(hash), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
  const unavailable = (reason: 'document-changed'): ObservationSnapshot => ({
    source: 'browser-reported',
    identity: { sceneId, scopeId: OBSERVATION_SCOPE_ID, documentId: 'unavailable' },
    requestedAt: Date.now(),
    receivedAt: Date.now(),
    status: 'unavailable',
    reason,
  });
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
  const capture = useWidgetIframeStore.getState().captureByScene[sceneId];
  const snapshot = (await capture?.(sourceHtml, signal)) ?? unavailable('document-changed');
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
  return freezeEvidence({ sourceHtmlHash, snapshot });
}
