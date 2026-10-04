/** How a provider's own options meet a request's (see {@link adapterOptions}). */
interface OptionsSource {
  /** The provider's non-secret options (openmaic.yml `options`). */
  options?: Record<string, string | number | boolean>;
  /** Where the connection came from: a configured slot, or the deprecated request path. */
  origin: 'configuration' | 'request' | 'default';
}

/**
 * The options a provider's adapter runs with: the connection's own (the
 * provider's `options` in openmaic.yml) and what
 * a request adds (a voice's prompt or reference, for instance). A configured
 * provider's options win over the request's; while the slot is unassigned
 * (the deprecated path) the request's win, as they always did.
 */
export function adapterOptions(
  connection: OptionsSource | null | undefined,
  request?: Record<string, unknown>,
): Record<string, unknown> {
  const own = connection?.options ?? {};
  return connection?.origin === 'configuration'
    ? { ...(request ?? {}), ...own }
    : { ...own, ...(request ?? {}) };
}
