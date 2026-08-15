export type ServiceWorkerRegistrationState =
  | 'unsupported'
  | 'disabled-in-development'
  | 'registered'
  | 'updated'
  | 'error';

export interface ServiceWorkerRegistrationResult {
  state: ServiceWorkerRegistrationState;
  registration?: ServiceWorkerRegistration;
  error?: unknown;
}

const OPENMAIC_SW_PATH = '/sw.js';
const OPENMAIC_CACHE_PREFIX = 'openmaic-pwa-';

function isOpenMaicRegistration(registration: ServiceWorkerRegistration): boolean {
  const scriptUrl =
    registration.active?.scriptURL ??
    registration.waiting?.scriptURL ??
    registration.installing?.scriptURL;
  if (!scriptUrl) return false;
  try {
    return new URL(scriptUrl, window.location.href).pathname === OPENMAIC_SW_PATH;
  } catch {
    return false;
  }
}

/** Register the application-shell worker only in a production browser build. */
export async function registerOpenMaicServiceWorker(): Promise<ServiceWorkerRegistrationResult> {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) {
    return { state: 'unsupported' };
  }

  if (process.env.NODE_ENV !== 'production') {
    await removeOpenMaicServiceWorker();
    return { state: 'disabled-in-development' };
  }

  try {
    const registration = await navigator.serviceWorker.register(OPENMAIC_SW_PATH, {
      scope: '/',
      updateViaCache: 'none',
    });

    registration.addEventListener('updatefound', () => {
      const installing = registration.installing;
      installing?.addEventListener('statechange', () => {
        if (installing.state === 'installed' && navigator.serviceWorker.controller) {
          window.dispatchEvent(new CustomEvent('openmaic:offline-update-ready'));
        }
      });
    });

    // Check for a newer worker on repeat visits without waiting for the browser's cadence.
    await registration.update().catch(() => undefined);
    return {
      state: registration.waiting ? 'updated' : 'registered',
      registration,
    };
  } catch (error) {
    return { state: 'error', error };
  }
}

/** Remove only OpenMAIC's worker and caches; unrelated workers are untouched. */
export async function removeOpenMaicServiceWorker(): Promise<void> {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return;

  const registrations = await navigator.serviceWorker.getRegistrations();
  await Promise.all(
    registrations.filter(isOpenMaicRegistration).map((registration) => registration.unregister()),
  );

  if ('caches' in window) {
    const names = await window.caches.keys();
    await Promise.all(
      names
        .filter((name) => name.startsWith(OPENMAIC_CACHE_PREFIX))
        .map((name) => window.caches.delete(name)),
    );
  }
}

export function activateWaitingServiceWorker(registration: ServiceWorkerRegistration): void {
  registration.waiting?.postMessage({ type: 'SKIP_WAITING' });
}

/** Ask the active worker to fetch full HTML for stable client-only routes. */
export function warmOpenMaicOfflinePages(paths: string[]): void {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator) || !navigator.onLine) return;
  const uniquePaths = [...new Set(paths.filter((path) => path.startsWith('/')))];
  if (!uniquePaths.length) return;

  const post = (worker: ServiceWorker | null) =>
    worker?.postMessage({ type: 'WARM_OFFLINE_PAGES', paths: uniquePaths });
  if (navigator.serviceWorker.controller) {
    post(navigator.serviceWorker.controller);
  } else {
    void navigator.serviceWorker.ready.then((registration) => post(registration.active));
  }
}
