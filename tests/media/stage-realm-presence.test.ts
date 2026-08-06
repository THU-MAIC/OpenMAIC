import { afterEach, describe, expect, it } from 'vitest';
import {
  __resetStageRealmPresenceForTesting,
  bindStageRealmPresence,
  isStageOpenInAnotherRealm,
} from '@/lib/media/stage-realm-presence';

/**
 * A peer realm is modelled with its own channel: it answers presence probes the
 * way a second tab's bound module would.
 */
function peerHoldingStage(stageId: string): BroadcastChannel {
  const peer = new BroadcastChannel('maic-stage-presence');
  peer.onmessage = (event: MessageEvent) => {
    const message = event.data;
    if (message?.kind === 'probe' && message.stageId === stageId) {
      peer.postMessage({ kind: 'present', stageId, probeId: message.probeId });
    }
  };
  return peer;
}

describe('stage realm presence', () => {
  afterEach(() => __resetStageRealmPresenceForTesting());

  it('reports a peer that has the same stage open', async () => {
    bindStageRealmPresence(() => 'stage-1');
    const peer = peerHoldingStage('stage-1');

    try {
      expect(await isStageOpenInAnotherRealm('stage-1')).toBe(true);
    } finally {
      peer.close();
    }
  });

  it('reports no peer when the other realm holds a different stage', async () => {
    bindStageRealmPresence(() => 'stage-1');
    const peer = peerHoldingStage('stage-other');

    try {
      expect(await isStageOpenInAnotherRealm('stage-1')).toBe(false);
    } finally {
      peer.close();
    }
  });

  it('reports no peer when nobody answers', async () => {
    bindStageRealmPresence(() => 'stage-1');

    expect(await isStageOpenInAnotherRealm('stage-1')).toBe(false);
  });
});
