import { injectIntoDocumentBodyEnd } from '../utils/html-document';
import {
  parseObservation,
  supportsInteractiveObservation,
  freezeEvidence,
  type ParsedObservation,
  type UnavailableReason,
} from './observation';

export interface ObservationIdentity {
  sceneId: string;
  scopeId: string;
  documentId: string;
}
export type ObservationSnapshot = ParsedObservation & {
  source: 'browser-reported';
  identity: ObservationIdentity;
  requestedAt: number;
  receivedAt: number;
};
const READ = 'maic:observation:read:v1';
const RESULT = 'maic:observation:result:v1';
const reasons = new Set<UnavailableReason>([
  'no-interface',
  'not-ready',
  'invalid-data',
  'too-large',
  'scope-changed',
  'document-changed',
  'timeout',
  'cancelled',
]);

/** Self-contained responder: safe to serialize into a sandbox without importing business code. */
export function installObservationResponder(identity: ObservationIdentity): () => void {
  const READ = 'maic:observation:read:v1';
  const RESULT = 'maic:observation:result:v1';
  const OBSERVATION_ATTRIBUTE = 'data-maic-observation';
  const OBSERVATION_MAX_BYTES = 32768;
  if (typeof globalThis.crypto?.randomUUID !== 'function') return () => {};
  const instanceId = crypto.randomUUID();
  // A lesson may create its scope after this shim runs. Bind on the first read
  // that finds one scope, then retain that identity to reject replacement.
  let root: Element | null = null;
  const receive = (event: MessageEvent) => {
    const d = event.data;
    if (
      event.source !== parent ||
      d?.type !== READ ||
      d.documentId !== identity.documentId ||
      d.sceneId !== identity.sceneId ||
      d.scopeId !== identity.scopeId ||
      typeof d.requestId !== 'string' ||
      d.requestId.length > 128
    )
      return;
    let raw: string | undefined;
    let reason: UnavailableReason | undefined;
    const currentRoots = document.querySelectorAll(`#${CSS.escape(identity.scopeId)}`);
    if (!root && currentRoots.length === 1) root = currentRoots[0];
    // Legacy documents never declared a scope; a removed/replaced scope is different.
    if (!root && currentRoots.length === 0) reason = 'no-interface';
    else if (
      !root?.isConnected ||
      currentRoots.length !== 1 ||
      document.getElementById(identity.scopeId) !== root
    )
      reason = 'scope-changed';
    else {
      const data = root.querySelectorAll(
        `script[type="application/json"][${OBSERVATION_ATTRIBUTE}]`,
      );
      if (!data.length) reason = 'no-interface';
      else if (data.length !== 1) reason = 'invalid-data';
      else {
        raw = data[0].textContent ?? '';
        if (!raw.trim()) {
          raw = undefined;
          reason = 'not-ready';
        } else if (
          raw.length > OBSERVATION_MAX_BYTES ||
          new TextEncoder().encode(raw).length > OBSERVATION_MAX_BYTES
        ) {
          raw = undefined;
          reason = 'too-large';
        }
      }
    }
    parent.postMessage(
      { type: RESULT, requestId: d.requestId, ...identity, instanceId, raw, reason },
      '*',
    );
  };
  let alive = true;
  const guardedReceive = (event: MessageEvent) => {
    if (alive) receive(event);
  };
  window.addEventListener(
    'pagehide',
    () => {
      alive = false;
      parent.postMessage({ type: 'maic:observation:invalidated:v1', ...identity }, '*');
    },
    { once: true },
  );
  window.addEventListener('message', guardedReceive);
  return () => window.removeEventListener('message', guardedReceive);
}

/** One scope/document per session. Owner disposes before navigation/replacement. No polling/cache. */
export function createObservationSession(iframe: HTMLIFrameElement, identity: ObservationIdentity) {
  let disposed = false;
  let instanceId: string | undefined;
  const pending = new Set<() => void>();
  const navigated = (event: MessageEvent) => {
    if (
      event.source === iframe.contentWindow &&
      event.data?.type === 'maic:observation:invalidated:v1' &&
      event.data.documentId === identity.documentId
    )
      dispose();
  };
  const dispose = () => {
    disposed = true;
    iframe.removeEventListener('load', dispose);
    window.removeEventListener('message', navigated);
    for (const cancel of [...pending]) cancel();
  };
  // Create the session AFTER the intended document's load event.
  iframe.addEventListener('load', dispose);
  window.addEventListener('message', navigated);
  return {
    dispose,
    isActive: () => !disposed && iframe.isConnected,
    capture({
      signal,
      timeoutMs = 800,
    }: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<ObservationSnapshot> {
      const requestedAt = Date.now();
      const context = {
        source: 'browser-reported' as const,
        identity: { ...identity },
        requestedAt,
      };
      const unavailable = (reason: UnavailableReason): ObservationSnapshot =>
        freezeEvidence({
          ...context,
          receivedAt: Date.now(),
          status: 'unavailable',
          reason,
        });
      if (disposed || !iframe.isConnected || !iframe.contentWindow)
        return Promise.resolve(unavailable('document-changed'));
      if (signal?.aborted) return Promise.resolve(unavailable('cancelled'));
      if (!supportsInteractiveObservation()) return Promise.resolve(unavailable('not-ready'));
      const source = iframe.contentWindow;
      const requestId = crypto.randomUUID();
      return new Promise((resolve) => {
        let settled = false;
        const finish = (data: ParsedObservation) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          window.removeEventListener('message', receive);
          signal?.removeEventListener('abort', abort);
          pending.delete(invalidate);
          // Teardown has already run, so nothing else can settle this promise.
          // A report that defeats the recursion in freezing must degrade here,
          // not leave a send waiting on a sample that never arrives.
          const receivedAt = Date.now();
          try {
            resolve(freezeEvidence({ ...context, receivedAt, ...data }));
          } catch {
            resolve(
              freezeEvidence({
                ...context,
                receivedAt,
                status: 'unavailable' as const,
                reason: 'invalid-data' as const,
              }),
            );
          }
        };
        const abort = () => finish({ status: 'unavailable', reason: 'cancelled' });
        const invalidate = () => finish({ status: 'unavailable', reason: 'document-changed' });
        const receive = (event: MessageEvent) => {
          const d = event.data;
          if (event.source !== source || d?.type !== RESULT || d.requestId !== requestId) return;
          if (disposed || !iframe.isConnected || iframe.contentWindow !== source)
            return invalidate();
          if (
            d.documentId !== identity.documentId ||
            d.scopeId !== identity.scopeId ||
            d.sceneId !== identity.sceneId
          )
            return finish({ status: 'unavailable', reason: 'invalid-data' });
          if (typeof d.instanceId !== 'string')
            return finish({ status: 'unavailable', reason: 'invalid-data' });
          if (instanceId && instanceId !== d.instanceId) return invalidate();
          instanceId = d.instanceId;
          if (d.reason && reasons.has(d.reason))
            return finish({ status: 'unavailable', reason: d.reason });
          finish(
            typeof d.raw === 'string'
              ? parseObservation(d.raw)
              : { status: 'unavailable', reason: 'invalid-data' },
          );
        };
        const timer = setTimeout(
          () => finish({ status: 'unavailable', reason: 'timeout' }),
          timeoutMs,
        );
        pending.add(invalidate);
        window.addEventListener('message', receive);
        signal?.addEventListener('abort', abort, { once: true });
        try {
          source.postMessage({ type: READ, requestId, ...identity }, '*');
        } catch {
          invalidate();
        }
      });
    },
  };
}

/**
 * Injects the reader shim. Called only by `patchHtmlForIframe`, alongside the
 * other iframe shims rather than through a second rewriting path, and without
 * sniffing for the attribute: a document that publishes no outlet answers
 * `no-interface`, which is authoritative where a substring match was a guess.
 *
 * Injection stays at body end. The scope is resolved lazily on reads, so pages
 * can create their activity later (for example, on DOMContentLoaded).
 */
export function withObservationResponder(html: string, identity: ObservationIdentity): string {
  const script =
    '<script data-maic-observation-reader>(' +
    installObservationResponder.toString() +
    ')(' +
    JSON.stringify(identity).replace(/</g, '\\u003c') +
    ');</script>';
  return injectIntoDocumentBodyEnd(html, script);
}
