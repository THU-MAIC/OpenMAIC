/**
 * The persistence-health channel (lib/store/persist-health.ts).
 *
 * This exists to say the one thing the user cannot otherwise notice: that their
 * changes have stopped being saved. Two properties make that actually reach
 * them, and both are about *when* an event is published rather than what it
 * says.
 *
 * Publishing is deferred a task, which does double duty: a recovery that lands
 * moments after the failure can cancel a warning nobody should have seen, and a
 * subscriber that mounts after the failure still gets caught up — but on a
 * later task, once the toast host beside it has mounted too. Delivered inline,
 * a catch-up raised during a component's own mount can land with nowhere to
 * display it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import {
  reportPersistHealth,
  reportPersistUnavailable,
  resetPersistHealth,
  subscribeToPersistHealth,
  type PersistHealthEvent,
} from '@/lib/store/persist-health';

const nextTask = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

beforeEach(() => resetPersistHealth());
afterEach(() => resetPersistHealth());

describe('persist-health — delivery', () => {
  it('publishes a failure to a subscriber that was already listening', async () => {
    const seen: PersistHealthEvent[] = [];
    subscribeToPersistHealth((event) => seen.push(event));

    reportPersistUnavailable('settings-storage');
    await nextTask();

    expect(seen).toEqual([{ name: 'settings-storage', status: 'unavailable' }]);
  });

  it('catches up a subscriber that arrives after the failure', async () => {
    // React mounts long after the store module runs, so the subscriber is
    // routinely late for the event that matters most.
    reportPersistUnavailable('settings-storage');
    await nextTask();

    const seen: PersistHealthEvent[] = [];
    subscribeToPersistHealth((event) => seen.push(event));
    await nextTask();

    expect(seen).toEqual([{ name: 'settings-storage', status: 'unavailable' }]);
  });

  it('does not deliver that catch-up during the subscribe call itself', async () => {
    // The distinguishing case for mount order: a component subscribing in its
    // own effect has not necessarily had its toast host mounted yet, so a
    // catch-up delivered inline can be raised into nothing.
    reportPersistUnavailable('settings-storage');
    await nextTask();

    const seenDuringSubscribe: PersistHealthEvent[] = [];
    subscribeToPersistHealth((event) => seenDuringSubscribe.push(event));

    expect(seenDuringSubscribe).toEqual([]);
    await nextTask();
    expect(seenDuringSubscribe).toHaveLength(1);
  });

  it('does not catch a subscriber up after it has unsubscribed', async () => {
    reportPersistUnavailable('settings-storage');
    await nextTask();

    const seen: PersistHealthEvent[] = [];
    const unsubscribe = subscribeToPersistHealth((event) => seen.push(event));
    unsubscribe();
    await nextTask();

    expect(seen).toEqual([]);
  });
});

describe('persist-health — recovery cancels a notice nobody needed', () => {
  it('publishes nothing when recovery lands before the warning is delivered', async () => {
    const seen: PersistHealthEvent[] = [];
    subscribeToPersistHealth((event) => seen.push(event));

    reportPersistUnavailable('settings-storage');
    reportPersistHealth('settings-storage', 'recovered');
    await nextTask();

    expect(seen).toEqual([]);
  });

  it('retracts a warning that was already delivered', async () => {
    const seen: PersistHealthEvent[] = [];
    subscribeToPersistHealth((event) => seen.push(event));

    reportPersistUnavailable('settings-storage');
    await nextTask();
    reportPersistHealth('settings-storage', 'recovered');
    await nextTask();

    expect(seen).toEqual([
      { name: 'settings-storage', status: 'unavailable' },
      { name: 'settings-storage', status: 'recovered' },
    ]);
  });

  it('says nothing about a key that was never in trouble', async () => {
    const seen: PersistHealthEvent[] = [];
    subscribeToPersistHealth((event) => seen.push(event));

    reportPersistHealth('settings-storage', 'recovered');
    await nextTask();

    expect(seen).toEqual([]);
  });

  it('does not catch a late subscriber up on a resolved problem', async () => {
    reportPersistUnavailable('settings-storage');
    await nextTask();
    reportPersistHealth('settings-storage', 'recovered');
    await nextTask();

    const seen: PersistHealthEvent[] = [];
    subscribeToPersistHealth((event) => seen.push(event));
    await nextTask();

    expect(seen).toEqual([]);
  });

  it('keeps a standing lost-changes notice for a late subscriber', async () => {
    // Unlike `unavailable`, this one does not resolve: the edits are gone.
    reportPersistHealth('settings-storage', 'changes-lost');
    await nextTask();

    const seen: PersistHealthEvent[] = [];
    subscribeToPersistHealth((event) => seen.push(event));
    await nextTask();

    expect(seen).toEqual([{ name: 'settings-storage', status: 'changes-lost' }]);
  });
});

describe('persist-health — repeated statuses', () => {
  it('publishes a repeated failure only once', async () => {
    const seen: PersistHealthEvent[] = [];
    subscribeToPersistHealth((event) => seen.push(event));

    reportPersistUnavailable('settings-storage');
    reportPersistUnavailable('settings-storage');
    await nextTask();
    reportPersistUnavailable('settings-storage');
    await nextTask();

    expect(seen).toHaveLength(1);
  });

  it('tracks keys independently', async () => {
    const seen: PersistHealthEvent[] = [];
    subscribeToPersistHealth((event) => seen.push(event));

    reportPersistUnavailable('settings-storage');
    reportPersistUnavailable('user-profile-storage');
    await nextTask();

    expect(seen.map((event) => event.name).sort()).toEqual([
      'settings-storage',
      'user-profile-storage',
    ]);
  });
});
