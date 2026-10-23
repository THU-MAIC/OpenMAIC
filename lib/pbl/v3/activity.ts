export const PBL_ACTIVITY_INTERVAL_MS = 30_000;

/** Report leading input promptly; retain later/failed input for the next eligible flush. */
export function createPblActivity(send: () => Promise<boolean>, changed: () => void) {
  let version = 0,
    acknowledged = 0,
    sending = false,
    nextReport = 0;
  const flush = async () => {
    if (sending || version === acknowledged || Date.now() < nextReport) return;
    sending = true;
    nextReport = Date.now() + PBL_ACTIVITY_INTERVAL_MS;
    const batch = version;
    try {
      if (await send()) acknowledged = batch;
    } catch {
      /* A failed batch stays pending for the next heartbeat. */
    } finally {
      sending = false;
    }
  };
  return {
    mark() {
      version++;
      changed();
      void flush();
    },
    flush,
  };
}
