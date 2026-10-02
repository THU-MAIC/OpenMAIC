/**
 * Settle the page's model settings on a view the server answered to a write
 * made elsewhere (the one-time import answers the view it produced).
 *
 * The client coalesces reads and applies whatever a read answers, so a read
 * started before that write (the page's first read, still in flight) could
 * land after it and put an older view back. So: first let any read in flight
 * finish (or read afresh), then keep whichever of the two views is newer by
 * revision. What the client itself should do, and then this helper would not
 * be needed: number its reads and drop an answer when a newer read or an
 * adopted view has superseded it (or when its revision is older than the
 * view it holds).
 */
import type { ModelSettingsClient, ModelSettingsView } from './client';

/** Whether `a` is older than `b` (no revision: nothing stored yet, the oldest). */
export function isOlderView(a: ModelSettingsView, b: ModelSettingsView): boolean {
  return (a.revision ?? -1) < (b.revision ?? -1);
}

export async function adoptNewerView(
  client: ModelSettingsClient,
  view: ModelSettingsView,
): Promise<void> {
  await client.load();
  const current = client.getState().view;
  if (!current || isOlderView(current, view)) client.adopt(view);
}
