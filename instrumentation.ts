/**
 * Next.js instrumentation hook.
 *
 * Runs once at server startup. We use it to eagerly load provider overrides
 * from the database so that the synchronous resolveApiKey / resolveBaseUrl
 * helpers return DB-overridden values from the very first request.
 *
 * Only runs in the Node.js runtime (not Edge).
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  try {
    const { ensureProviderOverridesLoaded } = await import('@/lib/server/provider-config');
    await ensureProviderOverridesLoaded();
  } catch (err) {
    // DB may not be reachable at boot time — resolvers will continue to use
    // YAML + env vars until the next cache invalidation.
    console.warn('[instrumentation] Could not pre-load provider overrides:', err);
  }
}
