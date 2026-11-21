import { sha256Hex } from '@/lib/legacy-browser-import/digest';

let ownerKeyPromise: Promise<string> | undefined;
let resolvedOwnerKey: string | undefined;
const listeners = new Set<() => void>();

export function knownDeviceOwnerKey(): string | undefined {
  return resolvedOwnerKey;
}

export function subscribeDeviceOwnerKey(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function setResolvedOwnerKey(key: string | undefined): void {
  if (resolvedOwnerKey === key) return;
  resolvedOwnerKey = key;
  for (const listener of listeners) listener();
}

/** The learner key can unlock an anonymous library. Only its digest is stored on this device. */
export function deviceOwnerKey(): Promise<string> {
  if (ownerKeyPromise) return ownerKeyPromise;
  const request = import('@/lib/persistence/bootstrap')
    .then(({ getPersistenceLearnerKey }) => getPersistenceLearnerKey())
    // Preserve the partition used by existing course thumbnails.
    .then((learnerKey) => sha256Hex(`course-thumbnail-owner:${learnerKey}`))
    .then((key) => {
      if (ownerKeyPromise === request) setResolvedOwnerKey(key);
      return key;
    })
    .catch((error: unknown) => {
      if (ownerKeyPromise === request) ownerKeyPromise = undefined;
      throw error;
    });
  ownerKeyPromise = request;
  return request;
}

export function forgetDeviceOwnerKey(): void {
  ownerKeyPromise = undefined;
  setResolvedOwnerKey(undefined);
}

if (typeof window !== 'undefined') {
  window.addEventListener?.('auth-change', forgetDeviceOwnerKey);
}
