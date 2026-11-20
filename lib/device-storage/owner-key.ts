import { sha256Hex } from '@/lib/legacy-browser-import/digest';

let ownerKeyPromise: Promise<string> | undefined;
let resolvedOwnerKey: string | undefined;

export function knownDeviceOwnerKey(): string | undefined {
  return resolvedOwnerKey;
}

/** The learner key can unlock an anonymous library. Only its digest is stored on this device. */
export function deviceOwnerKey(): Promise<string> {
  if (ownerKeyPromise) return ownerKeyPromise;
  const request = import('@/lib/persistence/bootstrap')
    .then(({ getPersistenceLearnerKey }) => getPersistenceLearnerKey())
    // Preserve the partition used by existing course thumbnails.
    .then((learnerKey) => sha256Hex(`course-thumbnail-owner:${learnerKey}`))
    .then((key) => {
      if (ownerKeyPromise === request) resolvedOwnerKey = key;
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
  resolvedOwnerKey = undefined;
}

if (typeof window !== 'undefined') {
  window.addEventListener?.('auth-change', forgetDeviceOwnerKey);
}
