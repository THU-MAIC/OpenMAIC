/**
 * "This browser just started or discarded a run": told to the page's other
 * tabs, so their course lists read the owner's runs now.
 *
 * A list with no run in progress holds no stream and reads the runs only now
 * and then (`OwnerRunsWatcher`), so a run started on the home page reached a
 * Pro workspace open beside it only at that next read — while the home page
 * showed its card at once. Another device still waits for that read; this tab
 * bus closes the gap for the tabs of one browser, which is where both lists
 * are open side by side.
 */
const CHANNEL = 'openmaic:generation-runs';

export function announceRunsChanged(): void {
  if (typeof BroadcastChannel === 'undefined') return;
  const channel = new BroadcastChannel(CHANNEL);
  channel.postMessage('changed');
  channel.close();
}

/** Call `onChange` whenever another tab announces a change; returns the unsubscribe. */
export function subscribeRunsChanged(onChange: () => void): () => void {
  if (typeof BroadcastChannel === 'undefined') return () => {};
  const channel = new BroadcastChannel(CHANNEL);
  channel.onmessage = () => onChange();
  return () => channel.close();
}
